//! The phone's answers to `platform`'s capabilities, and the bridge that carries them.
//!
//! Compiled on every platform, like `linux.rs` and `macos.rs`, and for the reason the module doc
//! in `mod.rs` gives: this project's local gate runs on Windows, so a body behind
//! `cfg(target_os = "android")` alone is a body `cargo check`, `clippy` and `cargo test` never
//! look at. What can be is `std` or a Tauri plugin that builds on every target.
//!
//! WHAT THE GATE CAN AND CANNOT SEE HERE, AND WHY
//!
//! This module's two neighbours are plain `std` throughout, so they compile on every platform
//! whole. This one cannot be: a phone's document answers are not a process spawn and not a Rust
//! library but a call into Kotlin, and Tauri exposes that call -- `PluginHandle::run_mobile_plugin`
//! and `PluginApi::register_android_plugin` -- only on Android and iOS. Those bodies are
//! therefore `#[cfg(target_os = "android")]`, exactly as the FFI bodies in `windows.rs` are
//! `#[cfg(windows)]`, and every *signature* and every routing arm above them stays compiled
//! everywhere so the desktop gate still type-checks the shape of the table. Each function has one
//! body on Android and one on every other platform, and the second one answers honestly that the
//! capability belongs to a phone rather than pretending to succeed.
//!
//! WHY THIS MODULE OWNS A TAURI PLUGIN
//!
//! A document this app may write back to has to stay writable after a restart, and
//! `ACTION_OPEN_DOCUMENT`'s grant is only persistent when the app asks for it to be
//! (`takePersistableUriPermission`). Tauri's own dialog plugin picks on Android with
//! `ACTION_GET_CONTENT` and asks for nothing of the sort, so a Lith opened through it could be
//! read once and never saved -- which is why the picker here is this project's own Kotlin,
//! reached the way Tauri reaches any native side: a registered plugin whose `@Command`s are
//! called with `run_mobile_plugin`. The Kotlin lives in `src-tauri/android/LithicBridge.kt` and
//! is installed into the generated project by `scripts/patch-android.mjs`.
//!
//! Reading and writing the reference that picker returns is *not* Kotlin: `tauri-plugin-fs`
//! turns a `content://` URI into a file descriptor through the platform's ContentResolver, and
//! that is the only supported way to read one, so it is what these two commands use.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FilePath;

/// The Kotlin plugin's package and class, which the patch script writes into the project.
const PLUGIN_PACKAGE: &str = "com.lithic.app";
const PLUGIN_CLASS: &str = "LithicBridge";

/// The plugin itself, registered on every platform.
///
/// On Android it registers the Kotlin class when the patch step has run. A project whose patch
/// step has not run has no such class, and there the handle is simply absent: the commands below
/// say so in a sentence, which is a far better answer than a launcher that will not start because
/// a build step was missed. On every other platform it is a plugin that owns nothing, which is
/// what keeps the routing in this module compiled and linted by a Windows gate.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("lithic-bridge")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS).ok();
                app.manage(Bridge(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = app;
                let _ = api;
            }
            Ok(())
        })
        .build()
}

/// This build's handle to the Kotlin side, managed by `plugin()` on Android.
#[cfg(target_os = "android")]
pub struct Bridge<R: Runtime>(Option<tauri::plugin::PluginHandle<R>>);

/// This build's handle to the Kotlin side, or an error naming what is missing.
///
/// The one error a phone build can hit that a desktop build cannot: a project whose patch step
/// did not run has no such plugin, and the message says so rather than surfacing the platform's
/// own wording for a missing class.
#[cfg(target_os = "android")]
fn bridge<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::plugin::PluginHandle<R>, String> {
    app.state::<Bridge<R>>()
        .0
        .clone()
        .ok_or_else(|| {
            "the phone's own bridge is not in this build. Run `npm run patch:android` after \
             `tauri android init`."
                .to_string()
        })
}

/// The sentence a capability answers with on a build that is not a phone.
///
/// Every body that would call into Kotlin has one of these on the other side of its `cfg`: the
/// capability is not absent, it is somewhere this build is not, and saying so is better than
/// returning a success that did nothing.
#[cfg(not(target_os = "android"))]
fn phone_only(what: &str) -> String {
    format!("{what} is the phone's own, and this build is not running on a phone.")
}

/// Hand an address to the phone's own browser.
///
/// The one answer here that is not a Kotlin call, and the reason `open_in_browser` in `mod.rs`
/// takes the app handle at all: a phone has no `xdg-open` to run, and an app cannot start a
/// browser for itself except through the platform, which is an `Intent`
/// (`tauri-plugin-opener`'s `ACTION_VIEW` with a new task). That plugin's `open_url` exists on
/// every platform, so this body compiles whole and needs no `cfg`. It is what a bookmarked
/// instance is handed to, because the webview here cannot answer the instance's login
/// (`Capabilities::instance_auth`).
pub fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Open the phone's own document picker, and answer with what it handed over.
///
/// `None` is the picker being dismissed, the same answer the desktop dialog gives, and not an
/// error: the launcher treats the two identically. The references are `content://` URIs whose
/// grant this app keeps across restarts (see the module doc).
pub fn pick(app: &AppHandle, multiple: bool) -> Result<Option<Vec<FilePath>>, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            references: Vec<String>,
        }
        let answer: Answer = bridge(app)?
            .run_mobile_plugin("pickDocuments", serde_json::json!({ "multiple": multiple }))
            .map_err(|error| error.to_string())?;
        if answer.references.is_empty() {
            return Ok(None);
        }
        Ok(Some(answer.references.into_iter().map(reference).collect()))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, multiple);
        Err(phone_only("The document picker"))
    }
}

/// Ask the phone where a new document should go, and answer with the one it made.
pub fn pick_save(app: &AppHandle, suggested_name: &str) -> Result<Option<FilePath>, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            reference: Option<String>,
        }
        let answer: Answer = bridge(app)?
            .run_mobile_plugin(
                "createDocument",
                serde_json::json!({ "suggestedName": suggested_name }),
            )
            .map_err(|error| error.to_string())?;
        Ok(answer.reference.filter(|it| !it.is_empty()).map(reference))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, suggested_name);
        Err(phone_only("The save picker"))
    }
}

/// The board this app was asked to open, if it was asked, and only once.
///
/// A tap in a board's sign-in window is an intent: the page there hands a `lithic://` address to
/// this app, and the address arrives on the launch intent (or, for an app already running, on
/// `onNewIntent`). `MainActivity` keeps it and `LithicBridge.takeDeepLink` answers with it, so this
/// is the page asking. Reading it consumes it: coming back from the board must not send the window
/// there again.
///
/// `None` is every other answer, and there are three of them: a build with no bridge (a desktop, or
/// a phone build whose patch step has not run), an app nobody handed anything to, and a hand-off
/// that has already been taken.
pub fn take_deep_link(app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            link: Option<String>,
        }
        // A bridge that cannot be reached is the same answer as no hand-off: the page has nothing
        // to open either way, and saying so twice would only be a sentence nobody can act on.
        let answer: Answer = bridge(app).ok()?.run_mobile_plugin("takeDeepLink", serde_json::json!({})).ok()?;
        answer.link.filter(|link| !link.is_empty())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

/// A document another app asked this one to open, if one did, and only once.
///
/// The phone's own answer to "Open with", and the one route into this app that is neither a
/// command-line argument nor a pick: a file manager that opens a `.lith` sends an `ACTION_VIEW`
/// intent carrying a `content://` reference, which a page in a webview cannot read for itself.
/// `MainActivity` keeps it and `LithicBridge.takeOpenDocument` hands it over, and reading it
/// consumes it, so the launcher is not handed the same document again by a reload.
///
/// The same three nothings as `take_deep_link` answer `None`: a build with no bridge, an app
/// nobody handed a file to, and a hand-off already taken. On every other platform the file is
/// an argument rather than an intent (`get_startup_file`), so there is nothing here to answer.
pub fn take_open_document(app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            reference: Option<String>,
        }
        // A bridge that cannot be reached is the same answer as no document: the page has
        // nothing to open either way, and saying so twice would only be a sentence nobody can
        // act on.
        let answer: Answer = bridge(app)
            .ok()?
            .run_mobile_plugin("takeOpenDocument", serde_json::json!({}))
            .ok()?;
        answer.reference.filter(|reference| !reference.is_empty())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

/// What another app shared with this one, if anything did, and only once.
///
/// The phone's share sheet is KOTLIN's: the content arrives as an `ACTION_SEND` intent's extras,
/// which is a platform object a page in a webview cannot read, so `MainActivity` keeps it and
/// `LithicBridge.takeSharedText` hands it over. Reading it clears it, which is what makes this a
/// one-time hand-off rather than a setting: a reload of the launcher must not queue the same
/// shared note twice.
///
/// The same three nothings as `take_deep_link` answer `None`: a build with no bridge, an app
/// nobody shared into, and a share already taken. On every other platform the capability belongs
/// to a phone, and this says so by having nothing to answer with.
pub fn take_shared_text(app: &AppHandle) -> Option<super::SharedText> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Answer {
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            title: Option<String>,
        }
        // A bridge that cannot be reached is the same answer as no share: the page has nothing to
        // queue either way, and saying so twice would only be a sentence nobody can act on.
        let answer: Answer = bridge(app).ok()?.run_mobile_plugin("takeSharedText", serde_json::json!({})).ok()?;
        let text = answer.text.unwrap_or_default();
        let title = answer.title.unwrap_or_default();
        // A share of nothing is not a share. `MainActivity` does not keep one either, so this is
        // the second half of one decision rather than a second rule.
        if text.trim().is_empty() && title.trim().is_empty() {
            return None;
        }
        Some(super::SharedText { text, title })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        None
    }
}

/// A document's text, read through the platform's own resolver.
///
/// The reference is not a path and cannot be handed to `std::fs`: `tauri-plugin-fs` turns a
/// `content://` URI into a file descriptor through the ContentResolver, which is the only
/// supported way to read one.
pub fn read(app: &AppHandle, document: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_fs::FsExt;
        app.fs()
            .read_to_string(reference(document.to_string()))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, document);
        Err(phone_only("Reading a referenced document"))
    }
}

/// Replace a document's text, through the same resolver and with a writable descriptor.
///
/// Truncating rather than overwriting in place: a Lith that shrank must not keep its tail, which
/// is exactly what a write without truncation would leave behind.
pub fn write(app: &AppHandle, document: &str, text: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use std::io::Write;
        use tauri_plugin_fs::FsExt;
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.write(true).truncate(true);
        let mut file = app
            .fs()
            .open(reference(document.to_string()), options)
            .map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes()).map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, document, text);
        Err(phone_only("Writing a referenced document"))
    }
}

/// A document's bytes, base64-encoded, read through the platform's own resolver.
///
/// The half of "open this PDF" that a phone could not answer before: the bytes are read here,
/// because the importer that renders a PDF's pages runs inside the mounted document, and nothing
/// writes back to the source. A `content://` reference cannot be handed to `std::fs`, so this is
/// the same plugin call `read` makes, and the encoding is the launcher's own wire format rather
/// than a second one invented here.
pub fn read_base64(app: &AppHandle, document: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use base64::Engine;
        use tauri_plugin_fs::FsExt;
        let bytes = app
            .fs()
            .read(reference(document.to_string()))
            .map_err(|error| error.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, document);
        Err(phone_only("Reading a reference's bytes"))
    }
}

/// The name a row shows for a document.
///
/// Asked of the platform rather than parsed out of the reference: a `content://` address names a
/// provider and a document id, and the display name lives in the provider's own metadata, which
/// Tauri's path resolver is what knows how to ask for. That resolver's `file_name` exists on
/// every platform (it falls back to the last path component), so this body needs no `cfg`; on
/// Android it is the plugin call that finds `_display_name`.
pub fn name(app: &AppHandle, document: &str) -> String {
    app.path()
        .file_name(document)
        .unwrap_or_else(|| document.to_string())
}

/// Whether a pick on this platform answers with something other than a path.
pub fn references_not_paths() -> bool {
    true
}

/// A reference this app may read and write, as the string that names it.
///
/// `FilePath`'s own parser is infallible -- a string is either a URL or a path -- and the match
/// keeps the crate's no-unwrap habit rather than reaching for an `expect` whose failure cannot
/// happen.
#[cfg(target_os = "android")]
fn reference(document: String) -> FilePath {
    use std::str::FromStr;
    match FilePath::from_str(&document) {
        Ok(file) => file,
        Err(never) => match never {},
    }
}
