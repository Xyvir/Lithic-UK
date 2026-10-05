//! The wasm surface the launcher drives from JavaScript.
//!
//! The browser keeps no filesystem: the engine runs memory-only, and the
//! launcher's own store stays the durable copy. Each method maps onto the
//! engine's native surface, with plain JavaScript values at the edge.

use std::cell::RefCell;

use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::{Config, Network, SyncEngine as Engine, SyncEvent};

thread_local! {
    /// The JS callbacks, kept per browser thread. The engine's subscriber
    /// closure only captures an index, so it stays `Send` and `Sync` even
    /// though `js_sys` values are neither.
    static CALLBACKS: RefCell<Vec<Function>> = RefCell::new(Vec::new());
}

/// A paired folder, driven from JavaScript.
#[wasm_bindgen]
pub struct SyncEngine {
    engine: Engine,
}

#[wasm_bindgen]
impl SyncEngine {
    /// Start the engine with a fixed 32 byte identity seed.
    pub async fn start(identity: Vec<u8>) -> Result<SyncEngine, JsError> {
        let seed: [u8; 32] = identity
            .as_slice()
            .try_into()
            .map_err(|_| JsError::new("the identity seed must be 32 bytes"))?;
        let config = Config::memory()
            .identity(iroh::SecretKey::from_bytes(&seed))
            .network(Network::Public);
        let engine = Engine::start(config).await.map_err(to_js_error)?;
        Ok(SyncEngine { engine })
    }

    /// This device's endpoint id, stable for a given seed.
    pub fn node_id(&self) -> String {
        self.engine.node_id()
    }

    /// The write ticket for this folder, creating the document on first use.
    pub async fn share(&self) -> Result<String, JsError> {
        self.engine
            .share()
            .await
            .map(|ticket| ticket.to_text())
            .map_err(to_js_error)
    }

    /// Pair with another device from its ticket.
    pub async fn join(&self, ticket: &str) -> Result<(), JsError> {
        let ticket = ticket.parse::<crate::Ticket>().map_err(to_js_error)?;
        self.engine.join(&ticket).await.map_err(to_js_error)
    }

    /// Every file in the document, as plain objects.
    pub async fn entries(&self) -> Result<Array, JsError> {
        let entries = self.engine.entries().await.map_err(to_js_error)?;
        let array = Array::new();
        for entry in entries {
            let object = Object::new();
            set(&object, "name", &JsValue::from_str(&entry.name));
            set(&object, "size", &JsValue::from_f64(entry.size as f64));
            set(&object, "hash", &JsValue::from_str(&entry.hash));
            set(&object, "author", &JsValue::from_str(&entry.author));
            set(&object, "timestamp", &JsValue::from_f64(entry.timestamp as f64));
            array.push(&JsValue::from(object));
        }
        Ok(array)
    }

    /// The latest bytes the document holds for a file, if it holds any.
    pub async fn read(&self, name: &str) -> Result<Option<Box<[u8]>>, JsError> {
        self.engine
            .read(name)
            .await
            .map(|bytes| bytes.map(|bytes| bytes.to_vec().into_boxed_slice()))
            .map_err(to_js_error)
    }

    /// Write a file and publish it.
    pub async fn publish(&self, name: &str, bytes: Vec<u8>) -> Result<(), JsError> {
        self.engine.publish(name, bytes).await.map_err(to_js_error)
    }

    /// Follow the folder; the callback receives one plain object per event.
    pub fn subscribe(&self, callback: Function) {
        let index = CALLBACKS.with(|callbacks| {
            let mut callbacks = callbacks.borrow_mut();
            callbacks.push(callback);
            callbacks.len() - 1
        });
        self.engine.subscribe(move |event| deliver(index, &event));
    }
}

fn deliver(index: usize, event: &SyncEvent) {
    CALLBACKS.with(|callbacks| {
        let callbacks = callbacks.borrow();
        let Some(callback) = callbacks.get(index) else {
            return;
        };
        let _ = callback.call1(&JsValue::NULL, &event_to_value(event));
    });
}

fn event_to_value(event: &SyncEvent) -> JsValue {
    let object = Object::new();
    match event {
        SyncEvent::RemoteUpdate {
            name,
            base,
            head,
            from,
        } => {
            set(&object, "kind", &JsValue::from_str("remote-update"));
            set(&object, "name", &JsValue::from_str(name));
            set(&object, "base", &option_bytes(base.as_deref()));
            set(&object, "head", &Uint8Array::from(head.as_ref()).into());
            set(&object, "from", &JsValue::from_str(&from.to_string()));
        }
        SyncEvent::Seeded { name } => {
            set(&object, "kind", &JsValue::from_str("seeded"));
            set(&object, "name", &JsValue::from_str(name));
        }
        SyncEvent::ExternalDrift { name } => {
            set(&object, "kind", &JsValue::from_str("external-drift"));
            set(&object, "name", &JsValue::from_str(name));
        }
        SyncEvent::PeerUp(peer) => {
            set(&object, "kind", &JsValue::from_str("peer-up"));
            set(&object, "from", &JsValue::from_str(&peer.to_string()));
        }
        SyncEvent::PeerDown(peer) => {
            set(&object, "kind", &JsValue::from_str("peer-down"));
            set(&object, "from", &JsValue::from_str(&peer.to_string()));
        }
        SyncEvent::Failed { name, reason } => {
            set(&object, "kind", &JsValue::from_str("failed"));
            set(&object, "name", &JsValue::from_str(name));
            set(&object, "reason", &JsValue::from_str(reason));
        }
    }
    JsValue::from(object)
}

fn option_bytes(bytes: Option<&[u8]>) -> JsValue {
    match bytes {
        Some(bytes) => Uint8Array::from(bytes).into(),
        None => JsValue::UNDEFINED,
    }
}

fn set(object: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(object, &JsValue::from_str(key), value);
}

fn to_js_error(error: anyhow::Error) -> JsError {
    JsError::new(&format!("{error:#}"))
}
