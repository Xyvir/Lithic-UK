//! The engine: an iroh endpoint, a blob store, a gossip swarm and one
//! document per folder, wired together so a host can pair, read, publish
//! and follow updates.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use iroh::{endpoint::presets, Endpoint, EndpointAddr, EndpointId, SecretKey};
#[cfg(feature = "native")]
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::{api::Store as BlobsStore, store::mem::MemStore, BlobsProtocol, Hash};
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc, DocsApi,
    },
    engine::LiveEvent,
    protocol::Docs,
    store::Query,
    AuthorId, ContentStatus, Entry,
};
use iroh_gossip::net::Gossip;
use n0_future::{
    task::{spawn, AbortOnDropHandle},
    time::timeout,
    Stream, StreamExt,
};
use tokio::sync::{oneshot, Mutex};

#[cfg(feature = "native")]
use crate::folder::DiskFolder;
use crate::folder::{Folder, MemoryFolder};
use crate::{SyncEvent, Ticket, TicketMode};

/// The file holding the endpoint identity, under the state directory.
#[cfg(feature = "native")]
const IDENTITY_FILE: &str = "identity";
/// The file holding the ticket this device pairs with, under the state directory.
#[cfg(feature = "native")]
const TICKET_FILE: &str = "document.ticket";
/// How long a join waits for the first sync round before it seeds anyway.
const FIRST_SYNC_WAIT: Duration = Duration::from_secs(30);
/// How long a share waits for the home relay before minting its ticket. A
/// browser endpoint has no direct addresses, so a ticket is only dialable
/// once the relay is known; giving up keeps an offline share responsive.
const SHARE_RELAY_WAIT: Duration = Duration::from_secs(5);
/// Longest file name the folder will mirror, in bytes.
const MAX_NAME_BYTES: usize = 255;

type EventStream = Pin<Box<dyn Stream<Item = anyhow::Result<LiveEvent>> + Send>>;
type Subscriber = Arc<dyn Fn(SyncEvent) + Send + Sync>;

/// Where the endpoint finds its peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Network {
    /// The n0 relay and discovery services, so devices pair over the internet.
    #[default]
    Public,
    /// Direct addresses only, with no outside services. Good for tests and
    /// for two devices on the same network.
    Local,
}

/// Everything [`SyncEngine::start`] needs.
#[derive(Debug, Clone)]
pub struct Config {
    /// The folder that is mirrored into the document, for native prongs.
    pub dir: Option<PathBuf>,
    /// Where iroh keeps its durable state. `None` keeps it all in memory.
    pub state_dir: Option<PathBuf>,
    /// A fixed endpoint identity, for hosts that store it themselves.
    pub identity: Option<SecretKey>,
    /// Which services the endpoint may use.
    pub network: Network,
}

impl Config {
    /// A config for a folder, with an in-memory store and public networking.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: Some(dir.into()),
            state_dir: None,
            identity: None,
            network: Network::default(),
        }
    }

    /// A config with no folder at all: the browser prong, a host that syncs picked
    /// files rather than a directory (the desktop app today), and tests.
    pub fn memory() -> Self {
        Self {
            dir: None,
            state_dir: None,
            identity: None,
            network: Network::default(),
        }
    }

    /// Start from a fixed identity instead of one loaded from the state dir.
    pub fn identity(mut self, identity: SecretKey) -> Self {
        self.identity = Some(identity);
        self
    }

    /// Keep iroh's identity, replicas and blobs under this directory.
    pub fn state_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.state_dir = Some(dir.into());
        self
    }

    /// Choose a network preset.
    pub fn network(mut self, network: Network) -> Self {
        self.network = network;
        self
    }
}

/// A snapshot of what the engine is doing, for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// Whether this folder is paired with a document.
    pub paired: bool,
    /// What the device may do, once paired.
    pub mode: Option<TicketMode>,
    /// The document id, as hex.
    pub namespace: Option<String>,
    /// How many files the document holds.
    pub files: usize,
    /// How many sync peers are known for the document.
    pub peers: usize,
}

/// One file in the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// The file name, which is also the document key.
    pub name: String,
    /// The content size in bytes.
    pub size: u64,
    /// The content hash, as hex.
    pub hash: String,
    /// The device author that last wrote the entry, as hex.
    pub author: String,
    /// The entry timestamp, in microseconds since the Unix epoch.
    pub timestamp: u64,
}

/// One open document and its event pump.
struct Attached {
    doc: Doc,
    mode: TicketMode,
    namespace: String,
    pump: AbortOnDropHandle<()>,
}

/// The shared insides, so the engine can be cloned and the pump can hold it.
struct Inner {
    folder: Arc<dyn Folder>,
    #[cfg(feature = "native")]
    state_dir: Option<PathBuf>,
    network: Network,
    endpoint: Endpoint,
    blobs: BlobsStore,
    api: DocsApi,
    author: AuthorId,
    doc: Mutex<Option<Attached>>,
    subscribers: StdMutex<Vec<Subscriber>>,
    _router: iroh::protocol::Router,
    _docs: Docs,
}

/// The device sync engine for one folder.
#[derive(Clone)]
pub struct SyncEngine {
    inner: Arc<Inner>,
}

impl SyncEngine {
    /// Bind the endpoint, open the stores and resume a saved pairing.
    pub async fn start(config: Config) -> Result<Self> {
        #[cfg(feature = "native")]
        {
            if let Some(dir) = &config.dir {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("failed to create {}", dir.display()))?;
            }
            if let Some(state_dir) = &config.state_dir {
                std::fs::create_dir_all(state_dir)
                    .with_context(|| format!("failed to create {}", state_dir.display()))?;
            }
        }
        let secret = match config.identity {
            Some(identity) => identity,
            None => generate_or_load_identity(config.state_dir.as_deref())?,
        };
        let folder: Arc<dyn Folder> = match &config.dir {
            Some(dir) => {
                #[cfg(feature = "native")]
                {
                    Arc::new(DiskFolder::new(dir.clone()))
                }
                #[cfg(not(feature = "native"))]
                {
                    let _ = dir;
                    bail!("this build has no filesystem folder; use the in-memory config");
                }
            }
            None => Arc::new(MemoryFolder::new()),
        };
        let builder = match config.network {
            Network::Public => Endpoint::builder(presets::N0),
            Network::Local => Endpoint::builder(presets::Minimal),
        };
        let endpoint = builder
            .secret_key(secret)
            .bind()
            .await
            .context("failed to bind the iroh endpoint")?;
        let blobs = load_blobs(&config.state_dir).await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        #[cfg(feature = "native")]
        let docs = match &config.state_dir {
            Some(dir) => Docs::persistent(dir.clone()),
            None => Docs::memory(),
        };
        #[cfg(not(feature = "native"))]
        let docs = Docs::memory();
        let docs = docs
            .spawn(endpoint.clone(), blobs.clone(), gossip.clone())
            .await
            .context("failed to start the documents engine")?;
        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();
        let api = docs.api().clone();
        let author = api
            .author_default()
            .await
            .context("failed to load the document author")?;
        let engine = Self {
            inner: Arc::new(Inner {
                folder,
                #[cfg(feature = "native")]
                state_dir: config.state_dir,
                network: config.network,
                endpoint,
                blobs,
                api,
                author,
                doc: Mutex::new(None),
                subscribers: StdMutex::new(Vec::new()),
                _router: router,
                _docs: docs,
            }),
        };
        #[cfg(feature = "native")]
        if let Some(text) = read_saved_ticket(engine.inner.state_dir.as_deref())? {
            let ticket = text
                .parse::<Ticket>()
                .context("the saved pairing ticket is unreadable")?;
            // Resuming does not wait for the first sync round: the replica is already
            // on disk, so the publish rule has the entries it needs, and a start must
            // not hold a page for a peer that is asleep. A fresh join does wait.
            engine
                .join_inner(&ticket, false)
                .await
                .context("failed to resume the saved pairing")?;
        }
        Ok(engine)
    }

    /// The write ticket for this folder, creating the document on first use.
    pub async fn share(&self) -> Result<Ticket> {
        let existing = { self.inner.doc.lock().await.as_ref().map(|a| a.doc.clone()) };
        let doc = match existing {
            Some(doc) => doc,
            None => {
                let doc = self
                    .inner
                    .api
                    .create()
                    .await
                    .context("failed to create the folder document")?;
                self.attach(doc.clone(), TicketMode::Write, Vec::new(), false, None)
                    .await?;
                doc
            }
        };
        if self.inner.network == Network::Public {
            let _ = timeout(SHARE_RELAY_WAIT, self.inner.endpoint.online()).await;
        }
        let raw = doc
            .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
            .await
            .context("failed to make the write ticket")?;
        let ticket = Ticket::from_raw(raw);
        self.inner.persist_ticket(&ticket)?;
        Ok(ticket)
    }

    /// A read-only ticket for the archivist.
    pub async fn archive_ticket(&self) -> Result<Ticket> {
        let (doc, _) = self.current().await?;
        let raw = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await
            .context("failed to make the read-only ticket")?;
        Ok(Ticket::from_raw(raw))
    }

    /// Pair with another device, or rejoin a pairing already in progress.
    ///
    /// Waits for the first sync round before seeding, so a local folder cannot
    /// beat a newer entry the document already holds. [`SyncEngine::start`] uses
    /// the same path with the wait off when it resumes a saved pairing, because
    /// there the document's entries are already local.
    pub async fn join(&self, ticket: &Ticket) -> Result<()> {
        self.join_inner(ticket, true).await
    }

    async fn join_inner(&self, ticket: &Ticket, wait_for_sync: bool) -> Result<()> {
        let namespace = ticket.namespace();
        {
            let guard = self.inner.doc.lock().await;
            if let Some(attached) = guard.as_ref() {
                if attached.namespace != namespace {
                    bail!("this folder is already paired with a different document");
                }
            }
        }
        let peers: Vec<EndpointAddr> = ticket
            .nodes()
            .into_iter()
            .filter(|addr| addr.id != self.inner.endpoint.id())
            .collect();
        let wait_for_sync = wait_for_sync && !peers.is_empty();
        let doc = self
            .inner
            .api
            .import_namespace(ticket.capability())
            .await
            .context("failed to open the paired document")?;
        self.attach(doc, ticket.mode(), peers, wait_for_sync, Some(ticket))
            .await
    }

    /// Stop live syncing for this folder. The replica, the local files and
    /// the pairing all stay, so saves keep working while no peer is reachable.
    pub async fn leave(&self) -> Result<()> {
        let doc = {
            let guard = self.inner.doc.lock().await;
            guard.as_ref().map(|a| a.doc.clone())
        };
        let Some(doc) = doc else { return Ok(()) };
        doc.leave()
            .await
            .context("failed to stop syncing the document")?;
        Ok(())
    }

    /// Forget this device's pairing while keeping its local replica and files.
    pub async fn unpair(&self) -> Result<()> {
        let attached = self.inner.doc.lock().await.take();
        if let Some(attached) = attached {
            if let Err(error) = attached.doc.leave().await {
                self.inner.doc.lock().await.replace(attached);
                return Err(error).context("failed to stop syncing the document");
            }
            attached.pump.abort();
        }
        self.inner.clear_saved_ticket()?;
        Ok(())
    }

    /// Write a file and publish it. The file lands first, then the same
    /// bytes become the document entry.
    pub async fn publish(&self, name: &str, bytes: impl Into<Bytes>) -> Result<()> {
        if !is_safe_name(name) {
            bail!("{name:?} is not a usable file name");
        }
        let bytes = bytes.into();
        let (doc, mode) = self.current().await?;
        if mode != TicketMode::Write {
            bail!("this device holds a read-only ticket");
        }
        self.inner
            .folder
            .write(name, &bytes)
            .await
            .with_context(|| format!("failed to write {name}"))?;
        doc.set_bytes(self.inner.author, name.to_string(), bytes)
            .await
            .with_context(|| format!("failed to publish {name}"))?;
        Ok(())
    }

    /// The latest bytes the document holds for a file, if it holds any.
    pub async fn read(&self, name: &str) -> Result<Option<Bytes>> {
        let (doc, _) = self.current().await?;
        let entry = doc
            .get_one(Query::single_latest_per_key().key_exact(name))
            .await
            .with_context(|| format!("failed to look up {name}"))?;
        let Some(entry) = entry else { return Ok(None) };
        if entry.record().is_empty() {
            return Ok(None);
        }
        let bytes = self
            .inner
            .blobs
            .get_bytes(entry.content_hash())
            .await
            .map_err(|err| anyhow!("the content of {name} is not available yet: {err}"))?;
        Ok(Some(bytes))
    }

    /// Every file in the document, sorted by name.
    pub async fn entries(&self) -> Result<Vec<FileEntry>> {
        let (doc, _) = self.current().await?;
        let mut stream = Box::pin(
            doc.get_many(Query::single_latest_per_key())
                .await
                .context("failed to list the document")?,
        );
        let mut files = Vec::new();
        while let Some(entry) = stream.next().await {
            let entry: Entry = entry.context("failed to read a document entry")?;
            if entry.record().is_empty() {
                continue;
            }
            let Ok(name) = std::str::from_utf8(entry.key()) else {
                continue;
            };
            if !is_safe_name(name) {
                continue;
            }
            files.push(FileEntry {
                name: name.to_string(),
                size: entry.content_len(),
                hash: hex(entry.content_hash().as_bytes()),
                author: hex(entry.author().as_bytes()),
                timestamp: entry.timestamp(),
            });
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(files)
    }

    /// What the engine is doing right now.
    pub async fn status(&self) -> Result<Status> {
        let attached = {
            let guard = self.inner.doc.lock().await;
            guard
                .as_ref()
                .map(|a| (a.doc.clone(), a.mode, a.namespace.clone()))
        };
        let Some((doc, mode, namespace)) = attached else {
            return Ok(Status {
                paired: false,
                mode: None,
                namespace: None,
                files: 0,
                peers: 0,
            });
        };
        let files = self.entries().await?.len();
        let peers = doc
            .get_sync_peers()
            .await
            .context("failed to read the sync peers")?
            .map(|peers| peers.len())
            .unwrap_or(0);
        Ok(Status {
            paired: true,
            mode: Some(mode),
            namespace: Some(namespace),
            files,
            peers,
        })
    }

    /// The endpoint id of this device, as text.
    pub fn node_id(&self) -> String {
        self.inner.endpoint.id().to_string()
    }

    /// Follow the folder. The callback runs for every event until the engine
    /// is dropped.
    pub fn subscribe(&self, callback: impl Fn(SyncEvent) + Send + Sync + 'static) {
        self.inner
            .subscribers
            .lock()
            .unwrap()
            .push(Arc::new(callback));
    }

    /// Stop the engine and flush its stores. The router shuts the protocol
    /// handlers down, and the blobs handler in turn shuts the blob store down.
    pub async fn shutdown(&self) -> Result<()> {
        let attached = self.inner.doc.lock().await.take();
        if let Some(attached) = attached {
            attached.pump.abort();
        }
        self.inner
            ._router
            .shutdown()
            .await
            .context("failed to shut the router down")?;
        Ok(())
    }

    async fn current(&self) -> Result<(Doc, TicketMode)> {
        let guard = self.inner.doc.lock().await;
        let attached = guard.as_ref().context("no device sync pairing yet")?;
        Ok((attached.doc.clone(), attached.mode))
    }

    async fn attach(
        &self,
        doc: Doc,
        mode: TicketMode,
        peers: Vec<EndpointAddr>,
        wait_for_sync: bool,
        persist: Option<&Ticket>,
    ) -> Result<()> {
        let snapshot = self.inner.folder.snapshot().await?;
        let events: EventStream = Box::pin(
            doc.subscribe()
                .await
                .context("failed to subscribe to the document")?,
        );
        doc.start_sync(peers)
            .await
            .context("failed to start syncing the document")?;
        let (sync_tx, sync_rx) = oneshot::channel();
        let pump = self.inner.spawn_pump(doc.clone(), events, Some(sync_tx));
        let namespace = hex(doc.id().as_bytes());
        let previous = {
            self.inner.doc.lock().await.replace(Attached {
                doc: doc.clone(),
                mode,
                namespace,
                pump,
            })
        };
        if let Some(previous) = previous {
            previous.pump.abort();
        }
        if wait_for_sync {
            let _ = timeout(FIRST_SYNC_WAIT, sync_rx).await;
        }
        self.inner.reconcile(&doc, snapshot).await?;
        if let Some(ticket) = persist {
            self.inner.persist_ticket(ticket)?;
        }
        Ok(())
    }
}

impl Inner {
    fn spawn_pump(
        self: &Arc<Self>,
        doc: Doc,
        events: EventStream,
        sync_tx: Option<oneshot::Sender<()>>,
    ) -> AbortOnDropHandle<()> {
        let inner = Arc::clone(self);
        AbortOnDropHandle::new(spawn(async move { inner.run_pump(doc, events, sync_tx).await }))
    }

    async fn run_pump(
        &self,
        doc: Doc,
        mut events: EventStream,
        mut sync_tx: Option<oneshot::Sender<()>>,
    ) {
        let mut pending: HashMap<Hash, (Entry, EndpointId)> = HashMap::new();
        while let Some(event) = events.next().await {
            let event = match event {
                Ok(event) => event,
                Err(_) => continue,
            };
            match event {
                LiveEvent::InsertRemote {
                    entry,
                    from,
                    content_status,
                } => {
                    let hash = entry.content_hash();
                    let ready = matches!(content_status, ContentStatus::Complete);
                    pending.insert(hash, (entry, from));
                    if ready {
                        if let Some((entry, from)) = pending.remove(&hash) {
                            self.apply_remote(&doc, entry, from).await;
                        }
                    }
                }
                LiveEvent::ContentReady { hash } => {
                    if let Some((entry, from)) = pending.remove(&hash) {
                        self.apply_remote(&doc, entry, from).await;
                    }
                }
                LiveEvent::SyncFinished(_) => {
                    if let Some(tx) = sync_tx.take() {
                        let _ = tx.send(());
                    }
                }
                LiveEvent::NeighborUp(peer) => self.emit(SyncEvent::PeerUp(peer)),
                LiveEvent::NeighborDown(peer) => self.emit(SyncEvent::PeerDown(peer)),
                _ => {}
            }
        }
    }

    /// Write one received entry to the folder and report the base-to-head
    /// patch. The entry is never published again.
    async fn apply_remote(&self, doc: &Doc, entry: Entry, from: EndpointId) {
        let Some(name) = std::str::from_utf8(entry.key())
            .ok()
            .filter(|name| is_safe_name(name))
            .map(str::to_owned)
        else {
            return;
        };
        let hash = entry.content_hash();
        let latest = match doc
            .get_one(Query::single_latest_per_key().key_exact(entry.key()))
            .await
        {
            Ok(latest) => latest,
            Err(err) => {
                self.emit(SyncEvent::Failed {
                    name,
                    reason: format!("could not check the document: {err}"),
                });
                return;
            }
        };
        if latest.map(|latest| latest.content_hash()) != Some(hash) {
            return;
        }
        let head = match self.blobs.get_bytes(hash).await {
            Ok(head) => head,
            Err(err) => {
                self.emit(SyncEvent::Failed {
                    name,
                    reason: format!("could not read the update: {err}"),
                });
                return;
            }
        };
        let base = self.folder.read(&name).await.map(Bytes::from);
        if base.as_deref() == Some(head.as_ref()) {
            return;
        }
        match self.folder.write(&name, &head).await {
            Ok(()) => self.emit(SyncEvent::RemoteUpdate {
                name,
                base,
                head,
                at: entry.timestamp(),
                from,
            }),
            Err(err) => self.emit(SyncEvent::Failed {
                name,
                reason: format!("could not write the file: {err}"),
            }),
        }
    }

    /// Apply the publish rule at boot and on every join: seed only keys the
    /// document does not hold, and bring local drift forward from the document.
    async fn reconcile(&self, doc: &Doc, snapshot: Vec<(String, Vec<u8>)>) -> Result<()> {
        for (name, local) in snapshot {
            let entry = doc
                .get_one(Query::single_latest_per_key().key_exact(&name))
                .await
                .with_context(|| format!("failed to look up {name}"))?;
            match entry {
                None => {
                    doc.set_bytes(self.author, name.clone(), Bytes::from(local))
                        .await
                        .with_context(|| format!("failed to seed {name}"))?;
                    self.emit(SyncEvent::Seeded { name });
                }
                Some(entry) if !entry.record().is_empty() => {
                    let Ok(current) = self.blobs.get_bytes(entry.content_hash()).await else {
                        continue;
                    };
                    if current.as_ref() != local.as_slice() {
                        self.emit(SyncEvent::ExternalDrift { name: name.clone() });
                        if let Err(err) = self.folder.write(&name, &current).await {
                            self.emit(SyncEvent::Failed {
                                name,
                                reason: format!("could not bring the file forward: {err}"),
                            });
                        }
                    }
                }
                Some(_) => {}
            }
        }
        Ok(())
    }

    fn persist_ticket(&self, ticket: &Ticket) -> Result<()> {
        #[cfg(feature = "native")]
        if let Some(dir) = &self.state_dir {
            write_private(&dir.join(TICKET_FILE), &ticket.to_text())
                .context("failed to save the pairing ticket")?;
        }
        #[cfg(not(feature = "native"))]
        let _ = ticket;
        Ok(())
    }

    fn clear_saved_ticket(&self) -> Result<()> {
        #[cfg(feature = "native")]
        if let Some(dir) = &self.state_dir {
            match std::fs::remove_file(dir.join(TICKET_FILE)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("failed to forget the pairing ticket"),
            }
        }
        Ok(())
    }

    fn emit(&self, event: SyncEvent) {
        let subscribers = { self.subscribers.lock().unwrap().clone() };
        for callback in subscribers {
            callback(event.clone());
        }
    }

}

#[cfg(feature = "native")]
async fn load_blobs(state_dir: &Option<PathBuf>) -> Result<BlobsStore> {
    match state_dir {
        Some(dir) => {
            let store = FsStore::load(dir)
                .await
                .context("failed to open the blob store")?;
            Ok((*store).clone())
        }
        None => Ok((*MemStore::new()).clone()),
    }
}

#[cfg(not(feature = "native"))]
async fn load_blobs(_state_dir: &Option<PathBuf>) -> Result<BlobsStore> {
    Ok((*MemStore::new()).clone())
}

#[cfg(feature = "native")]
fn generate_or_load_identity(state_dir: Option<&Path>) -> Result<SecretKey> {
    let Some(dir) = state_dir else {
        return Ok(SecretKey::generate());
    };
    let path = dir.join(IDENTITY_FILE);
    if path.exists() {
        let text = std::fs::read_to_string(&path)
            .context("failed to read the saved iroh identity")?;
        let bytes = unhex(text.trim()).context("the saved iroh identity is unreadable")?;
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("the saved iroh identity must be 32 bytes"))?;
        Ok(SecretKey::from_bytes(&seed))
    } else {
        let key = SecretKey::generate();
        write_private(&path, &hex(&key.to_bytes()))
            .context("failed to save the iroh identity")?;
        Ok(key)
    }
}

#[cfg(not(feature = "native"))]
fn generate_or_load_identity(_state_dir: Option<&Path>) -> Result<SecretKey> {
    Ok(SecretKey::generate())
}

#[cfg(feature = "native")]
fn read_saved_ticket(state_dir: Option<&Path>) -> Result<Option<String>> {
    let Some(dir) = state_dir else {
        return Ok(None);
    };
    let path = dir.join(TICKET_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .context("failed to read the saved pairing ticket")?;
    Ok(Some(text))
}

#[cfg(feature = "native")]
fn write_private(path: &Path, text: &str) -> Result<()> {
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub(crate) fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && name != "."
        && name != ".."
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(feature = "native")]
fn unhex(text: &str) -> Result<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        bail!("hex text needs an even number of characters");
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let high = (bytes[index] as char)
            .to_digit(16)
            .context("hex text contains a non-hex character")?;
        let low = (bytes[index + 1] as char)
            .to_digit(16)
            .context("hex text contains a non-hex character")?;
        out.push((high * 16 + low) as u8);
        index += 2;
    }
    Ok(out)
}
