//! Answering the *page's* HTTP Basic challenges from the credential vault.
//!
//! Requests this app makes itself go through reqwest, where a saved credential
//! is nothing more than an `Authorization` header — see `credential_header` in
//! `lib.rs`. The page is a different story. The webview issues its own requests:
//! the top-level navigation into an instance, and then the instance's own
//! `/sync/` WebDAV traffic. When the server answers 401, the webview asks *the
//! host application* what the credentials are, and with no answer it puts up its
//! own dialog — which is the prompt that had to be retyped on every launch.
//!
//! So this module attaches one handler to the window's webview and answers from
//! the vault. Two properties are deliberate and worth keeping:
//!
//! **It is read-only.** It never creates a vault, never asks for the secret, and
//! never runs the KDF. What it reads is the grant the launcher left behind for the
//! instance being loaded: one origin's credential, valid for a couple of minutes
//! and dropped the moment the launcher comes back. With no grant for the origin
//! being challenged — locked, expired, or never saved — the handler does nothing
//! at all and the webview falls back to its own prompt, so a locked app behaves
//! exactly as it did before any of this existed. Unlocking is the launcher's job,
//! on the launcher's thread.
//!
//! **It is synchronous, and must stay cheap.** The handler runs on the UI thread
//! while the webview waits: a mutex and a map lookup, microseconds. An Argon2id
//! derivation here (~64 MiB, hundreds of milliseconds) would freeze the window,
//! which is why the unlock is never reached from this path. WebView2 offers a
//! deferral for genuinely async work; this is not that.

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, app: tauri::AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_10;
    use webview2_com::BasicAuthenticationRequestedEventHandler;
    use windows::core::{Interface, HSTRING};

    // The webview lives on the main thread and so does the event registration;
    // `with_webview` hands it over and returns immediately.
    let _ = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        // `BasicAuthenticationRequested` arrived with ICoreWebView2_10 (WebView2
        // runtime 1.0.1108, mid-2021), so on an older runtime the cast fails and
        // this degrades to the built-in prompt rather than breaking the window.
        let Ok(core10) = core.cast::<ICoreWebView2_10>() else {
            return;
        };

        let handler =
            BasicAuthenticationRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let Some((user, password)) = answer(&app, &args) else {
                    // Nothing saved for this origin: leave the challenge alone.
                    return Ok(());
                };
                let response = args.Response()?;
                response.SetUserName(&HSTRING::from(user.as_str()))?;
                response.SetPassword(&HSTRING::from(password.as_str()))?;
                Ok(())
            }));

        // The webview holds the handler once added. The token is only needed to
        // remove it, and this window lives for the life of the process.
        let mut token = 0i64;
        let _ = core10.add_BasicAuthenticationRequested(&handler, &mut token);
    });
}

/// The saved credential for the origin being challenged, when there is one.
///
/// `None` covers every reason not to answer: nothing granted for this origin
/// (locked, expired, or never saved), and an address that is not an origin at all.
#[cfg(windows)]
unsafe fn answer(
    app: &tauri::AppHandle,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BasicAuthenticationRequestedEventArgs,
) -> Option<(String, String)> {
    use tauri::Manager;
    use webview2_com::take_pwstr;
    use windows::core::PWSTR;

    let mut uri = PWSTR::null();
    args.Uri(&mut uri).ok()?;
    // `take_pwstr` copies and frees the COM allocation WebView2 handed us.
    let uri = take_pwstr(uri);
    // Origin-exact, the same rule the reqwest path uses: a saved credential is
    // offered to the host it was saved for and to nothing that resembles it.
    super::credential_pair(&uri, &app.state::<super::VaultState>())
}

/// macOS and Linux keep the webview's own prompt for now.
///
/// The vault itself is portable and already serves those platforms' Rust-side
/// requests; what is missing is the webview hook, which each platform exposes
/// differently (webkit2gtk's `connect_authenticate`, and a WKWebView delegate
/// that wry does not surface). Answering nothing here is the pre-existing
/// behaviour, not a regression.
#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow, _app: tauri::AppHandle) {}
