//! Holding the page's own synchronous functions against a plugin that replaces them.
//!
//! TiddlyWiki gates an action on `window.confirm` (`$action-confirm`, which Streams wraps around
//! every node split, every merge and every delete) and reports a failure with `window.alert`.
//! Both are synchronous in a browser: the widget reads a boolean and the page waits. In the
//! desktop app neither worked. The dialog plugin ships an init script that runs in every document
//! and swaps both for IPC calls:
//!
//! ```js
//! window.alert = function (message) { invoke("plugin:dialog|message", { message: ... }); };
//! window.confirm = async function (message) {
//!   return await invoke("plugin:dialog|confirm", { message: ... });
//! };
//! ```
//!
//! Two faults in that replacement, and either one loses the question. It is **async**, so
//! `if (confirm(message))` tests a Promise, which is always truthy, and the action runs before
//! anybody could answer. And this app grants the page no dialog permission at all (every native
//! picker is opened from Rust, see the note in `Cargo.toml`), so the invoke is refused and
//! `confirm` is a promise that rejects, while `alert` is a message nothing displays. A split
//! therefore happened with no question asked, which is the report that started this.
//!
//! **The audit, and why it is short.** The scripts that get injected are inlined into the
//! binary, so the whole class can be read out of the shipped bytes rather than guessed at:
//! `grep -a "window\." target/debug/lithic.exe`. Every standard global any of them touches is
//! the two above; the rest of what they add are new names of their own (`__TAURI_INTERNALS__`,
//! `__TAURI__`, `ipc`, `isTauri`, the `__TAURI_PLUGIN_*__` namespaces), which collide with
//! nothing the wiki calls. `REPLACED` is that list, and it is the whole mechanism: a plugin
//! upgrade that starts replacing something else is one row, and a `cargo test` over the list
//! fails until the script and the audit agree.
//!
//! **Why this is a capture and not a replacement.** Measured in the app: WebView2 installs
//! `confirm` as an *own* property of the window, so `delete window.confirm` leaves nothing
//! behind (`Window.prototype.confirm` is undefined, unlike an ordinary WebIDL member), and the
//! plugin's script runs at document creation, before any script the page contains. So the
//! original can only be reached from an init script that runs *earlier*, which is what this
//! plugin is: registered ahead of the dialog plugin, it holds each function in a closure and
//! puts it back once the replacement is in place.
//!
//! The restore waits rather than racing: a microtask and a zero-delay timer both land after the
//! dialog plugin's script, and the DOM-ready pass is the net under a host that ordered the two
//! differently. It is idempotent (a value is assigned back only when it is not already the
//! native one), so running it three times costs nothing, and it survives the launcher replacing
//! its own document with the engine's, which is where the wiki asks.
//!
//! `scripts/probe-webview-globals.mjs` is the other half: it launches the built app with the
//! webview's DevTools port open and asserts, in the running window, that each name below is the
//! engine's own function and that `confirm` still blocks and answers with a boolean. It needs a
//! Windows build and a window, so it is a local instrument rather than a CI gate.

/// The page's own functions the app's plugins replace, in the order they are captured.
///
/// One row per function, because the fix is a table: a plugin upgrade that starts replacing
/// something else is a line here and a `cargo test` that says the script and the audit have to
/// agree. `probe-webview-globals.mjs` reads the same list by name.
const REPLACED: &[&str] = &["confirm", "alert"];

/// The init script: capture every listed function, then put it back.
///
/// Generated from `REPLACED` rather than written out, so a name cannot be held in one half of
/// the pair and forgotten in the other. ES5 apart from the `queueMicrotask` probe, because it
/// runs in whatever webview the app ships to.
fn script() -> String {
    let names: Vec<String> = REPLACED.iter().map(|name| format!("\"{name}\"")).collect();
    [
        "(function () {",
        &format!("  var names = [{}];", names.join(", ")),
        "  var native = {};",
        "  var kept = [];",
        "  for (var i = 0; i < names.length; i += 1) {",
        "    if (typeof window[names[i]] === \"function\") {",
        "      native[names[i]] = window[names[i]];",
        "      kept.push(names[i]);",
        "    }",
        "  }",
        "  if (kept.length === 0) return;",
        "  function restore() {",
        "    for (var j = 0; j < kept.length; j += 1) {",
        "      var name = kept[j];",
        "      if (window[name] !== native[name]) window[name] = native[name];",
        "    }",
        "  }",
        "  if (typeof queueMicrotask === \"function\") queueMicrotask(restore);",
        "  setTimeout(restore, 0);",
        "  if (document.readyState === \"loading\") {",
        "    document.addEventListener(\"DOMContentLoaded\", restore);",
        "  } else {",
        "    restore();",
        "  }",
        "})();",
    ]
    .join("\n")
}

/// The plugin that carries the script, registered before `tauri_plugin_dialog::init()`.
///
/// Registration order is the whole mechanism: Tauri collects each plugin's init script as it
/// initialises the plugin, so the first one registered is the first one the document runs.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("native-dialogs")
        .js_init_script(script())
        .build()
}

#[cfg(test)]
mod tests {
    use super::{script, REPLACED};

    /// The audit, pinned. A plugin upgrade that replaces something else is a deliberate decision
    /// rather than a diff somebody does not read: the name goes in this list, and the module's
    /// documentation says what the function means to the engine.
    #[test]
    fn the_audit_lists_the_globals_the_plugins_replace() {
        assert_eq!(REPLACED, &["confirm", "alert"]);
    }

    /// Every name reaches the script, and both halves travel together: added to the list and
    /// nowhere else, a name would be captured by nothing and restored by nothing.
    #[test]
    fn the_script_holds_every_listed_name() {
        let emitted = script();
        assert!(
            emitted.contains("var names = [\"confirm\", \"alert\"];"),
            "{emitted}"
        );
        assert!(
            emitted.contains("native[names[i]] = window[names[i]];"),
            "{emitted}"
        );
        assert!(
            emitted.contains("if (window[name] !== native[name]) window[name] = native[name];"),
            "{emitted}"
        );
    }

    /// Restoration is by assignment and never by `delete`: measured in the app, deleting the
    /// replaced property leaves `window.confirm` undefined rather than revealing the engine's.
    #[test]
    fn the_script_restores_by_assignment() {
        assert!(!script().contains("delete"));
    }

    /// Three moments, because the plugin's script and this one are both document-created and a
    /// host could order them either way; the restore is idempotent, so all three may run.
    #[test]
    fn the_script_restores_on_the_next_task_and_at_dom_ready() {
        let emitted = script();
        assert!(emitted.contains("queueMicrotask(restore)"), "{emitted}");
        assert!(emitted.contains("setTimeout(restore, 0)"), "{emitted}");
        assert!(
            emitted.contains("addEventListener(\"DOMContentLoaded\", restore)"),
            "{emitted}"
        );
    }
}
