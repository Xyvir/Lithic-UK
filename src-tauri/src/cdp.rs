//! Speaking the webview's own DevTools protocol from the host side.
//!
//! A page may only touch its own origin's storage. Everything this app needs to do
//! *outside* that — reading the cached wikis another instance left in this profile,
//! and throwing away the copy of an instance's launcher this profile downloaded —
//! happens where the browser's own protocol is available to the process that embeds
//! it: `ICoreWebView2::CallDevToolsProtocolMethod`, which WebView2 hands to its host.
//!
//! Two properties are why this is one module rather than two copies of the same
//! thirty lines:
//!
//! **The work belongs to another thread.** The webview lives on the main thread, and
//! so does every one of these calls. `with_core` posts the closure there and returns
//! immediately; the answer comes back on a channel, so the caller — a launcher
//! command on a blocking task — waits without ever holding the main thread.
//!
//! **The wait has to keep that thread's message pump turning.** The completion
//! handler fires on the thread that owns the webview, so a plain blocking wait would
//! deadlock it before the answer could arrive. `wait_with_pump` is the helper wry uses
//! for the same reason while it creates a webview environment.
//!
//! `None` is an answer throughout: a runtime that does not have the domain, a method
//! it refuses, and a window whose thread is already gone all come back the same way,
//! and every caller here treats that as "nothing to report" rather than an error the
//! user has to be told about.

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

/// Run one piece of protocol work on the thread that owns the window's webview.
///
/// `None` when the closure could not be posted, or when the webview has no
/// `CoreWebView2` to give (a window being torn down, or a runtime too old to expose
/// one). The closure's own answer is unwrapped from the same option, so a caller that
/// wants a plain value uses `unwrap_or_default` and the ones that want a verdict see
/// the difference.
#[cfg(windows)]
pub(crate) fn with_core<T, F>(window: &tauri::WebviewWindow, work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&ICoreWebView2) -> T + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel();
    // `with_webview` returns as soon as it has posted the closure; the answer comes
    // back on the channel below.
    let posted = window.with_webview(move |platform| {
        let core = unsafe { platform.controller().CoreWebView2() };
        let answer = core.ok().map(|core| work(&core));
        let _ = sender.send(answer);
    });
    if posted.is_err() {
        return None;
    }
    receiver.recv().ok().flatten()
}

/// Send one protocol call and wait for its answer.
///
/// The completion handler fires on this thread — the one that owns the webview — so the
/// wait has to keep that thread's message pump turning or the answer could never
/// arrive. `wait_with_pump` is the helper wry uses for the same reason while it creates
/// a webview environment.
#[cfg(windows)]
pub(crate) fn call(core: &ICoreWebView2, method: &str, params: &str) -> Option<String> {
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
