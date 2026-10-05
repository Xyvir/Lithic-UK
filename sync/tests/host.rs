//! The host layer: one engine per machine, started on demand, resumed from disk.
//!
//! What these pin is the part every native prong leans on and the browser does not have:
//! a machine that keeps its identity, its pairing and its copies under one folder, and a
//! start that neither happens before it is asked for nor holds a page for a peer.

use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use lithic_sync::{Host, Network, SyncEngine, SyncEvent, WireEvent};
use tempfile::TempDir;
use tokio::time::{sleep, timeout};

/// Wait until the engine can read a name back with these bytes.
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

#[tokio::test]
async fn the_engine_starts_on_the_first_ask_and_only_once() {
    let state = TempDir::new().expect("temp dir");
    let host = Host::new(state.path()).network(Network::Local);

    // A host is not a start: nothing has touched the state folder yet.
    assert!(!state.path().join("identity").exists());

    let first = host.engine().await.expect("the first ask should start the engine");
    let second = host.engine().await.expect("a second ask should answer with the same engine");
    assert_eq!(first.node_id(), second.node_id());

    // The identity is the machine's, kept where the next launch will find it.
    assert!(state.path().join("identity").exists());

    first.shutdown().await.expect("shutdown should work");
}

#[tokio::test]
async fn a_pairing_resumes_without_waiting_for_the_other_device() {
    let a_state = TempDir::new().expect("temp dir");
    let b_state = TempDir::new().expect("temp dir");

    let a = Host::new(a_state.path()).network(Network::Local);
    let a_engine = a.engine().await.expect("A should start");
    let ticket = a_engine.share().await.expect("A should hand out a ticket");
    a_engine
        .publish("notes.lith", &b"v1"[..])
        .await
        .expect("A should publish");

    let b = Host::new(b_state.path()).network(Network::Local);
    let b_engine = b.engine().await.expect("B should start");
    b_engine.join(&ticket).await.expect("B should pair with A");
    wait_read(&b_engine, "notes.lith", b"v1").await;

    // Both machines quit. The Lith is B's now: it came down into B's own store.
    b_engine.shutdown().await.expect("shutdown should work");
    drop(b_engine);
    drop(b);
    a_engine.shutdown().await.expect("shutdown should work");
    drop(a_engine);
    drop(a);

    // B boots again with nobody answering, and the start must not wait the first
    // sync round out: the replica is already on disk, so the pairing is attached
    // and the copy is readable with A asleep.
    let b = Host::new(b_state.path()).network(Network::Local);
    let resumed = timeout(Duration::from_secs(10), b.engine())
        .await
        .expect("a resume must not wait for a peer that is asleep")
        .expect("the resume should start");
    assert!(resumed.status().await.expect("status should work").paired);
    wait_read(&resumed, "notes.lith", b"v1").await;

    resumed.shutdown().await.expect("shutdown should work");
}

#[tokio::test]
async fn the_watcher_hears_updates_as_wire_events() {
    let a_state = TempDir::new().expect("temp dir");
    let b_state = TempDir::new().expect("temp dir");

    let seen: Arc<StdMutex<Vec<WireEvent>>> = Arc::new(StdMutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let a = Host::new(a_state.path())
        .network(Network::Local)
        .watching(move |event: SyncEvent| sink.lock().unwrap().push(WireEvent::from(&event)));
    let a_engine = a.engine().await.expect("A should start");
    let ticket = a_engine.share().await.expect("A should hand out a ticket");

    let b = Host::new(b_state.path()).network(Network::Local);
    let b_engine = b.engine().await.expect("B should start");
    b_engine.join(&ticket).await.expect("B should pair with A");
    a_engine
        .publish("notes.lith", &b"v1"[..])
        .await
        .expect("A should publish");
    wait_read(&b_engine, "notes.lith", b"v1").await;

    // B saves; A hears it through the listener the host registered before the start.
    b_engine
        .publish("notes.lith", &b"v2"[..])
        .await
        .expect("B should publish");
    wait_read(&a_engine, "notes.lith", b"v2").await;
    for _ in 0..600 {
        if seen.lock().unwrap().iter().any(|event| event.kind == "remote-update") {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }

    let events = seen.lock().unwrap().clone();
    let update = events
        .iter()
        .find(|event| event.kind == "remote-update")
        .expect("the update should have been heard");
    assert_eq!(update.name.as_deref(), Some("notes.lith"));
    assert_eq!(update.from.as_deref(), Some(b_engine.node_id().as_str()));
    assert!(update.reason.is_none());

    a_engine.shutdown().await.expect("shutdown should work");
    b_engine.shutdown().await.expect("shutdown should work");
}
