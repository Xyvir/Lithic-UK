//! Device sync in the desktop app: the native prong behind the launcher's panel.
//!
//! The browser's engine is a wasm module the page fetches and starts itself, and the
//! desktop app cannot be that: a page the app serves has no wasm of its own to fetch
//! (`launcher.wasm` is in the bundle but nothing here loads it), and the design wants a
//! native prong's replica, blobs and identity on disk rather than in a session. So the
//! app links `lithic-sync` directly, hands it the app's own state folder, and drives it
//! over IPC through the same six calls and one event the browser glue exposes. The
//! launcher's driver picks the transport by mode, and the panel above it does not know
//! which one it is talking to.
//!
//! The state folder is the app's own (`platform::state_dir`), inside a `device-sync`
//! subfolder, for the same reason the vault has one: iroh writes several things of its
//! own (this machine's identity, the pairing ticket, the document replicas and the
//! blobs) and they belong beside the program rather than mixed into it. Everything in
//! it is the machine's, so a relaunch is the same device with the same pairing, and a
//! Lith that has arrived is still there with every other device asleep.
//!
//! What is deliberately not here yet: nothing is tied to a save or to a folder. The
//! panel's own pick is what publishes, exactly as in the browser, and the folder each
//! device mirrors is the next milestone. GitHub sync is untouched, so a standard build
//! still draws its circle beside this one until the quarantine pass lands.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use lithic_sync::{Host, SyncEngine, SyncEvent, Ticket, WireEvent};
use serde::Serialize;
use tauri::Emitter;

/// The event the page listens on for everything the folder does. One name, in one
/// place: the driver subscribes to it and the browser prong has no equivalent.
pub(crate) const EVENT: &str = "device-sync-event";

/// The app's device sync: one host, built when the app starts, asked to run by the first
/// command that needs it.
///
/// Everything in this module is `pub` because that is what `tauri::generate_handler!`
/// needs to name a command from the crate root; the module itself is private, so these
/// names are no part of any other crate's view.
pub struct DeviceSync {
    host: Option<Host>,
}

impl DeviceSync {
    /// Build the host over the app's own state folder, following the folder into one
    /// event the page can read.
    ///
    /// A machine whose state folder cannot be answered for gets no host, and every
    /// command says so in one sentence rather than pretending device sync works.
    pub fn new(handle: &tauri::AppHandle) -> Self {
        let emitter = handle.clone();
        Self {
            host: crate::platform::state_dir().map(|dir| {
                Host::new(dir.join("device-sync")).watching(move |event: SyncEvent| {
                    let _ = emitter.emit(EVENT, WireEvent::from(&event));
                })
            }),
        }
    }

    /// The running engine, started by this ask if nothing has asked yet.
    async fn engine(&self) -> Result<SyncEngine, String> {
        let host = self.host.as_ref().ok_or_else(|| {
            "this machine has no state folder for device sync to keep its identity in".to_string()
        })?;
        host.engine().await.map_err(display)
    }
}

/// What the page gets when it starts the engine: this device's node id.
#[derive(Serialize)]
pub struct DeviceSyncStarted {
    node_id: String,
}

/// Start the engine, or answer from the one already running.
#[tauri::command]
pub async fn device_sync_start(
    state: tauri::State<'_, DeviceSync>,
) -> Result<DeviceSyncStarted, String> {
    let engine = state.engine().await?;
    Ok(DeviceSyncStarted {
        node_id: engine.node_id(),
    })
}

/// This device's write ticket, minted the first time it is asked for.
#[tauri::command]
pub async fn device_sync_share(
    state: tauri::State<'_, DeviceSync>,
) -> Result<String, String> {
    let engine = state.engine().await?;
    engine
        .share()
        .await
        .map(|ticket| ticket.to_text())
        .map_err(display)
}

/// Pair with another device from its ticket.
#[tauri::command]
pub async fn device_sync_join(
    state: tauri::State<'_, DeviceSync>,
    ticket: String,
) -> Result<(), String> {
    let engine = state.engine().await?;
    let ticket = ticket.parse::<Ticket>().map_err(display)?;
    engine.join(&ticket).await.map_err(display)
}

/// Whether this device has a pairing and how many peers are live.
#[derive(Serialize)]
pub struct DeviceSyncStatus {
    paired: bool,
    peers: usize,
}

/// Current pairing state, including a pairing restored from disk at app startup.
#[tauri::command]
pub async fn device_sync_status(
    state: tauri::State<'_, DeviceSync>,
) -> Result<DeviceSyncStatus, String> {
    let engine = state.engine().await?;
    let status = engine.status().await.map_err(display)?;
    Ok(DeviceSyncStatus { paired: status.paired, peers: status.peers })
}

/// Forget this device's pairing without deleting its local files or replica.
#[tauri::command]
pub async fn device_sync_unpair(
    state: tauri::State<'_, DeviceSync>,
) -> Result<(), String> {
    let engine = state.engine().await?;
    engine.unpair().await.map_err(display)
}

/// One file in the folder, spelled exactly as the browser glue spells it.
#[derive(Serialize)]
pub struct DeviceSyncEntry {
    name: String,
    size: u64,
    hash: String,
    author: String,
    timestamp: u64,
}

/// Every file the folder holds right now.
#[tauri::command]
pub async fn device_sync_entries(
    state: tauri::State<'_, DeviceSync>,
) -> Result<Vec<DeviceSyncEntry>, String> {
    let engine = state.engine().await?;
    let entries = engine.entries().await.map_err(display)?;
    Ok(entries
        .into_iter()
        .map(|entry| DeviceSyncEntry {
            name: entry.name,
            size: entry.size,
            hash: entry.hash,
            author: entry.author,
            timestamp: entry.timestamp,
        })
        .collect())
}

/// The folder's bytes for one name. Base64, because the IPC carries JSON; the driver
/// decodes it into the same `Uint8Array` the browser's engine answers with.
#[tauri::command]
pub async fn device_sync_read(
    state: tauri::State<'_, DeviceSync>,
    name: String,
) -> Result<Option<String>, String> {
    let engine = state.engine().await?;
    let bytes = engine.read(&name).await.map_err(display)?;
    Ok(bytes.map(|bytes| STANDARD.encode(&bytes)))
}

/// Write a name and publish it. The bytes arrive base64 for the same reason.
#[tauri::command]
pub async fn device_sync_publish(
    state: tauri::State<'_, DeviceSync>,
    name: String,
    bytes: String,
) -> Result<(), String> {
    let engine = state.engine().await?;
    let bytes = STANDARD
        .decode(bytes.as_bytes())
        .map_err(|error| format!("the bytes are not base64: {error}"))?;
    engine.publish(&name, bytes).await.map_err(display)
}

/// An engine failure as the one sentence the page shows: anyhow's chain, flattened.
fn display(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}
