//! What the engine tells the host while it runs.

use bytes::Bytes;
use iroh::EndpointId;

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
