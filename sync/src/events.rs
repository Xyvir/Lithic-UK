//! What the engine tells the host while it runs.

use bytes::Bytes;
use iroh::EndpointId;

use serde::Serialize;

/// One thing that happened to the synced folder.
///
/// The host applies [`SyncEvent::RemoteUpdate`] to its history chain as a
/// base-to-head patch, and uses the rest to keep the UI honest.
#[derive(Debug, Clone)]
pub enum SyncEvent {
    /// A file arrived from another device. `base` is what the local file
    /// held before the update, and `head` is what it holds now.
    RemoteUpdate {
        /// The file name, which is also the document key.
        name: String,
        /// The previous local bytes, when there were any.
        base: Option<Bytes>,
        /// The bytes the document now holds.
        head: Bytes,
        /// The device the update came from.
        from: EndpointId,
    },
    /// A local file was new to the document and became its first entry.
    Seeded {
        /// The file name, which is also the document key.
        name: String,
    },
    /// The document held a newer entry than the local file at boot, so the
    /// document won and the local copy was brought forward as drift.
    ExternalDrift {
        /// The file name, which is also the document key.
        name: String,
    },
    /// A device joined the sync swarm.
    PeerUp(EndpointId),
    /// A device left the sync swarm.
    PeerDown(EndpointId),
    /// An update could not be written to the folder.
    Failed {
        /// The file name the engine tried to write.
        name: String,
        /// A plain sentence describing the failure.
        reason: String,
    },
}

/// One event as the plain object a host hands its page.
///
/// The browser's wasm glue builds this same shape by hand, because wasm-bindgen has
/// no serde, and every native host serializes this one instead, so the launcher decodes
/// one vocabulary whichever prong is running.
///
/// A [`SyncEvent::RemoteUpdate`]'s base-to-head bytes are deliberately not on it: no
/// host consumes the patch yet, and an event carrying a whole Lith is a copy nobody
/// asked for. A host that needs those bytes reads the entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WireEvent {
    /// Which event this is: `remote-update`, `seeded`, `external-drift`, `peer-up`,
    /// `peer-down` or `failed`.
    pub kind: &'static str,
    /// The file the event is about, when it is about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The device the event came from or is about, as its node id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// A failure's plain sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<&SyncEvent> for WireEvent {
    fn from(event: &SyncEvent) -> Self {
        match event {
            SyncEvent::RemoteUpdate { name, from, .. } => Self {
                kind: "remote-update",
                name: Some(name.clone()),
                from: Some(from.to_string()),
                reason: None,
            },
            SyncEvent::Seeded { name } => Self {
                kind: "seeded",
                name: Some(name.clone()),
                from: None,
                reason: None,
            },
            SyncEvent::ExternalDrift { name } => Self {
                kind: "external-drift",
                name: Some(name.clone()),
                from: None,
                reason: None,
            },
            SyncEvent::PeerUp(peer) => Self {
                kind: "peer-up",
                name: None,
                from: Some(peer.to_string()),
                reason: None,
            },
            SyncEvent::PeerDown(peer) => Self {
                kind: "peer-down",
                name: None,
                from: Some(peer.to_string()),
                reason: None,
            },
            SyncEvent::Failed { name, reason } => Self {
                kind: "failed",
                name: Some(name.clone()),
                from: None,
                reason: Some(reason.clone()),
            },
        }
    }
}
