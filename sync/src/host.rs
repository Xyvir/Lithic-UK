//! One machine's device sync: the engine, started on demand.
//!
//! This is what a native prong actually holds. The desktop app keeps one host under its
//! own state folder, the shim and the self-host server will keep one each, and the
//! browser has no use for it at all: there the page starts the engine itself, memory-only,
//! because the launcher's own store is the durable copy.
//!
//! Two facts are why this is a type rather than a call. The engine binds an endpoint and
//! opens stores when it starts, so a machine whose owner never opens device sync must pay
//! nothing: nothing happens until the first ask, and two asks that arrive together are one
//! start. And a host that has been asked to follow the folder registers its listener as
//! part of that start, so the engine it hands out already has one and a second ask cannot
//! subscribe twice.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use tokio::sync::Mutex;

use crate::{Config, Network, SyncEngine, SyncEvent};

/// One listener for the engine's events.
type Watcher = Arc<dyn Fn(SyncEvent) + Send + Sync>;

/// One machine's device sync, under its own state folder.
///
/// The folder is where iroh keeps everything it must remember: the endpoint identity, the
/// pairing ticket, the document replicas and the blobs. A host built on the same folder
/// again is the same device, paired with the same peers, holding the same entries.
pub struct Host {
    state_dir: PathBuf,
    network: Network,
    watcher: StdMutex<Option<Watcher>>,
    engine: Mutex<Option<SyncEngine>>,
}

impl Host {
    /// A host that keeps its identity, pairing and replicas under this folder.
    ///
    /// The host is the one thing every native prong agrees on, and a folder names the
    /// device: two hosts on one folder would be two devices with one identity.
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        Self {
            state_dir: state_dir.into(),
            network: Network::default(),
            watcher: StdMutex::new(None),
            engine: Mutex::new(None),
        }
    }

    /// Choose a network preset. The public one unless a test says otherwise.
    pub fn network(mut self, network: Network) -> Self {
        self.network = network;
        self
    }

    /// Follow the folder: register the listener the engine gets when it first starts.
    ///
    /// Registered before anything starts rather than after, because the engine cannot be
    /// asked to stop following a folder, so a listener added later would be a second one.
    pub fn watching(self, callback: impl Fn(SyncEvent) + Send + Sync + 'static) -> Self {
        *self.watcher.lock().unwrap() = Some(Arc::new(callback));
        self
    }

    /// The engine, started if it is not running yet. Two asks are one start.
    ///
    /// The start resumes the saved pairing, so an engine handed out after a relaunch is
    /// already attached to its document and answers `status`/`entries` from the replica
    /// on disk, whether or not any other device is awake.
    pub async fn engine(&self) -> Result<SyncEngine> {
        let mut guard = self.engine.lock().await;
        if let Some(engine) = guard.as_ref() {
            return Ok(engine.clone());
        }
        let config = Config::memory()
            .state_dir(self.state_dir.clone())
            .network(self.network);
        let engine = SyncEngine::start(config).await?;
        if let Some(watcher) = self.watcher.lock().unwrap().clone() {
            engine.subscribe(move |event| watcher(event));
        }
        *guard = Some(engine.clone());
        Ok(engine)
    }
}
