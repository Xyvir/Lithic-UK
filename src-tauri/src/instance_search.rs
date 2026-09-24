//! Reading the cached wikis *other* instances keep in this app's own storage.
//!
//! The launcher lists this device's cached Liths from its own IndexedDB and stops
//! there, because a page may only touch the storage of its own origin. Every instance
//! the user has opened is a different origin — `https://personal.lithic.uk` beside the
//! launcher's `https://tauri.localhost` — so what those instances cached is
//! unreachable from the launcher's JavaScript however it is asked for.
//!
//! The app is not a page. Every webview in it shares one WebView2 profile (tauri forces
//! `%LOCALAPPDATA%\<identifier>` on any webview that does not name its own), so those
//! caches are already on this machine, in stores this process wrote:
//!
//! ```text
//! …\EBWebView\Default\IndexedDB\https_personal.lithic.uk_0.indexeddb.leveldb
//! …\EBWebView\Default\IndexedDB\https_tauri.localhost_0.indexeddb.leveldb
//! ```
//!
//! So the read is a host-level one, not a page-level one: WebView2 hands the browser's
//! own DevTools protocol to its host (`ICoreWebView2::CallDevToolsProtocolMethod`), and
//! that protocol's `IndexedDB` domain takes a `securityOrigin` on every call. The
//! launcher's own webview is therefore asked to enumerate and read the store of an
//! origin its script could never reach. The same machinery the credential vault already
//! uses to answer the page's HTTP auth challenges (`webview_auth`) is what makes this
//! possible at all.
//!
//! Four properties are deliberate:
//!
//! **It reads only the origins it is given.** The argument is the launcher's bookmark
//! list, so what can be read is what the user saved an address for. Nothing walks the
//! profile looking for storage nobody asked about.
//!
//! **It never navigates and never loads an instance.** No request leaves the machine —
//! the cache is local — and no instance's page is booted to answer a question about it.
//! Nothing here writes, either: every call used is a read.
//!
//! **It answers empty rather than failing.** An unknown origin, a store that was never
//! written, a runtime without the domain, a platform without the hook: all of them are
//! "no cached wikis here", which the launcher renders as nothing at all. There is no
//! error path because none of these is the user's problem to be told about.
//!
//! **It is capped, and says when the cap bit.** One instance's cache is as large as its
//! owner's editing made it, and this runs while the window waits, so the read is bounded
//! in wikis and in bytes — and reports having stopped early rather than leaving the
//! launcher to believe it saw everything.

// The protocol reading below is Windows' and is exercised by the tests everywhere; on the
// platforms without the hook nothing calls it, which is not a defect to be warned about.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// The database and store every Lithic build keeps its caches in (`KeyvalStore`).
const DATABASE: &str = "keyval-store";
const STORE: &str = "keyval";

/// Every cache key the launcher and the engine write starts with this.
const CACHE_PREFIX: &str = "search_cache_";

/// The field of a cached record that holds the wiki itself (see `saveSearchCache`).
const TEXT_FIELD: &str = "text";

/// How many wikis one instance's read will report.
const MAX_WIKIS_PER_ORIGIN: usize = 20;

/// How much wiki text one instance's read will carry back, in bytes.
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

/// Entries asked for per protocol page.
const PAGE_SIZE: u32 = 64;

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
pub(crate) fn object_store_names(payload: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    value
        .get("database")
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
pub fn read_caches(window: &tauri::WebviewWindow, origins: &[String]) -> Vec<InstanceCacheRead> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let window = window.clone();
    let origins: Vec<String> = origins.to_vec();
    // The webview lives on the main thread and so does every one of these calls, which
    // is why the work is handed over rather than done here. `with_webview` returns as
    // soon as it has posted the closure; the answer comes back on the channel below.
    let posted = window.with_webview(move |platform| {
        let reads = read_from(&platform.controller(), &origins);
        let _ = sender.send(reads);
    });
    if posted.is_err() {
        return Vec::new();
    }
    receiver.recv().unwrap_or_default()
}

/// macOS and Linux keep no hook for this yet.
///
/// The vault is portable and already serves those platforms' Rust-side requests; what is
/// missing is the same thing `webview_auth` is missing there — the per-platform way in.
/// Answering nothing is the honest state of it, not a regression: the launcher shows no
/// instance hits, exactly as it did before any of this existed.
#[cfg(not(windows))]
pub fn read_caches(_window: &tauri::WebviewWindow, _origins: &[String]) -> Vec<InstanceCacheRead> {
    Vec::new()
}

/// The whole read, on the thread that owns the webview.
#[cfg(windows)]
fn read_from(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    origins: &[String],
) -> Vec<InstanceCacheRead> {
    let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
        return Vec::new();
    };
    origins
        .iter()
        .map(|origin| read_origin(&core, origin))
        .collect()
}

/// Send one protocol call and wait for its answer.
///
/// The completion handler fires on this thread — the one that owns the webview — so the
/// wait has to keep that thread's message pump turning or the answer could never
/// arrive. `wait_with_pump` is the helper wry uses for the same reason while it creates
/// a webview environment.
#[cfg(windows)]
fn call(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    method: &str,
    params: &str,
) -> Option<String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    let (sender, receiver) = std::sync::mpsc::channel();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |error, result| {
        // A refused call is an answer too: it is how a runtime without the domain, or a
        // store that was never written, comes back — and both mean "nothing here".
        let _ = sender.send(if error.is_ok() { Some(result) } else { None });
        Ok(())
    }));
    unsafe {
        core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler)
            .ok()?;
    }
    webview2_com::wait_with_pump(receiver).ok().flatten()
}

/// One instance's cached wikis, read out of its own origin's store.
#[cfg(windows)]
fn read_origin(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    origin: &str,
) -> InstanceCacheRead {
    let mut read = InstanceCacheRead { origin: origin.to_string(), caches: Vec::new(), truncated: false };
    let scope = serde_json::json!({ "securityOrigin": origin });

    let Some(names) = call(core, "IndexedDB.requestDatabaseNames", &scope.to_string()) else {
        return read;
    };
    if !database_names(&names).iter().any(|name| name == DATABASE) {
        // The origin has a profile but no Lithic cache: a bookmark opened in a browser
        // other than this app, or an instance never opened at all.
        return read;
    }

    let Some(database) = call(
        core,
        "IndexedDB.requestDatabase",
        &serde_json::json!({ "securityOrigin": origin, "databaseName": DATABASE }).to_string(),
    ) else {
        return read;
    };
    if !object_store_names(&database).iter().any(|name| name == STORE) {
        return read;
    }

    // The store is read a page at a time, because it holds one entry per cached wiki
    // plus every history snapshot and delta the version chains keep — hundreds of
    // entries on an instance someone has worked in.
    let mut found: Vec<(String, String, Option<f64>)> = Vec::new();
    let mut skip = 0u32;
    loop {
        let params = serde_json::json!({
            "securityOrigin": origin,
            "databaseName": DATABASE,
            "objectStoreName": STORE,
            "indexName": "",
            "skipCount": skip,
            "pageSize": PAGE_SIZE,
            "keyRange": {},
        });
        let Some(page) = call(core, "IndexedDB.requestData", &params.to_string()) else {
            break;
        };
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

    let mut bytes = 0usize;
    for (name, text, _) in found {
        if read.caches.len() >= MAX_WIKIS_PER_ORIGIN || bytes + text.len() > MAX_TEXT_BYTES {
            read.truncated = true;
            break;
        }
        bytes += text.len();
        read.caches.push(InstanceCache { name, text });
    }
    read
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

    #[test]
    fn the_database_and_store_are_found_in_their_answers() {
        assert_eq!(database_names(r#"{"databaseNames":["keyval-store","other"]}"#), vec!["keyval-store", "other"]);
        assert!(database_names("not json").is_empty());
        assert_eq!(
            object_store_names(r#"{"database":{"databaseName":"keyval-store","objectStores":[{"name":"keyval"}]}}"#),
            vec!["keyval"]
        );
        assert!(object_store_names(r#"{"database":{"objectStores":[]}}"#).is_empty());
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
}
