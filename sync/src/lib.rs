//! Device sync for a folder of Lith files, built on iroh documents.
//!
//! One document mirrors one folder, with one entry per file name. A write
//! ticket pairs a device for every file in the folder; a read-only ticket
//! lets an archivist follow along. The crate carries no toolkit or web
//! dependencies, so the desktop app, the Linux shim, the self-host server
//! and the browser can all share the same engine. With the `wasm` feature
//! the same code builds for `wasm32-unknown-unknown`, memory-only, behind
//! the [`BrowserEngine`] surface the launcher drives from JavaScript.
//!
//! Four rules keep a reload from beating a newer remote save:
//!
//! 1. Boot never publishes by itself. A local file seeds an entry only where
//!    the document has none, and where it has one the document wins.
//! 2. Only an explicit save publishes. The host writes the file first, then
//!    the same bytes become the entry.
//! 3. A received update is materialized and reported as the base-to-head
//!    patch for the history chain. It is never published again.
//! 4. The newest explicit save wins per file.
//!
//! The host drives the engine: [`SyncEngine::start`] binds the endpoint and
//! resumes a saved pairing, [`SyncEngine::share`] hands out the write ticket,
//! [`SyncEngine::join`] pairs with another device, and
//! [`SyncEngine::subscribe`] delivers updates as they land.

mod engine;
mod events;
mod folder;
#[cfg(feature = "native")]
mod host;
mod ticket;
#[cfg(feature = "wasm")]
mod wasm;

pub use engine::{Config, FileEntry, Network, Status, SyncEngine};
pub use events::{SyncEvent, WireEvent};
#[cfg(feature = "native")]
pub use host::Host;
pub use ticket::{Ticket, TicketMode};
#[cfg(feature = "wasm")]
pub use wasm::SyncEngine as BrowserEngine;
