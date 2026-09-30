//! Reading the cached wikis *other* instances keep in this app's own storage.
//!
//! The launcher lists this device's cached Liths from its own IndexedDB and stops
//! there, because a page may only touch the storage of its own origin. Every instance
//! the user has opened is a different origin — `https://personal.lithic.uk` beside the
//! launcher's `https://tauri.localhost` — so what those instances cached is
//! unreachable from the launcher's JavaScript however it is asked for.
//!
//! **Why a window, and not just the protocol.** WebView2 does hand the browser's own
//! DevTools protocol to its host (`ICoreWebView2::CallDevToolsProtocolMethod`), and that
//! protocol's `IndexedDB` domain takes a `securityOrigin` on every call. That reads like
//! a way to enumerate any origin's store from the launcher's own webview, and this
//! module used to do exactly that. Measured on WebView2's current runtime, it does not
//! work: the domain answers only for storage the inspected page is itself part of, so
//! asking the launcher's webview about an instance comes back `No document for given
//! frame found`, while asking it about `https://tauri.localhost` answers normally. A
//! browser-level session has no `IndexedDB` domain at all.
//!
//! So the read is done from *inside* the origin it is about, which is the one vantage
//! point a page's own storage is ever readable from: the app opens a hidden window at
//! the instance's origin, reads that origin's store through the protocol handle of
//! *that* window's webview, and closes it again. The store is the same one either way —
//! every webview in this app shares one WebView2 profile
//! (`%LOCALAPPDATA%\<identifier>`), so the caches are already on this machine, in
//! stores this process wrote:
//!
//! ```text
//! …\EBWebView\Default\IndexedDB\https_personal.lithic.uk_0.indexeddb.leveldb
//! …\EBWebView\Default\IndexedDB\https_tauri.localhost_0.indexeddb.leveldb
//! ```
//!
//! Six properties are deliberate:
//!
//! **It reads only the origins it is given.** The argument is the launcher's bookmark
//! list, so what can be read is what the user saved an address for. Nothing walks the
//! profile looking for storage nobody asked about.
//!
//! **The window is a document, not a session.** It is hidden, it is skipped in the
//! taskbar, and it lives only as long as one read: created, asked, destroyed. Nothing is
//! left behind to keep the app alive after its last real window closes, and nothing
//! persists a login or a cache beyond what the instance already had. It is parked on the
//! instance's public `/manifest.json` — the address this app already trusts to describe
//! an instance (`probe_instance`) — rather than on the instance's own launcher document,
//! which a protected deployment answers 401 to.
//!
//! **It never writes, and it answers the window's own login challenge.** Every call used
//! is a read. Where the parked address still challenges — a deployment that protects its
//! manifest too — the window is given the same vault-backed handler the main window has
//! (`webview_auth`), which offers a saved credential to the origin it was saved for and
//! nothing else, and leaves the challenge alone when the app is locked.
//!
//! **It says what it could not read.** An origin with no Lithic storage, and a store
//! that was never written, are both "no cached wikis here", which the launcher shows as
//! nothing. What is *not* silent is a cap: the read is bounded in wikis and in bytes, and
//! reports having stopped early rather than leaving the launcher to believe it saw
//! everything.
//!
//! **It caps on the newest wikis, not the first ones.** A cap that took whatever the
//! store happened to yield first would drop the Lith the user was working in yesterday
//! and keep one from last spring. Every cache is therefore read before any cap is
//! applied, sorted by the stamp each record carries, and the newest ones are what fit.
//!
//! **The protocol parameters are the ones the runtime accepts.** `IndexedDB.requestData`
//! rejects `indexName` as an empty string ("Could not get index") and rejects a
//! `keyRange` of `{}` (its bounds are mandatory in this CBOR dialect), so neither is
//! sent. Both were in the first version of this read and neither was ever reached, which
//! is why they survived: see `data_params`, and the test that pins it.

// The protocol reading below is Windows' and is exercised by the tests everywhere; on the
// platforms without the hook nothing calls it, which is not a defect to be warned about.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

// The protocol plumbing this module shares with `instance_copy`, reachable only on
// the platform that has the hook.
#[cfg(windows)]
use crate::cdp::call;

/// The database and store every Lithic build keeps its caches in (`KeyvalStore`).
const DATABASE: &str = "keyval-store";
const STORE: &str = "keyval";

/// Every cache key the launcher and the engine write starts with this.
const CACHE_PREFIX: &str = "search_cache_";

/// The field of a cached record that holds the wiki itself (see `saveSearchCache`).
const TEXT_FIELD: &str = "text";

/// The public address a reader window is parked on.
///
/// Deliberately not the instance's launcher document: a protected deployment answers
/// that with 401, and a reader that had to log in would be a reader that could be
/// redirected anywhere. `/manifest.json` is the request this app already trusts to
/// describe an instance, and a stock deployment serves it without a credential.
const PARKED_PATH: &str = "/manifest.json";

/// How many wikis one instance's read will report.
const MAX_WIKIS_PER_ORIGIN: usize = 20;

/// How much wiki text one instance's read will carry back, in bytes.
///
/// Measured against a real instance rather than guessed: a year of work held 15 caches
/// and 15.84 MB of tiddler JSON, the largest single wiki 10.47 MB and the second 3.56 MB.
/// The 4 MB this used to be would have dropped that largest wiki entirely — the one the
/// user was most likely searching for — so the ceiling is set to hold a whole instance of
/// that size, and `truncated` is what tells the launcher when one is bigger still.
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// Entries asked for per protocol page.
const PAGE_SIZE: u32 = 64;

/// How long a reader window is given to produce a document before it is given up on.
///
/// The parked manifest is a small JSON file and arrives in well under a tenth of this
/// (measured: 83 ms from window creation to a document at the origin, 112 ms to a
/// readable store). The margin is for a cold profile and a slow disk, not for a slow
/// instance: nothing here waits on the instance's own application.
#[cfg(windows)]
const READER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// One cached wiki, as the instance's own saver left it.
#[derive(Debug, Serialize)]
pub struct InstanceCache {
    /// The wiki's name — the cache key without its prefix, which is what the
    /// launcher calls the Lith.
    pub name: String,
    /// The tiddler JSON the engine wrote, ready for the launcher's own
    /// `searchCachedWiki`.
    pub text: String,
}

/// What one instance's storage had to offer.
#[derive(Debug, Serialize)]
pub struct InstanceCacheRead {
    pub origin: String,
    pub caches: Vec<InstanceCache>,
    /// True when a cap stopped the read short. Reported rather than swallowed: a
    /// search that quietly cannot see everything is worse than one that says so.
    pub truncated: bool,
}

/// True only for the key holding a wiki's whole current text.
///
/// This is `isFlatCacheKey` from the launcher's `storage.ts`, spelled out again on this
/// side because the two runtimes cannot share a function — and every reader of "which
/// wikis are cached" has to agree, or the launcher lists wikis that do not exist.
/// History snapshots share the prefix and a base snapshot carries text just like a cache
/// does, so `search_cache_base_recipes.lith_3f2a` would otherwise be reported as a wiki
/// named `base_recipes.lith_3f2a`: one that no list shows, that cannot be opened, and
/// that only a search can find. The legacy `bk1`/`bk2` deep copies are excluded for the
/// same reason.
pub(crate) fn is_wiki_cache_key(key: &str) -> bool {
    let Some(name) = key.strip_prefix(CACHE_PREFIX) else {
        return false;
    };
    !name.is_empty()
        && !name.starts_with("bk")
        && !name.starts_with("meta_")
        && !name.starts_with("base_")
        && !name.starts_with("delta_")
}

/// The parameters that scope one protocol call to one origin.
fn scope_params(origin: &str) -> String {
    serde_json::json!({ "securityOrigin": origin }).to_string()
}

/// The parameters for one page of the store, as this runtime accepts them.
///
/// `indexName` and `keyRange` are absent on purpose, and that is the whole point of the
/// function existing separately: `IndexedDB.requestData` rejects an empty `indexName`
/// with "Could not get index" and a `keyRange` of `{}` with a deserialisation error
/// naming a missing `lowerOpen`, and a rejected call is indistinguishable here from a
/// store with nothing in it. The store is walked in full and filtered on this side
/// (`is_wiki_cache_key`), which is what the walk already did.
fn data_params(origin: &str, skip: u32) -> String {
    serde_json::json!({
        "securityOrigin": origin,
        "databaseName": DATABASE,
        "objectStoreName": STORE,
        "skipCount": skip,
        "pageSize": PAGE_SIZE,
    })
    .to_string()
}

/// The databases an origin has, from a `IndexedDB.requestDatabaseNames` answer.
pub(crate) fn database_names(payload: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .get("databaseNames")
        .and_then(|names| names.as_array())
        .map(|names| names.iter().filter_map(|name| name.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// The object stores of one database, from a `IndexedDB.requestDatabase` answer.
///
/// The answer's own key is `databaseWithObjectStores`, which is easy to get wrong and
/// was: this read `database`, matched nothing, and refused every store as one that did
/// not have `keyval` in it. The failure was invisible for the same reason as the rest of
/// this module's were, and it only surfaced once the reader window started working — so
/// the payload in this function's test is copied from a real answer rather than written
/// to suit the parser. `database` is still accepted because it costs one `or_else` and
/// an older runtime is exactly the kind of thing this read has to survive.
pub(crate) fn object_store_names(payload: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .get("databaseWithObjectStores")
        .or_else(|| value.get("database"))
        .and_then(|database| database.get("objectStores"))
        .and_then(|stores| stores.as_array())
        .map(|stores| stores.iter().filter_map(|store| store.get("name")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// One entry of a store, as `IndexedDB.requestData` describes it.
pub(crate) struct DataEntry {
    /// The store's own key, when it was a string (a cache key always is).
    pub key: String,
    /// The handle to the stored record, absent when the value came back by value
    /// rather than as an object (a primitive, which no cache record is).
    pub handle: String,
}

/// The entries of a `IndexedDB.requestData` answer, and whether more remain.
pub(crate) fn data_entries(payload: &str) -> (Vec<DataEntry>, bool) {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return (Vec::new(), false),
    };
    let entries = value
        .get("objectStoreDataEntries")
        .and_then(|entries| entries.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let key = entry.get("key")?.get("value")?.as_str()?.to_string();
                    let handle = entry.get("value")?.get("objectId")?.as_str()?.to_string();
                    Some(DataEntry { key, handle })
                })
                .collect()
        })
        .unwrap_or_default();
    let more = value.get("hasMore").and_then(|more| more.as_bool()).unwrap_or(false);
    (entries, more)
}

/// A cached record's own fields, from a `Runtime.getProperties` answer.
pub(crate) struct CachedRecord {
    pub text: String,
    /// When the engine last wrote it, when the record says — used only to prefer the
    /// instance's most recent wikis when a cap has to choose.
    pub saved_at: Option<f64>,
}

/// Read one record's text and stamp out of its properties.
///
/// Missing text is `None` rather than an empty cache: an entry with no text is not a
/// wiki, and reporting it as one would put a row in the launcher for nothing.
pub(crate) fn cached_record(payload: &str) -> Option<CachedRecord> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let properties = value.get("result")?.as_array()?;
    let mut text = None;
    let mut saved_at = None;
    for property in properties {
        let Some(name) = property.get("name").and_then(|name| name.as_str()) else {
            continue;
        };
        let Some(inner) = property.get("value") else { continue };
        if name == TEXT_FIELD {
            if let Some(found) = inner.get("value").and_then(|found| found.as_str()) {
                text = Some(found.to_string());
            }
        } else if name == "backupTimestamp" {
            saved_at = inner.get("value").and_then(|stamp| stamp.as_f64());
        }
    }
    Some(CachedRecord { text: text?, saved_at })
}

/// Read every cached wiki named by `origins`, in the order they were given.
///
/// Blocking on purpose: it waits for the main thread to answer, so it belongs on a
/// blocking task rather than on any thread that has to stay responsive.
#[cfg(windows)]
pub fn read_caches(app: &tauri::AppHandle, origins: &[String]) -> Vec<InstanceCacheRead> {
    origins.iter().map(|origin| read_origin(app, origin)).collect()
}

/// macOS and Linux keep no hook for this yet.
///
/// The vault is portable and already serves those platforms' Rust-side requests; what is
/// missing is the same thing `webview_auth` is missing there — the per-platform way in.
/// Answering nothing is the honest state of it, not a regression: the launcher shows no
/// instance hits, exactly as it did before any of this existed.
#[cfg(not(windows))]
pub fn read_caches(_app: &tauri::AppHandle, _origins: &[String]) -> Vec<InstanceCacheRead> {
    Vec::new()
}

/// One instance's cached wikis, read out of its own origin's store.
///
/// The window is created and destroyed inside this call, so a search leaves nothing
/// running behind it: no hidden window to keep the app alive after its last real one
/// closes, and nothing to clean up if the search is never repeated.
#[cfg(windows)]
fn read_origin(app: &tauri::AppHandle, origin: &str) -> InstanceCacheRead {
    let mut read = InstanceCacheRead { origin: origin.to_string(), caches: Vec::new(), truncated: false };
    let Some((url, normalized)) = reader_url(origin) else {
        // An address that is not an http(s) origin cannot be parked on, and naming one
        // to the protocol would be asking about somebody else's storage.
        return read;
    };
    let Some(window) = open_reader(app, &normalized, url) else {
        return read;
    };

    // One protocol conversation, on the thread that owns this window's webview.
    let asked = normalized.clone();
    let walked = crate::cdp::with_core(&window, move |core| walk(core, &asked));
    // Closed before anything else is done with the answer: the window has no further
    // part to play, and leaving it up is what would outlive the app.
    let _ = window.destroy();

    if let Some((caches, truncated)) = walked {
        read.caches = caches;
        read.truncated = truncated;
    }
    read
}

/// The address to park a reader on, and the origin to read once it is there.
///
/// The origin is normalised through the URL parser rather than trimmed, so the string
/// handed to the protocol is the same one the browser derived the store's own directory
/// name from. `None` covers every address this app never sends: a scheme that is not
/// http(s), a bare hostname, an opaque origin.
#[cfg(windows)]
fn reader_url(origin: &str) -> Option<(tauri::Url, String)> {
    let base = tauri::Url::parse(origin).ok()?;
    if !matches!(base.scheme(), "http" | "https") {
        return None;
    }
    let normalized = base.origin().ascii_serialization();
    if normalized == "null" {
        return None;
    }
    let url = base.join(PARKED_PATH).ok()?;
    Some((url, normalized))
}

/// Open the hidden window a read is performed from, and wait for its document.
///
/// `None` when the window could not be created, or when no document arrived within
/// `READER_TIMEOUT` — the instance is unreachable, or its parked address never answered.
/// A window that timed out is destroyed here rather than handed back, because a window
/// with no document is a window whose storage could not be read either way.
#[cfg(windows)]
fn open_reader(app: &tauri::AppHandle, origin: &str, url: tauri::Url) -> Option<tauri::WebviewWindow> {
    use tauri::webview::PageLoadEvent;
    use tauri::utils::config::BackgroundThrottlingPolicy;

    let (sender, receiver) = std::sync::mpsc::channel::<()>();
    let window = tauri::WebviewWindowBuilder::new(app, reader_label(origin), tauri::WebviewUrl::External(url))
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        // A hidden window is a background webview, and a throttled one may never run
        // the work that makes its origin's storage readable at all.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = sender.send(());
            }
        })
        .build()
        .ok()?;

    // The window answers its own origin's login challenge, out of the same vault and
    // under the same rule as the main window: a saved credential is offered to the
    // origin it was saved for, and a locked app answers nothing at all.
    crate::webview_auth::install(&window, app.clone());

    match receiver.recv_timeout(READER_TIMEOUT) {
        Ok(()) => Some(window),
        Err(_) => {
            let _ = window.destroy();
            None
        }
    }
}

/// The label of the reader window for one origin.
///
/// Labels are the app's own namespace, so an instance's address cannot be one: an origin
/// is not a legal label (its `:` and `.` are not) and two origins would have to be told
/// apart anyway. A hash keeps the label short, stable for the same origin, and
/// distinguishable between origins, which is all it is for.
#[cfg(windows)]
fn reader_label(origin: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in origin.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("instance-reader-{hash:016x}")
}

/// The whole read, for one reader window's own protocol handle.
///
/// The store is walked a page at a time, because it holds one entry per cached wiki plus
/// every history snapshot and delta the version chains keep — hundreds of entries on an
/// instance someone has worked in. The cap is applied afterwards, to the newest wikis
/// (see the module doc), which is why every wiki is collected before any of it is sized.
#[cfg(windows)]
fn walk(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    origin: &str,
) -> (Vec<InstanceCache>, bool) {
    // Asked first, and it is also the check: this domain answers only for storage the
    // inspected page is itself part of, so a refusal here is a reader window that is not
    // standing at the origin it was opened for. A store that is not there at all is not a
    // refusal — it is an origin with no Lithic cache, which is a complete answer.
    let Some(names) = call(core, "IndexedDB.requestDatabaseNames", &scope_params(origin)) else {
        return (Vec::new(), false);
    };
    if !database_names(&names).iter().any(|name| name == DATABASE) {
        return (Vec::new(), false);
    }
    let Some(database) = call(
        core,
        "IndexedDB.requestDatabase",
        &serde_json::json!({ "securityOrigin": origin, "databaseName": DATABASE }).to_string(),
    ) else {
        return (Vec::new(), false);
    };
    if !object_store_names(&database).iter().any(|name| name == STORE) {
        return (Vec::new(), false);
    }

    let mut found: Vec<(String, String, Option<f64>)> = Vec::new();
    let mut skip = 0u32;
    while let Some(page) = call(core, "IndexedDB.requestData", &data_params(origin, skip)) {
        let (entries, more) = data_entries(&page);
        let empty = entries.is_empty();
        for entry in entries {
            if !is_wiki_cache_key(&entry.key) {
                continue;
            }
            let params = serde_json::json!({ "objectId": entry.handle, "ownProperties": true });
            let Some(properties) = call(core, "Runtime.getProperties", &params.to_string()) else {
                continue;
            };
            if let Some(record) = cached_record(&properties) {
                let name = entry.key[CACHE_PREFIX.len()..].to_string();
                found.push((name, record.text, record.saved_at));
            }
        }
        // An empty page ends the walk whatever `hasMore` claims, so a store that starts
        // answering nothing cannot spin this loop.
        if !more || empty {
            break;
        }
        skip += PAGE_SIZE;
    }

    // Newest first, so a cap keeps the wikis the user is likeliest to be looking for.
    // A record with no stamp keeps its place at the end rather than being dropped.
    found.sort_by(|a, b| b.2.unwrap_or(0.0).partial_cmp(&a.2.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));

    let mut caches = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    for (name, text, _) in found {
        if caches.len() >= MAX_WIKIS_PER_ORIGIN || bytes + text.len() > MAX_TEXT_BYTES {
            truncated = true;
            break;
        }
        bytes += text.len();
        caches.push(InstanceCache { name, text });
    }
    (caches, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_wikis_own_cache_key_counts_as_one() {
        assert!(is_wiki_cache_key("search_cache_recipes.lith"));
        // History snapshots and deltas share the prefix; each used to be reported as a
        // wiki named after its own key.
        assert!(!is_wiki_cache_key("search_cache_meta_recipes.lith"));
        assert!(!is_wiki_cache_key("search_cache_base_recipes.lith_3f2a"));
        assert!(!is_wiki_cache_key("search_cache_delta_recipes.lith_9c11"));
        // The legacy launcher's deep copies.
        assert!(!is_wiki_cache_key("search_cache_bk1_recipes.lith"));
        assert!(!is_wiki_cache_key("search_cache_bk2_recipes.lith"));
        // The launcher's other stores, and a prefix with nothing behind it.
        assert!(!is_wiki_cache_key("dirty_state_recipes.lith"));
        assert!(!is_wiki_cache_key("recentFiles"));
        assert!(!is_wiki_cache_key("search_cache_"));
    }

    /// The shape of the read that this runtime accepts, and the one it does not.
    ///
    /// Both refusals are silent from the launcher's side — a rejected call and an empty
    /// store are the same answer — so the parameters are pinned here instead. Measured
    /// on WebView2's current runtime: `indexName: ""` comes back "Could not get index"
    /// and `keyRange: {}` comes back naming a missing `lowerOpen`.
    #[test]
    fn the_read_asks_for_the_whole_store_without_the_parameters_this_runtime_refuses() {
        let value: serde_json::Value = serde_json::from_str(&data_params("https://personal.lithic.uk", 64)).expect("json");
        assert_eq!(value["securityOrigin"], "https://personal.lithic.uk");
        assert_eq!(value["databaseName"], DATABASE);
        assert_eq!(value["objectStoreName"], STORE);
        assert_eq!(value["skipCount"], 64);
        assert_eq!(value["pageSize"], PAGE_SIZE);
        assert!(
            value.get("indexName").is_none(),
            "an empty indexName is refused by the runtime, not read as \"no index\""
        );
        assert!(
            value.get("keyRange").is_none(),
            "an empty keyRange is refused by the runtime, and a well formed one is not needed to walk a store"
        );
    }

    /// Both answers, verbatim from a live runtime.
    ///
    /// Copied rather than composed, because composing them is what hid a real bug: the
    /// store lookup read a key the protocol does not send, and the fixture agreed with
    /// it, so the read refused every store while its own test stayed green.
    #[test]
    fn the_database_and_store_are_found_in_their_answers() {
        assert_eq!(database_names(r#"{"databaseNames":["keyval-store"]}"#), vec!["keyval-store"]);
        assert!(database_names("not json").is_empty());
        assert_eq!(
            object_store_names(
                r#"{"databaseWithObjectStores":{"name":"keyval-store","objectStores":[{"autoIncrement":false,"indexes":[],"keyPath":{"type":"null"},"name":"keyval"}],"version":1}}"#
            ),
            vec!["keyval"]
        );
        assert!(object_store_names(r#"{"databaseWithObjectStores":{"objectStores":[]}}"#).is_empty());
        assert!(object_store_names("not json").is_empty());
    }

    #[test]
    fn entries_pair_each_key_with_the_handle_to_its_record() {
        let (entries, more) = data_entries(
            r#"{"objectStoreDataEntries":[
                 {"key":{"type":"string","value":"search_cache_a.lith"},
                  "primaryKey":{"type":"string","value":"search_cache_a.lith"},
                  "value":{"type":"object","objectId":"7.1"}},
                 {"key":{"type":"string","value":"recentFiles"},
                  "primaryKey":{"type":"string","value":"recentFiles"},
                  "value":{"type":"object","objectId":"7.2"}},
                 {"key":{"type":"string","value":"primitive"},
                  "primaryKey":{"type":"string","value":"primitive"},
                  "value":{"type":"string","value":"no handle here"}}
               ],"hasMore":true}"#,
        );
        // The primitive has no handle and is dropped rather than reported as a cache
        // whose text could never be read.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "search_cache_a.lith");
        assert_eq!(entries[0].handle, "7.1");
        assert_eq!(entries[1].key, "recentFiles");
        assert!(more);
        assert!(!data_entries(r#"{"objectStoreDataEntries":[]}"#).1);
    }

    #[test]
    fn a_record_yields_its_text_and_its_stamp() {
        let record = cached_record(
            r#"{"result":[
                 {"name":"lastModified","value":{"type":"string","value":"9/23/2026, 1:54:19 PM"}},
                 {"name":"text","value":{"type":"string","value":"[{\"title\":\"A\"}]"}},
                 {"name":"backupTimestamp","value":{"type":"number","value":1758626059000}}
               ]}"#,
        )
        .expect("a record with text");
        assert_eq!(record.text, "[{\"title\":\"A\"}]");
        assert_eq!(record.saved_at, Some(1758626059000.0));

        // No text is not an empty wiki: it is not a wiki, and reporting it as one would
        // put a row in the launcher for nothing.
        assert!(cached_record(r#"{"result":[{"name":"backupTimestamp","value":{"type":"number","value":1}}]}"#).is_none());
        assert!(cached_record("not json").is_none());
        // A stamp-less record still reads, and sorts last.
        assert_eq!(cached_record(r#"{"result":[{"name":"text","value":{"type":"string","value":"x"}}]}"#).unwrap().saved_at, None);
    }

    /// The address a reader may be parked on, and the origin it is then read as.
    #[cfg(windows)]
    #[test]
    fn only_an_http_origin_is_parked_on() {
        let (url, origin) = reader_url("https://personal.lithic.uk").expect("an https origin");
        assert_eq!(url.as_str(), "https://personal.lithic.uk/manifest.json");
        assert_eq!(origin, "https://personal.lithic.uk");
        // The launcher sends `URL.origin`, which carries the port when there is one.
        let (_, origin) = reader_url("http://127.0.0.1:8080").expect("a local instance");
        assert_eq!(origin, "http://127.0.0.1:8080");
        // A path on the address is not part of the origin, and the parked document is
        // this module's own choice rather than whatever the bookmark happened to hold.
        let (url, _) = reader_url("https://personal.lithic.uk/some/deep/path").expect("a path is still an origin");
        assert_eq!(url.as_str(), "https://personal.lithic.uk/manifest.json");

        for refused in ["", "   ", "personal.lithic.uk", "file:///C:/Lithic", "tauri://localhost", "about:blank"] {
            assert!(reader_url(refused).is_none(), "{refused} is not an address this app sends");
        }
    }

    /// Two origins never share a reader window's label, and the same origin always does.
    #[cfg(windows)]
    #[test]
    fn a_reader_label_is_stable_per_origin_and_its_own() {
        assert_eq!(reader_label("https://personal.lithic.uk"), reader_label("https://personal.lithic.uk"));
        assert_ne!(reader_label("https://personal.lithic.uk"), reader_label("https://www.foobar.com"));
        assert_ne!(reader_label("https://a.example"), reader_label("https://b.example"));
        // A label is the app's own namespace, and a window label may not carry the
        // punctuation an origin does: the address itself can never be one.
        let label = reader_label("https://personal.lithic.uk");
        assert!(label.starts_with("instance-reader-"), "a reader window is named as one: `{label}`");
        assert_eq!(label.len(), "instance-reader-".len() + 16, "a fixed width hash: `{label}`");
        assert!(
            label.chars().all(|character| character.is_ascii_alphanumeric() || character == '-'),
            "a label is letters, digits and dashes only: `{label}`"
        );
    }
}
