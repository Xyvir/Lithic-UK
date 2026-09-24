//! Throwing away the copy this app downloaded of an instance.
//!
//! The × on a bookmarked instance means "throw this away". Half of what the user is
//! throwing away is the bookmark itself, which lives in the launcher's own storage and
//! goes the moment it is clicked. The other half is the *copy* — the launcher document,
//! its scripts, its icons — which the window downloaded from that instance and which
//! sits in this app's WebView2 profile under the instance's own origin.
//!
//! That half cannot be done from the page. The launcher is at `https://tauri.localhost`
//! and the copy is at `https://personal.example.uk`; a page may only touch the storage
//! of its own origin, and Cache Storage and service-worker registrations are no
//! exception — so a stale instance keeps serving its own cached launcher however many
//! times the bookmark is removed and added back. That is the exact report this module
//! answers: the gesture was already the user's, it just had nothing behind it.
//!
//! The app is not a page. Every webview in it shares one profile, so the browser's own
//! protocol — reached the same way `instance_search` reaches another origin's IndexedDB
//! — can drop one origin's copy and leave every other origin, and every other kind of
//! data, alone:
//!
//! ```text
//! …\EBWebView\Default\Service Worker\CacheStorage\…
//! …\EBWebView\Default\Cache\…
//! ```
//!
//! Three properties are deliberate:
//!
//! **Only the downloaded page goes.** `CLEARED_STORES` is two types out of the
//! protocol's twelve, and the ones left out are the point: IndexedDB holds that
//! instance's cached wikis (which `instance_search` reads for the launcher's search,
//! and which are the user's offline copies of their own notes), `local_storage` holds
//! whatever the instance's engine put there, and cookies belong to a window this app
//! does not otherwise touch. `all` is one word away and would take all of it.
//!
//! **The saved login is not involved.** Credentials live in the vault file
//! (`credentials`), not in the profile, and nothing here reads, moves or deletes it:
//! forgetting a login stays the vault's own explicit, named action.
//!
//! **It says whether it happened.** A runtime without the protocol method, or a
//! deployment on a platform with no hook at all (`supported`), answers instead of
//! pretending — the launcher has one sentence for a copy it could not drop, and prints
//! nothing where dropping one was never on offer.

// The two decisions below are asserted by the tests on every platform; on the platforms
// without the hook nothing else calls them, which is not a defect to be warned about.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// The stores a *downloaded page* lives in, and nothing else.
///
/// Two types rather than `all`, because the cost of `all` is everything else the origin
/// keeps: its cached wikis (IndexedDB), whatever its engine wrote into
/// `local_storage`, and its cookies. Read `ClearDataForOrigin`'s own list before
/// changing this string — it is a comma-separated list, and a typo in it clears
/// nothing at all.
const CLEARED_STORES: &str = "service_workers,cache_storage";

/// The protocol call that drops one origin's copy, as the protocol takes it.
///
/// Separated from the call itself so the two decisions it encodes — which origin, and
/// which of the origin's stores — are assertable without a webview. Both halves matter
/// equally: an origin that is not quite the one on screen clears a stranger's copy, and
/// a storage list that is one word wider takes the user's own offline notes with it.
fn clear_params(origin: &str) -> String {
    serde_json::json!({ "origin": origin, "storageTypes": CLEARED_STORES }).to_string()
}

/// The origin a request may name, or nothing.
///
/// The launcher sends what `URL.origin` gives it, so this is a guard rather than a
/// parser. It is worth having anyway: the protocol takes an origin literally and clears
/// whatever matches, so an address carrying a path, a query, or a userinfo would either
/// match nothing or name a *different* origin than the one the user is looking at. A
/// form this app never produces is refused rather than trimmed into something it did
/// not mean, and the refusal is reported like any other copy that is still there.
fn origin_only(value: &str) -> Option<String> {
    let lowered = value.trim().to_ascii_lowercase();
    let rest = lowered
        .strip_prefix("https://")
        .or_else(|| lowered.strip_prefix("http://"))?;
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.chars().any(char::is_whitespace)
    {
        return None;
    }
    // Host, with the port when the last colon is followed by digits. A bracketed IPv6
    // literal is the one host that may carry a colon of its own. The port itself is
    // only checked, not carried: the whole lowered address goes back, scheme included,
    // because that is what the protocol wants to be handed.
    let host = match rest.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) => host,
        _ => rest,
    };
    let ipv6 = host.starts_with('[') && host.ends_with(']');
    if host.is_empty() || (host.contains(':') && !ipv6) {
        return None;
    }
    Some(lowered)
}

/// What dropping one origin's copy did.
#[derive(Serialize)]
pub struct CopyDropped {
    /// Whether this build and platform can drop a copy at all. False is not a failure:
    /// on a platform with no hook the gesture never promised this half, so the launcher
    /// says nothing about it.
    pub supported: bool,
    /// Whether the protocol answered the call that drops it. False on a supported
    /// platform means the copy is still there, which is the one case worth a sentence.
    pub cleared: bool,
}

impl CopyDropped {
    /// Nothing was attempted — no hook on this platform, or no window to ask.
    pub fn unsupported() -> Self {
        Self { supported: false, cleared: false }
    }
}

/// Drop the copy this app downloaded of one origin.
///
/// Two calls, in the order that matters: the origin's own stores first, since that is
/// what the answer is about, and then the webview's HTTP cache — which the protocol only
/// knows how to drop as a whole, and which is where the document itself may also be
/// sitting, heuristically fresh and with nothing to revalidate against. The second call
/// is best effort by design: it costs cached bytes, and a runtime that refuses it does
/// not change what this reports.
#[cfg(windows)]
pub fn forget(window: &tauri::WebviewWindow, origin: &str) -> CopyDropped {
    let Some(origin) = origin_only(origin) else {
        // A name this app never sends. Nothing was cleared, so nothing is reported as
        // cleared — an address the protocol cannot be aimed at is not a success.
        return CopyDropped { supported: true, cleared: false };
    };
    let params = clear_params(&origin);
    let cleared = crate::cdp::with_core(window, move |core| {
        let cleared = crate::cdp::call(core, "Storage.clearDataForOrigin", &params).is_some();
        // Bytes, no storage: the HTTP cache has no per-origin clear in the protocol, and
        // a copy with no validator is exactly what a plain revalidation would keep.
        let _ = crate::cdp::call(core, "Network.clearBrowserCache", "{}");
        cleared
    })
    .unwrap_or(false);
    CopyDropped { supported: true, cleared }
}

/// macOS and Linux keep the copy until a page at that origin, or this app's own hook
/// there, can drop it.
///
/// The vault is portable and already serves those platforms' Rust-side requests; what is
/// missing is the same thing `webview_auth` and `instance_search` are missing there — the
/// per-platform way in. Answering `supported: false` is the honest state of it: the
/// bookmark is still removed, and the launcher prints nothing about a half this platform
/// never offered.
#[cfg(not(windows))]
pub fn forget(_window: &tauri::WebviewWindow, _origin: &str) -> CopyDropped {
    CopyDropped::unsupported()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole reason this module exists: the copy goes and nothing else does.
    #[test]
    fn the_request_drops_the_downloaded_page_and_nothing_else() {
        let value: serde_json::Value =
            serde_json::from_str(&clear_params("https://personal.lithic.uk")).expect("json");
        assert_eq!(value["origin"], "https://personal.lithic.uk");
        assert_eq!(
            value["storageTypes"], CLEARED_STORES,
            "the protocol is handed the same list this module names"
        );
        let types = CLEARED_STORES;
        // Named one at a time, because each of these would take something the user did
        // not throw away: their cached wikis, the instance's own settings, its cookies.
        for forbidden in ["all", "indexeddb", "local_storage", "cookies", "file_systems"] {
            assert!(
                !types.contains(forbidden),
                "{forbidden} is not part of a downloaded page, and clearing it would cost \
                 something the × did not throw away (list is `{types}`)"
            );
        }
        assert!(
            types.contains("service_workers") && types.contains("cache_storage"),
            "the two stores a downloaded page actually lives in have to both be named: `{types}`"
        );
    }

    #[test]
    fn only_a_bare_origin_is_accepted() {
        assert_eq!(origin_only("https://personal.lithic.uk"), Some("https://personal.lithic.uk".to_string()));
        assert_eq!(origin_only("http://127.0.0.1:8080"), Some("http://127.0.0.1:8080".to_string()));
        assert_eq!(origin_only("http://[::1]:8080"), Some("http://[::1]:8080".to_string()));
        // Case is not part of an origin, so a shouted one is the same origin.
        assert_eq!(origin_only("HTTPS://Personal.Lithic.UK"), Some("https://personal.lithic.uk".to_string()));

        // Every shape that could aim the call at something else, or at nothing.
        for refused in [
            "",
            "   ",
            "personal.lithic.uk",
            "https://personal.lithic.uk/",
            "https://personal.lithic.uk/src/launcher.html",
            "https://personal.lithic.uk/?mode=self-host",
            "https://personal.lithic.uk#top",
            "https://keeper:secret@personal.lithic.uk",
            "https://personal.lithic.uk:",
            "https://personal.lithic.uk:80x",
            "file:///C:/Lithic",
            "tauri://localhost",
            "https://"
        ] {
            assert_eq!(origin_only(refused), None, "{refused} is not an origin this app sends");
        }
    }

    /// A platform with no hook says so rather than reporting a copy it did not drop.
    #[test]
    fn a_platform_without_the_hook_says_so() {
        let dropped = CopyDropped::unsupported();
        assert!(!dropped.supported);
        assert!(!dropped.cleared);
    }
}
