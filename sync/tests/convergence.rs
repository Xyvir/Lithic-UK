//! Two endpoints in one process prove the publish rule end to end.
//!
//! Each case is one of the four rules from the settled design:
//!
//! 1. A stale boot seeds only missing entries and never beats a newer save.
//! 2. An explicit save publishes.
//! 3. A received update lands as a patch and is never republished.
//! 4. An offline save converges once the device reconnects.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use bytes::Bytes;
use lithic_sync::{Config, FileEntry, Network, SyncEngine, SyncEvent, Ticket, TicketMode};
use tempfile::TempDir;
use tokio::time::sleep;

struct Pair {
    a_dir: TempDir,
    b_dir: TempDir,
    a: SyncEngine,
    b: SyncEngine,
    ticket: Ticket,
}

async fn engine(dir: &Path) -> SyncEngine {
    SyncEngine::start(Config::new(dir).network(Network::Local))
        .await
        .expect("the engine should start")
}

async fn pair() -> Pair {
    let a_dir = TempDir::new().expect("temp dir");
    let b_dir = TempDir::new().expect("temp dir");
    let a = engine(a_dir.path()).await;
    let ticket = a.share().await.expect("share should hand out a write ticket");
    assert_eq!(ticket.mode(), TicketMode::Write);
    let b = engine(b_dir.path()).await;
    b.join(&ticket)
        .await
        .expect("join should pair the second device");
    Pair {
        a_dir,
        b_dir,
        a,
        b,
        ticket,
    }
}

async fn wait_read(engine: &SyncEngine, name: &str, want: &[u8]) {
    for _ in 0..600 {
        if let Ok(Some(bytes)) = engine.read(name).await {
            if bytes.as_ref() == want {
                return;
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {name} to read back");
}

async fn wait_file(dir: &Path, name: &str, want: &[u8]) {
    for _ in 0..600 {
        if let Ok(bytes) = std::fs::read(dir.join(name)) {
            if bytes == want {
                return;
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {name} to land on disk");
}

async fn latest(engine: &SyncEngine, name: &str) -> FileEntry {
    engine
        .entries()
        .await
        .expect("entries should list")
        .into_iter()
        .find(|entry| entry.name == name)
        .expect("the entry should exist")
}

fn watch(engine: &SyncEngine) -> Arc<Mutex<Vec<SyncEvent>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    engine.subscribe(move |event| sink.lock().unwrap().push(event));
    seen
}

fn has(events: &Arc<Mutex<Vec<SyncEvent>>>, check: impl Fn(&SyncEvent) -> bool) -> bool {
    events.lock().unwrap().iter().any(check)
}

#[tokio::test]
async fn stale_boot_seeds_only_missing_entries() {
    let a_dir = TempDir::new().expect("temp dir");
    let b_dir = TempDir::new().expect("temp dir");
    let a = engine(a_dir.path()).await;
    let ticket = a.share().await.expect("share should hand out a write ticket");
    a.publish("notes.lith", &b"v2"[..])
        .await
        .expect("publish should work");
    let keeper = latest(&a, "notes.lith").await;

    // B boots with a stale copy of a file the document knows, and one file
    // the document has never seen.
    std::fs::write(b_dir.path().join("notes.lith"), b"v1").expect("write stale file");
    std::fs::write(b_dir.path().join("fresh.lith"), b"brand new").expect("write new file");

    let b = engine(b_dir.path()).await;
    let events = watch(&b);
    b.join(&ticket).await.expect("join should pair the device");

    // The document's newer save stands, and B's copy is brought forward.
    wait_read(&b, "notes.lith", b"v2").await;
    wait_file(b_dir.path(), "notes.lith", b"v2").await;
    assert_eq!(latest(&b, "notes.lith").await, keeper);

    // The file the document never had became its first entry.
    wait_read(&a, "fresh.lith", b"brand new").await;
    assert!(has(&events, |event| matches!(
        event,
        SyncEvent::Seeded { name } if name == "fresh.lith"
    )));
    assert!(has(&events, |event| matches!(
        event,
        SyncEvent::ExternalDrift { name } if name == "notes.lith"
    )));
}

#[tokio::test]
async fn explicit_save_publishes() {
    let p = pair().await;
    p.a.publish("notes.lith", &b"v1"[..])
        .await
        .expect("publish should work");
    wait_read(&p.b, "notes.lith", b"v1").await;

    p.b.publish("notes.lith", &b"v2"[..])
        .await
        .expect("publish should work");
    wait_read(&p.a, "notes.lith", b"v2").await;
    wait_file(p.a_dir.path(), "notes.lith", b"v2").await;

    let entry = latest(&p.b, "notes.lith").await;
    assert_eq!(latest(&p.a, "notes.lith").await, entry);
    assert_eq!(entry.size, 2);
}

#[tokio::test]
async fn received_update_applies_as_patch_without_republishing() {
    let p = pair().await;
    p.a.publish("notes.lith", &b"v1"[..])
        .await
        .expect("publish should work");
    wait_read(&p.b, "notes.lith", b"v1").await;

    type Patch = (String, Option<Bytes>, Bytes);
    let history: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&history);
    p.b.subscribe(move |event| {
        if let SyncEvent::RemoteUpdate {
            name, base, head, ..
        } = event
        {
            sink.lock().unwrap().push((name, base, head));
        }
    });
    let events = watch(&p.b);

    p.a.publish("notes.lith", &b"v2"[..])
        .await
        .expect("publish should work");
    let keeper = latest(&p.a, "notes.lith").await;

    wait_read(&p.b, "notes.lith", b"v2").await;
    wait_file(p.b_dir.path(), "notes.lith", b"v2").await;
    for _ in 0..600 {
        if !history.lock().unwrap().is_empty() {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }

    // The update was applied as one base-to-head patch.
    let patches = history.lock().unwrap().clone();
    assert_eq!(patches.len(), 1);
    assert_eq!(patches[0].0, "notes.lith");
    assert_eq!(patches[0].1.as_deref(), Some(&b"v1"[..]));
    assert_eq!(patches[0].2, Bytes::from_static(b"v2"));

    // Never republished: the newest entry is still the one A wrote.
    assert_eq!(latest(&p.b, "notes.lith").await, keeper);
    assert!(!has(&events, |event| matches!(
        event,
        SyncEvent::Seeded { .. }
    )));
    assert!(!has(&events, |event| matches!(
        event,
        SyncEvent::Failed { .. }
    )));
}

#[tokio::test]
async fn a_restart_resumes_the_pairing() {
    let a_dir = TempDir::new().expect("temp dir");
    let a_state = TempDir::new().expect("temp dir");
    let b_dir = TempDir::new().expect("temp dir");
    let b_state = TempDir::new().expect("temp dir");

    let a = SyncEngine::start(
        Config::new(a_dir.path())
            .state_dir(a_state.path())
            .network(Network::Local),
    )
    .await
    .expect("the engine should start");
    let ticket = a.share().await.expect("share should hand out a write ticket");
    let b = SyncEngine::start(
        Config::new(b_dir.path())
            .state_dir(b_state.path())
            .network(Network::Local),
    )
    .await
    .expect("the engine should start");
    b.join(&ticket).await.expect("join should pair the device");
    a.publish("notes.lith", &b"v1"[..])
        .await
        .expect("publish should work");
    wait_read(&b, "notes.lith", b"v1").await;
    wait_file(b_dir.path(), "notes.lith", b"v1").await;
    let status = b.status().await.expect("status should work");
    assert!(status.paired);
    assert_eq!(status.files, 1);

    // The device quits, the other side saves again, and the next boot catches up.
    b.shutdown().await.expect("shutdown should work");
    drop(b);
    a.publish("notes.lith", &b"v2"[..])
        .await
        .expect("publish should work");

    let b = SyncEngine::start(
        Config::new(b_dir.path())
            .state_dir(b_state.path())
            .network(Network::Local),
    )
    .await
    .expect("the engine should restart");
    assert!(b.status().await.expect("status should work").paired);
    wait_read(&b, "notes.lith", b"v2").await;
    wait_file(b_dir.path(), "notes.lith", b"v2").await;
    assert_eq!(
        latest(&a, "notes.lith").await,
        latest(&b, "notes.lith").await
    );
}

#[tokio::test]
async fn offline_save_converges_after_reconnect() {
    let p = pair().await;
    p.a.publish("notes.lith", &b"v1"[..])
        .await
        .expect("publish should work");
    wait_read(&p.b, "notes.lith", b"v1").await;

    // The device goes offline, then saves a newer version.
    p.b.leave().await.expect("leave should stop syncing");
    p.b.publish("notes.lith", &b"v2"[..])
        .await
        .expect("an offline save should work");
    assert_eq!(
        p.a.read("notes.lith").await.unwrap().as_deref(),
        Some(&b"v1"[..])
    );

    // The device comes back, and both sides converge on the newer save.
    p.b.join(&p.ticket).await.expect("rejoin should work");
    wait_read(&p.a, "notes.lith", b"v2").await;
    wait_file(p.a_dir.path(), "notes.lith", b"v2").await;
    wait_file(p.b_dir.path(), "notes.lith", b"v2").await;
    assert_eq!(
        latest(&p.a, "notes.lith").await,
        latest(&p.b, "notes.lith").await
    );
}
