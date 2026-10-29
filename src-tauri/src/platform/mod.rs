//! Where this app behaves differently by operating system.
//!
//! Every capability that is not the same everywhere lives here as one function with
//! one implementation per platform, all of them named the same thing, so this file
//! is the table that routes to them and the only place a reader has to look to
//! answer "what does this do on Linux". The three modules beside it are the three
//! answers, and `capabilities()` says which of them are real so the launcher can ask
//! instead of guessing.
//!
//! WHY THE LINUX AND MACOS MODULES ARE NOT `#[cfg]`-ED OUT
//!
//! The Windows implementations are the only ones that need a platform crate: COM for
//! a shell link, the registry for file associations, ShellExecuteW for the browser.
//! Linux and macOS are plain `std` throughout (a process spawn, a text file in
//! `~/.local/share/applications`), and they are compiled on every platform for one
//! reason: this project's local gate runs on the developer's Windows machine, so code
//! inside `#[cfg(not(windows))]` is code `cargo check`, `clippy` and `cargo test`
//! never see. Compiling them unconditionally is what lets the local gate lint them
//! and the unit tests below exercise them, instead of leaving the first Linux user to
//! find out. Only the FFI bodies inside `windows.rs` are conditional.
//!
//! WHAT IS NOT IN HERE: the three webview capabilities. `webview_auth` (answering the
//! page's own HTTP Basic challenges), `instance_search::read_caches` (reading another
//! origin's caches) and `instance_copy::forget` (dropping a copy this app downloaded)
//! are per-platform hooks rather than functions, each already carrying an honest
//! `#[cfg(not(windows))]` answer of its own. They are reported through `capabilities()`
//! so nothing offers a capability this platform does not have, and a unit test fails if
//! a flag and its implementation ever disagree.

// Public because `lib.rs` names it when it registers the bridge plugin: the plugin is this
// module's Kotlin half, and registering it is the one call that cannot be routed by platform
// name (it exists everywhere, and owns nothing off Android).
pub mod android;
mod documents;
mod linux;
mod macos;
#[cfg(windows)]
mod windows;

// The shell-link writer is exposed to the crate so its format test can stay beside the
// scratch-folder helper it shares with the other Rust tests in `lib.rs`. Test-only, hence
// the second condition: nothing outside a test build names it.
#[cfg(all(windows, test))]
pub(crate) use windows::write_shell_link;

use std::path::{Path, PathBuf};

use tauri_plugin_fs::FilePath;

/// A document this app may read and write, named the way the platform names it.
///
/// A path on every desktop, and a `content://` reference on Android, where the platform's own
/// chooser is asked for the file and the app keeps that grant across restarts. The launcher
/// treats it as an opaque string either way: it is what a recents row carries and what a save is
/// aimed at, and only this module knows which shape it is.
pub type Document = FilePath;

/// The operating system this build is running on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    Linux,
    Macos,
    /// Android, which is a platform with answers of its own rather than a desktop one
    /// under another name: the folder model is the phone's, there is no copy of the
    /// program to place beside the user's liths, and the app's own folder is a fact about
    /// the installed package rather than a path a person can be shown. Named rather than
    /// left to `Other` for the same reason the other three are: the launcher asks what a
    /// platform can do, and "the Android build" is one of the answers it can be given.
    Android,
    /// A platform with no implementation here yet. Named rather than refused, so a build
    /// for one still compiles and the launcher says what it can and cannot do.
    Other,
}

/// Map a `std::env::consts::OS` name onto this enum. Split out so a test can ask for a
/// platform that is not the one it is running on.
pub fn from_name(name: &str) -> Os {
    match name {
        "windows" => Os::Windows,
        "linux" => Os::Linux,
        "macos" => Os::Macos,
        "android" => Os::Android,
        _ => Os::Other,
    }
}

/// The platform this process is on.
pub fn current() -> Os {
    from_name(std::env::consts::OS)
}

/// What the running build can actually do, as the launcher's own vocabulary.
///
/// Asked rather than assumed: the same launcher bundle ships to the desktop app on every
/// platform, so the only honest way for it to know whether an Install button means
/// anything is to ask the side that knows. Read one flag and one noun per row, never a
/// platform name, so a new platform is a row here rather than a branch in the page.
#[derive(serde::Serialize)]
pub struct Capabilities {
    /// The platform's own name, for diagnostics.
    pub os: &'static str,
    /// This app can place a launchable copy of itself somewhere the user will find it.
    ///
    /// False where the platform installs by other means (a Mac drag out of a disk image)
    /// and false where a package manager has placed this copy already, because the offer
    /// is a second installer and one is enough.
    pub install: bool,
    /// Which launch mechanism installing creates here, when it creates one: `start-menu`
    /// or `application-menu`. A token rather than a noun because the noun is a
    /// translation, and this side cannot know the language any more than the page can know
    /// the platform. `None` where installing creates no entry at all.
    pub launch_entry: Option<&'static str>,
    /// A folder on this machine can be backed up to GitHub by this build: the git half
    /// of the sync is compiled in and the commands behind it work.
    ///
    /// False on Android alone, and the reason is a dependency rather than a platform:
    /// `git2`'s `https` feature asks for OpenSSL on every unix, so carrying the sync
    /// there would mean cross-compiling OpenSSL once per phone ABI, and the folder model
    /// it backs up is not one a phone has (see the `android` table in `Cargo.toml`, and
    /// `gitcore_unsupported` for what the crate says instead). The launcher asks this
    /// before it offers a backup, the same way it asks `install` before it offers an
    /// install.
    pub git_sync: bool,
    /// This build carries the credential vault: an instance login can be saved, listed, and
    /// lent to an instance load.
    ///
    /// False on Android alone, and the reason is where an instance is opened there rather than
    /// what the phone can do. A bookmarked instance is handed to the platform's own browser on
    /// Android (`instance_auth`), because the webview implements no `onReceivedHttpAuthRequest`
    /// and cancels the challenge: that browser has its own password manager, which is where a
    /// login for a page the app does not host belongs. Offering the vault there too would be a
    /// second, app-owned copy of a secret for a page the app never shows, with its own PIN to
    /// set and forget. Windows keeps the vault because there the app *is* the window the
    /// instance is opened in (`webview_auth.rs` answers its challenges).
    ///
    /// Stated as this flag rather than as an `android` test in the page, for the reason the
    /// three webview flags above are: the launcher asks what this build can do instead of
    /// guessing about a platform it cannot see.
    pub credentials: bool,
    /// This app has documents of its own: the picker hands one over and the app can read and
    /// write it.
    ///
    /// True on every platform this app ships to, and the flag is kept because the two halves it
    /// used to bundle have come apart. It once meant "a path": false on Android, whose chooser
    /// answers with a `content://` document reference rather than a path, which left the launcher
    /// storing the document in the app's own browser storage instead. A phone now opens and saves
    /// a real document the same way a desktop does, through this app's own picker and its own
    /// write, so what the launcher asks is whether there is anywhere for a document to go at all.
    /// Whether that document is a path or a granted reference is `references_not_paths`, which is
    /// the question the two commands that touch the file system actually need answered.
    pub local_files: bool,
    /// This platform's own webview can answer a bookmarked instance's login challenge, so the
    /// app's window can host one.
    ///
    /// False on Android alone, and it is the webview rather than a missing feature: the
    /// Android webview implements no `onReceivedHttpAuthRequest` (wry's own client says the
    /// same), so a challenge from an instance behind a login is cancelled, and the window
    /// lands on Chromium's own error page with the launcher that handed it over already gone.
    ///
    /// The launcher reads this before it hands a bookmarked address to its own window, and
    /// where it is false the address goes to the platform's browser instead
    /// (`platform::open_in_browser`), which is where the login already lives and where the
    /// instance can be kept as an app of its own. Stated as a flag so the page asks rather
    /// than tests for a platform, like every other row of this table.
    pub instance_auth: bool,
    /// Opening a `.lith` from the file manager can reach this app.
    pub file_associations: bool,
    /// The folder a file was installed into can be opened in the platform's own file
    /// manager, with that file selected where the platform can do so.
    pub reveal: bool,
    /// The webview's own authentication prompts are answered from the vault.
    pub webview_auth: bool,
    /// Another instance's caches can be read out of this profile.
    pub instance_storage_read: bool,
    /// A copy this app downloaded of one origin can be dropped.
    pub instance_storage_clear: bool,
    /// A Chromium browser is installed, so the flash offer can leave this app for one.
    ///
    /// The fallback route. Where the window's webview implements Web Serial (a Chromium tab does,
    /// and so does a current WebView2, which draws its own chooser) the offer flashes in place;
    /// where it does not (WKWebView, WebKitGTK, an older WebView2) the offer hands the same page
    /// to a Chromium browser at `?flash=1` (`flash_in_browser`), which is a real browser and
    /// brings a chooser the write can rely on. False means there is no handoff to offer; with no
    /// serial in the window either, nothing is offered at all, because a button whose only
    /// outcome is a failure is worse than no button (the rule the install offer already follows).
    pub flash_browser: bool,
}

/// The name `capabilities()` reports, which is the platform and not the enum.
fn os_name() -> &'static str {
    std::env::consts::OS
}

pub fn capabilities() -> Capabilities {
    let os = current();
    Capabilities {
        os: os_name(),
        install: install_supported(os, package_managed()),
        launch_entry: launch_entry_kind(os),
        file_associations: cfg!(any(windows, target_os = "linux")),
        reveal: cfg!(any(windows, target_os = "linux", target_os = "macos")),
        // The one flag here read from a dependency rather than from the platform name: what
        // it reports is whether libgit2 is in this build, and on every target but Android
        // it is.
        git_sync: cfg!(not(target_os = "android")),
        // The two answers that follow where a document can go. See `Capabilities::credentials`
        // for why the vault stops at the platform that hands instances to a browser, and
        // `Capabilities::local_files` for why the document flag no longer stops at Android.
        credentials: cfg!(not(target_os = "android")),
        local_files: true,
        // A phone's webview cannot answer a Basic challenge (see `Capabilities::instance_auth`),
        // so an instance behind a login is handed to the platform's browser there instead of
        // being opened in this app's own window.
        instance_auth: cfg!(not(target_os = "android")),
        // The three webview capabilities below are the flag side of the `#[cfg(windows)]`
        // implementations in their own modules. They are written as the same condition
        // rather than as a bare `true` so that implementing one on Linux is a change in
        // two visible places, and the test at the bottom fails until both are made.
        webview_auth: cfg!(windows),
        instance_storage_read: cfg!(windows),
        instance_storage_clear: cfg!(windows),
        // Asked rather than assumed, and asked once per report: the answer is a handful of
        // `is_file` checks, and the launcher reads the flag once at boot.
        flash_browser: flash_browser().is_some(),
    }
}

/// Whether the install offer applies on this platform, for this copy.
///
/// Separate from `capabilities()` so the pairing is a function a test can drive: the offer
/// answers the platform's question and the placement question, and a copy a package manager
/// owns must lose it even on a platform where the offer exists.
/// Which documents the user chose, or `None` where the picker was dismissed.
///
/// Android's answer is `android.rs` -- the platform's own chooser, whose grant this app keeps --
/// and every desktop reaches the dialog plugin, which is a native panel on each of them
/// (`documents.rs`). The answer is a reference rather than a path on the phone and a path on
/// every desktop, which is what `Document` means.
pub fn pick_documents(app: &tauri::AppHandle, multiple: bool) -> Result<Option<Vec<Document>>, String> {
    match current() {
        Os::Android => android::pick(app, multiple),
        _ => documents::pick(app, multiple),
    }
}

/// Ask where a new document should go, and answer with the one that was made.
pub fn pick_save_document(
    app: &tauri::AppHandle,
    suggested_name: &str,
) -> Result<Option<Document>, String> {
    match current() {
        Os::Android => android::pick_save(app, suggested_name),
        _ => documents::pick_save(app, suggested_name),
    }
}

/// A document's text, read by whichever side of this table can reach it.
pub fn read_document(app: &tauri::AppHandle, document: &str) -> Result<String, String> {
    match current() {
        Os::Android => android::read(app, document),
        _ => documents::read(document),
    }
}

/// Replace a document's text.
pub fn write_document(app: &tauri::AppHandle, document: &str, text: &str) -> Result<(), String> {
    match current() {
        Os::Android => android::write(app, document, text),
        _ => documents::write(document, text),
    }
}

/// A document's bytes, base64-encoded, for the one file this app opens without reading it
/// as text.
///
/// Android has no answer and says so rather than guessing: its picker hands back a
/// `content://` reference whose reader returns a string (`android::read`), and the PDF
/// association this serves is a desktop gesture to begin with. Every desktop goes through
/// `documents`, which reads the bytes and encodes them for the IPC bridge.
pub fn read_document_base64(document: &str) -> Result<String, String> {
    match current() {
        Os::Android => Err("this platform cannot read a document's bytes".to_string()),
        _ => documents::read_base64(document),
    }
}

/// The name a row shows for a document.
pub fn document_name(app: &tauri::AppHandle, document: &str) -> String {
    match current() {
        Os::Android => android::name(app, document),
        _ => documents::name(document),
    }
}

/// Write `text` where this platform puts a download, answering the path it took.
///
/// One row rather than two, because the folder is the platform's question and everything after
/// it is the same everywhere it exists: a name is chosen beside what is already there and the
/// file is created (`documents::create_download`). What `download_dir` answers decides the rest,
/// and on Android it answers nothing: a phone's storage is app-private, so a file written into it
/// is a file the person cannot find, and the picker's grant is the only route there. That case is
/// an error rather than a silent nothing, which is what sends the launcher back to its dialog.
pub fn download_document(suggested_name: &str, text: &str) -> Result<PathBuf, String> {
    match download_dir() {
        Some(folder) => documents::create_download(&folder, suggested_name, text),
        None => Err("This platform has no Downloads folder to write to".to_string()),
    }
}

/// The folder this platform puts downloads in, or nothing where the app may not write there.
pub fn download_dir() -> Option<PathBuf> {
    match current() {
        Os::Android | Os::Other => None,
        _ => documents::download_dir(),
    }
}

/// The board this app was asked to open, if it was asked, and only once.
///
/// Android alone has an answer, and it is not a capability the page can read from
/// `capabilities()`: a hand-off is something that happened, not something the platform can do. A
/// tap in a board's sign-in window reaches this app as a `lithic://` address on its launch intent,
/// which `android.rs` keeps and hands over here exactly once so that coming back from the board
/// does not send the window there again.
///
/// Every desktop answers `None`, which is also what a phone that was started normally answers.
pub fn take_deep_link(app: &tauri::AppHandle) -> Option<String> {
    match current() {
        Os::Android => android::take_deep_link(app),
        _ => None,
    }
}

/// Something another app shared with this one, as the platform's own share sheet carried it.
///
/// Two fields because a share has two halves and they are not interchangeable: the content is
/// what the person asked to send, and the title is what the sending app chose to call it, which
/// is often the better name for a note (a browser shares a page's own title beside its address).
/// Both are strings as the sending app wrote them, unparsed and untrimmed, because what a share
/// becomes is one decision and it lives on the launcher's side (`sharedPayload` in
/// `pending-imports.ts`). Either may be empty, which is why both are plain strings rather than an
/// `Option`: an absent extra and an empty one are the same nothing, and the launcher already
/// treats them that way.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SharedText {
    /// The content that was shared. A link arrives here as text, because that is what the share
    /// sheet carries and the platform never resolves one into anything else.
    pub text: String,
    /// The title the sending app offered, or the empty string when it offered none.
    pub title: String,
}

/// What another app shared with this app, if anything did, and only once.
///
/// The same shape as `take_deep_link` and for the same reason: a share is something that
/// happened rather than something a platform can do, so this is not a row in `capabilities()`, and
/// reading it consumes it so a reload of the launcher is not handed the same share twice.
///
/// Android alone has an answer: the share sheet is its own mechanism, and `android.rs` keeps what
/// `MainActivity` took off the intent. Every desktop answers `None`, where a shared link or a
/// selected paragraph reaches an app by other means (a paste, a file association) than a sheet
/// this app appears in.
pub fn take_shared_text(app: &tauri::AppHandle) -> Option<SharedText> {
    match current() {
        Os::Android => android::take_shared_text(app),
        _ => None,
    }
}

/// Whether a pick on this platform answers with a reference rather than a path.
///
/// True on Android alone, where the platform's chooser hands over a `content://` URI whose grant
/// this app keeps, and false everywhere a document is a path. `lib.rs` reads it before it treats
/// a document as a file on disk, which is a test a reference would always fail.
pub fn references_not_paths() -> bool {
    match current() {
        Os::Android => android::references_not_paths(),
        _ => false,
    }
}



fn install_supported(os: Os, package_managed: bool) -> bool {
    matches!(os, Os::Windows | Os::Linux) && !package_managed
}

/// Whether something other than this app placed the copy that is running: a package manager,
/// a distribution, or a sandbox.
///
/// Asked because the app's Install offer is a *second installer*. It copies the program into
/// `Documents/Lithic` and writes a menu entry, which is the right answer for a portable copy
/// and the wrong one for a copy `apt`, `winget`, `brew`, flatpak or snap has already placed
/// and will itself update: two installers on one app, and the copy that loses is the one that
/// lands somewhere the manager does not know about. Where a manager owns the copy, the app
/// offers nothing and leaves the newer release to it.
///
/// The update offer needs no separate check here. It is gated on the same install record
/// (`launched_from_install`), and the first clause below makes it structurally impossible for
/// a copy a manager placed to satisfy it: the record is `Documents/Lithic`, which is where
/// this app puts things and no manager does.
///
pub fn package_managed() -> bool {
    !launched_from_install() && package_managed_in(current(), &placement())
}

/// The evidence a placement decision is made from, named so a test can supply it rather than
/// have to be a machine where the answer is true.
struct Placement {
    image: Option<PathBuf>,
    /// A sandbox is a package manager's own container, and the path inside it says nothing
    /// about who placed the app. The marker says everything.
    flatpak: bool,
    snap: bool,
    /// The roots the system owns on this platform. A copy under one of them was placed by
    /// the distribution or by an installer, rather than unpacked by hand somewhere of the
    /// user's own choosing.
    roots: Vec<PathBuf>,
}

fn placement() -> Placement {
    Placement {
        image: running_image(),
        flatpak: Path::new("/.flatpak-info").is_file(),
        snap: std::env::var_os("SNAP").is_some_and(|value| !value.is_empty()),
        roots: system_roots(current()),
    }
}

/// The locations a distribution or an installer owns, per platform.
///
/// Not a list of package managers, because the question is not which one it was: it is
/// whether this copy is somewhere the system is responsible for. `%LOCALAPPDATA%\Programs`
/// is in the Windows list because it is winget's per-user default, and it is also this app's
/// own fallback when there is no Documents folder, which is what the install record is for
/// and why `package_managed` asks it first.
fn system_roots(os: Os) -> Vec<PathBuf> {
    match os {
        Os::Windows => ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
            .chain(std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("Programs")))
            .collect(),
        Os::Linux => ["/usr", "/opt", "/nix/store", "/snap", "/var/lib/flatpak"]
            .iter()
            .map(PathBuf::from)
            .collect(),
        Os::Macos => ["/Applications", "/System/Applications"]
            .iter()
            .map(PathBuf::from)
            .collect(),
        // Android has no such root, and needs none: an app arrives as a package rather
        // than as a file somebody placed, so there is nothing here that a distribution or
        // an installer could be said to own.
        Os::Android | Os::Other => Vec::new(),
    }
}

fn package_managed_in(os: Os, placement: &Placement) -> bool {
    if placement.flatpak || placement.snap {
        return true;
    }
    let Some(image) = placement.image.as_deref() else {
        return false;
    };
    placement.roots.iter().any(|root| under(root, image, os))
}

/// Whether `path` sits inside `root`, at a component boundary.
///
/// Compared as text rather than with `Path::starts_with`, because the paths being judged
/// may belong to a platform other than the one doing the judging: the test suite reads
/// Windows locations on a Linux build, and `Path` would parse `C:\Program Files` by the
/// host's rules and see one long component with a backslash in it. So separators are folded
/// to `/` and case is folded on the two platforms whose filesystems fold it, which is what
/// the location actually means.
///
/// The separator is part of the comparison, so `/usrfoo` is not under `/usr`. The root
/// itself is never a file, so equality is not a match.
fn under(root: &Path, path: &Path, os: Os) -> bool {
    let fold = |value: &Path| {
        let text = value.to_string_lossy().replace('\\', "/");
        let text = text.trim_end_matches('/').to_string();
        if matches!(os, Os::Windows | Os::Macos) {
            text.to_lowercase()
        } else {
            text
        }
    };
    let root = fold(root);
    !root.is_empty() && fold(path).starts_with(&format!("{}/", root))
}

/// Which launch mechanism installing creates on this platform, or `None` where it creates
/// nothing.
///
/// macOS is `None` on purpose rather than for want of an implementation: a Mac
/// distribution is a `.dmg` holding a `.app` beside a link to `/Applications`, and
/// dragging the app there *is* the install. An app that also copied itself into
/// `~/Documents` would be a second copy of a bundle the user already placed, launched
/// from a folder they did not choose.
fn launch_entry_kind(os: Os) -> Option<&'static str> {
    match os {
        Os::Windows => Some("start-menu"),
        Os::Linux => Some("application-menu"),
        // Android is `None` for macOS' reason and a simpler one: what makes an app
        // launchable on a phone is the installed package itself, written by the store or
        // by the phone's installer, so an app that also placed a copy would be a second
        // install of an app the platform already owns.
        Os::Macos | Os::Android | Os::Other => None,
    }
}

/// The folder the app installs into and keeps its liths in.
///
/// One rule on every platform, because it answers one question: where would a person
/// look for their own files without being told. `dirs::document_dir()` is each
/// platform's own rule for that folder (the Documents known folder on Windows,
/// `XDG_DOCUMENTS_DIR` on Linux, `~/Documents` on macOS) and answers `None` on a
/// machine where nobody ever set one up, which is why there are two fallbacks rather
/// than a guess.
pub fn install_dir() -> Option<PathBuf> {
    install_dir_on(
        current(),
        dirs::document_dir(),
        dirs::data_local_dir(),
        dirs::home_dir(),
    )
}

/// The same decision with its inputs named, so a test can drive every platform's
/// answer from this one.
///
/// The middle candidate is the one place the platforms genuinely differ: Windows keeps
/// user programs in `%LOCALAPPDATA%\Programs`, and a Linux or macOS app has no such
/// convention, so there the local data folder is itself the fallback.
fn install_dir_on(
    os: Os,
    documents: Option<PathBuf>,
    data_local: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    let fallback = match os {
        Os::Windows => data_local.map(|local| local.join("Programs")),
        Os::Linux | Os::Macos | Os::Other => data_local,
        // Android is handed the documents folder first like everyone else and ignores it:
        // a phone's Documents is a shared folder an app reaches a file at a time through
        // the platform's own picker, never a folder a program writes in, so the library is
        // the app's own data folder or it is nowhere. A machine with nothing to name
        // answers `None` rather than a home folder that would not be writable either.
        Os::Android => return data_local.map(|data| data.join("Lithic")),
    };
    documents
        .or(fallback)
        .or(home)
        .map(|base| base.join("Lithic"))
}

/// The install target: the launchable file the app copies itself to.
///
/// The name differs by platform and so does what is being copied, which is the point of
/// asking rather than building a path from a literal. On Linux the running file may be
/// an AppImage (see `running_image`), and copying that is the only copy that still runs:
/// the executable inside the mount is a mount path, and it is gone after a reboot.
pub fn install_target() -> Option<PathBuf> {
    install_target_on(current(), install_dir()?, appimage())
}

fn install_target_on(os: Os, dir: PathBuf, appimage: Option<PathBuf>) -> Option<PathBuf> {
    match os {
        Os::Windows => Some(dir.join("Lithic.exe")),
        Os::Linux => Some(if appimage.is_some() {
            dir.join("Lithic.AppImage")
        } else {
            dir.join("Lithic")
        }),
        Os::Macos => Some(dir.join("Lithic.app")),
        // Nothing to copy on a phone, and nowhere to copy it to: an app is placed by the
        // package the platform installed, and the code that runs lives inside it.
        Os::Android | Os::Other => None,
    }
}

/// The file this process is actually running from.
///
/// On Linux an AppImage runs as an executable extracted into a temporary mount, and
/// `current_exe` answers with the path inside that mount. The AppImage runtime sets
/// `$APPIMAGE` to the file the user launched, which is the one worth copying, comparing
/// and updating, so it outranks `current_exe` where it is set.
pub fn running_image() -> Option<PathBuf> {
    appimage().or_else(|| std::env::current_exe().ok())
}

fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The folder the program is carried in: the running executable's own folder, or, on macOS,
/// the folder holding the bundle that executable is inside.
///
/// This is what "beside the program" means everywhere else in the crate — where a portable
/// copy keeps its state, where its liths are looked for, and the last place a dialog starts
/// looking — and it is one function because macOS is the one platform where the executable's
/// folder is not the folder a person moves. A Mac program is a bundle: `Lithic.app` holds
/// `Contents/MacOS/Lithic`, the levels between the binary and the thing a user drags, copies
/// or unplugs *are* the program, and the folder beside the bundle is what travels with it.
pub fn program_dir() -> Option<PathBuf> {
    program_dir_on(current(), running_image()?)
}

/// The same decision with its input named, so a test can drive every platform's answer from
/// this one — the shape `install_dir_on` and `install_target_on` already use.
fn program_dir_on(os: Os, image: PathBuf) -> Option<PathBuf> {
    if matches!(os, Os::Macos) {
        return bundle_parent(&image).or_else(|| parent_dir(&image));
    }
    parent_dir(&image)
}

fn parent_dir(image: &Path) -> Option<PathBuf> {
    image.parent().map(Path::to_path_buf)
}

/// The folder holding the `.app` bundle `image` sits inside, when it sits inside one.
///
/// Found by walking up rather than by counting the components of a bundle's layout: the
/// count is a fact about Tauri's bundle and the search is a fact about macOS. A run that is
/// not inside a bundle at all — `cargo run` from a checkout — finds none and answers `None`,
/// so the plain rule still applies there.
fn bundle_parent(image: &Path) -> Option<PathBuf> {
    image
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

/// The folder this copy keeps its own state in: the vault, and the portable sidecar
/// (`recents.txt`, which also carries the picked backup folder and the install offer's
/// dismissal). Created here when it is not there yet, because both of its writers assume
/// their folder exists.
///
/// Windows and Linux keep the rule they have always had — beside the program — and that is
/// deliberate rather than incidental: it is what makes a folder of liths, the program and its
/// state one portable neighbourhood that a thumb drive carries whole.
///
/// macOS cannot have that rule, and the concession is contained here rather than borrowed
/// back into the other two. A Mac program is a bundle, so "beside the executable" means
/// *inside* the app, and state written there is state the next install replaces: a cask
/// upgrade swaps the whole bundle and a hand-dragged newer copy does the same. Writing into
/// the program is wrong in two more ways that do not depend on brew — a bundle that has had
/// files added to it is a bundle whose signature no longer matches, and a quarantined run is
/// translocated to a read-only path where the writes fail instead. So on macOS the question
/// becomes which kind of copy is running. A bundle parked in an Applications folder
/// (`/Applications` for a drag or a cask, `~/Applications` for one a user keeps of their
/// own) is an installed app, and an installed app's state belongs to its user, in
/// `~/Library/Application Support/Lithic`. A bundle in a folder that cannot be written — a
/// read-only mounted disk image, a translocated quarantine copy — has nowhere to keep it
/// either, and takes the same answer. A bundle anywhere else is a copy somebody is carrying,
/// and it keeps its state beside itself: the portable rule, kept in the one place macOS
/// still allows it.
pub fn state_dir() -> Option<PathBuf> {
    STATE_DIR
        .get_or_init(|| {
            let beside = program_dir();
            // Asked once per process: the answer cannot change while the app runs, and the
            // probe creates and removes a file in a folder that may be somebody's Desktop.
            //
            // Only macOS runs it. Windows and Linux do not ask this question — their
            // answer is `beside`, whatever the folder can do — so probing there would be a
            // write nobody asked for, in a folder that is also the folder a backup
            // commits from.
            let writable = matches!(current(), Os::Macos)
                && beside.as_deref().is_some_and(crate::dir_writable);
            let dir = state_dir_on(current(), beside, dirs::data_dir(), writable)?;
            let _ = std::fs::create_dir_all(&dir);
            Some(dir)
        })
        .clone()
}

/// The one answer per process `state_dir` caches. Every command that touches the sidecar or
/// the vault asks this question, and none of them is asking about a different copy.
static STATE_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// The same decision with its inputs named, so a test can drive every platform's answer
/// without being on it.
fn state_dir_on(
    os: Os,
    beside: Option<PathBuf>,
    app_data: Option<PathBuf>,
    beside_writable: bool,
) -> Option<PathBuf> {
    // Android is the second platform where "beside the program" is not a folder the user
    // is shown, and the more severe case of it: a phone app's executable lives inside the
    // installed package, which the next update replaces and which the app may not write in
    // at all. So it keeps its state where the platform says an app keeps it, and answers
    // `None` when the process cannot name that folder, which every caller already reads as
    // "there is no sidecar and no vault on this machine" rather than as an error.
    if matches!(os, Os::Android) {
        return app_data.map(|dir| dir.join("Lithic"));
    }
    if !matches!(os, Os::Macos) {
        return beside;
    }
    let installed = beside.as_deref().is_some_and(is_applications_folder) || !beside_writable;
    if installed {
        return app_data.map(|dir| dir.join("Lithic"));
    }
    beside
}

/// Whether a folder is one a Mac parks a bundle in rather than carries it in.
///
/// By name rather than by a list of known locations: `/Applications`, `/System/Applications`
/// and the `Applications` folder in a user's home are all called this, and a copy that ends
/// up treated as installed has lost nothing — it simply keeps its state where an installed
/// app keeps it.
fn is_applications_folder(dir: &Path) -> bool {
    dir.file_name().is_some_and(|name| name == "Applications")
}

/// Whether this process is the installed copy: the same file, not merely the same bytes.
pub fn launched_from_install() -> bool {
    let Some(target) = install_target() else {
        return false;
    };
    let Some(running) = running_image() else {
        return false;
    };
    match (std::fs::canonicalize(running), std::fs::canonicalize(target)) {
        (Ok(running), Ok(target)) => running == target,
        _ => false,
    }
}

/// Open an http(s) address in the platform's own browser.
///
/// The app handle is a parameter because one platform has nothing to spawn for this: Android's
/// browser is an activity the platform starts on the app's behalf, which is a plugin call rather
/// than a shell command (`tauri-plugin-opener`).
pub fn open_in_browser(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Android's answer is the only one that reads the handle: every desktop spawns.
        let _ = app;
        windows::open_in_browser(url)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Android => android::open_in_browser(app, url),
            Os::Macos => macos::open_in_browser(url),
            _ => linux::open_in_browser(url),
        }
    }
}

/// The Chromium browser on this machine that can reach a serial port, when one is installed.
///
/// Chrome, Chromium and Edge are the three that implement Web Serial; where each platform keeps
/// its copies is that platform's own module's business, and the order within a module's list is
/// a preference rather than a requirement (a machine with two is a machine with two).
///
/// This is the flash offer's fallback route out of the desktop app. Where the window's webview
/// implements Web Serial the offer flashes in place; WKWebView and WebKitGTK implement none of
/// it, and an older WebView2 may not either, so the offer hands that browser the launcher page
/// with `?flash=1` on it.
///
/// `None` is the honest answer everywhere else, including Android: a phone has no such handoff
/// (the page would be a file inside this app's sandbox), and its webview is not a browser
/// either.
pub fn flash_browser() -> Option<PathBuf> {
    // One match with a `cfg` arm, rather than a `cfg` block per platform. A block per platform is
    // only compiled on the host of the build, so a variant left out of the non-Windows block is
    // invisible to this project's Windows gate and first fails on CI; written this way, each
    // build type-checks the whole decision and names every platform it is not.
    match current() {
        #[cfg(windows)]
        Os::Windows => windows::flash_browser(),
        #[cfg(not(windows))]
        Os::Windows => None,
        Os::Macos => macos::flash_browser(),
        Os::Linux => linux::flash_browser(),
        Os::Android | Os::Other => None,
    }
}

/// The first candidate that is actually a file on this machine.
///
/// Every platform's discovery is the same shape: a list of places the browser is installed, in
/// the order a person would look, and the first one that exists. Shared here so the three
/// modules differ in their lists rather than in the rule.
pub(super) fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|candidate| candidate.is_file()).cloned()
}

/// Open an address in one named browser rather than in the platform's default.
///
/// Not routed by platform, because it is the same call on all three desktops: the path is the
/// browser's own executable (`chrome.exe`, `Contents/MacOS/Google Chrome`, `/usr/bin/chromium`),
/// so starting it with the address as its only argument is what the shell does too. The streams
/// are detached: the browser's output is not ours to show and a dialog is not a terminal.
pub fn open_in_named_browser(browser: &Path, url: &str) -> Result<(), String> {
    let spawned = std::process::Command::new(browser)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("{} could not be opened: {error}", browser.display())),
    }
}

/// Show a file in the platform's own file manager, selected where that is possible.
///
/// Best effort by design: the install itself already succeeded, and a machine with no
/// file manager is not a failed install. Every answer is a `Result` only so the caller
/// can decide whether to mention it.
pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::reveal(path)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Macos => macos::reveal(path),
            _ => linux::reveal(path),
        }
    }
}

/// Make a copied program launchable and reachable from the platform's own launcher.
///
/// `program` is the installed copy, not the running one: every entry this writes points
/// at the copy, so an entry survives the original being moved or deleted.
pub fn install_launch_entry(program: &Path) -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        windows::install_launch_entry(program)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Macos => macos::install_launch_entry(program),
            _ => linux::install_launch_entry(program),
        }
    }
}

/// Make a copied program runnable on this platform.
///
/// A no-op on both desktop platforms where the file arrives runnable (an `.exe` and a
/// bundle's Mach-O), and the executable bit on Linux, where a copy of a release download
/// may not have one.
pub fn make_launchable(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::make_launchable(path)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Macos => macos::make_launchable(path),
            _ => linux::make_launchable(path),
        }
    }
}

/// Register this app with the platform's "open with" machinery for the file types it
/// edits. Windows adds an Open With entry per extension; Linux declares them in the
/// desktop entry the launch entry already wrote; macOS declares them in the bundle's
/// own `Info.plist`, which is not something a running app writes.
pub fn register_file_associations(program: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::register_file_associations(program)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Macos => macos::register_file_associations(program),
            _ => linux::register_file_associations(program),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every platform's install folder is decided by the same rule, and the one
    /// difference is where a program folder comes from when there is no Documents
    /// folder to put it in.
    #[test]
    fn the_install_folder_is_documents_then_the_platforms_own_program_folder() {
        let docs = Some(PathBuf::from("/docs"));
        let local = Some(PathBuf::from("/local"));
        let home = Some(PathBuf::from("/home/u"));

        assert_eq!(install_dir_on(Os::Windows, docs.clone(), local.clone(), home.clone()), Some(PathBuf::from("/docs/Lithic")));
        assert_eq!(install_dir_on(Os::Linux, docs.clone(), local.clone(), home.clone()), Some(PathBuf::from("/docs/Lithic")));
        assert_eq!(install_dir_on(Os::Macos, docs.clone(), local.clone(), home.clone()), Some(PathBuf::from("/docs/Lithic")));
        // Android is offered the same Documents folder and does not use it: a phone hands
        // an app a shared folder through its own picker, one file at a time, never as a
        // folder to write a library into. So the app's own data folder is the answer, and
        // nothing is the answer when the process cannot name one.
        assert_eq!(install_dir_on(Os::Android, docs.clone(), local.clone(), home.clone()), Some(PathBuf::from("/local/Lithic")));
        assert_eq!(install_dir_on(Os::Android, docs.clone(), None, home.clone()), None, "a home folder is not a folder a phone app may write in");

        // No Documents folder: Windows keeps user programs under Programs, and the
        // other two use the local data folder itself rather than inventing one.
        assert_eq!(install_dir_on(Os::Windows, None, local.clone(), home.clone()), Some(PathBuf::from("/local/Programs/Lithic")));
        assert_eq!(install_dir_on(Os::Linux, None, local.clone(), home.clone()), Some(PathBuf::from("/local/Lithic")));
        assert_eq!(install_dir_on(Os::Macos, None, local.clone(), home.clone()), Some(PathBuf::from("/local/Lithic")));

        // Nothing but a home folder, and nothing at all.
        assert_eq!(install_dir_on(Os::Linux, None, None, home.clone()), Some(PathBuf::from("/home/u/Lithic")));
        assert_eq!(install_dir_on(Os::Linux, None, None, None), None);
    }

    /// What gets copied differs by platform, and on Linux it differs by how the app was
    /// started: an AppImage is a file, and the executable inside its mount is not.
    #[test]
    fn the_install_target_names_the_file_that_still_runs_after_a_copy() {
        let dir = PathBuf::from("/apps/Lithic");
        assert_eq!(
            install_target_on(Os::Windows, dir.clone(), None),
            Some(PathBuf::from("/apps/Lithic/Lithic.exe"))
        );
        assert_eq!(
            install_target_on(Os::Linux, dir.clone(), None),
            Some(PathBuf::from("/apps/Lithic/Lithic"))
        );
        assert_eq!(
            install_target_on(Os::Linux, dir.clone(), Some(PathBuf::from("/tmp/Lithic.AppImage"))),
            Some(PathBuf::from("/apps/Lithic/Lithic.AppImage")),
            "an AppImage copy has to keep the extension, or the kernel stops running it as one"
        );
        assert_eq!(
            install_target_on(Os::Macos, dir.clone(), None),
            Some(PathBuf::from("/apps/Lithic/Lithic.app"))
        );
        assert_eq!(
            install_target_on(Os::Android, dir.clone(), None),
            None,
            "the phone's installer places the app, so there is nothing to copy beside it"
        );
        assert_eq!(install_target_on(Os::Other, dir, None), None);
    }

    /// The three webview capabilities are reported as what the implementations do, and
    /// this is the test that fails when a platform gains one and the flag is not moved
    /// with it. Written against `cfg!` rather than a literal so the pairing is the
    /// assertion.
    #[test]
    fn the_webview_flags_follow_their_implementations() {
        let caps = capabilities();
        assert_eq!(caps.webview_auth, cfg!(windows), "webview_auth::install is cfg(windows)");
        assert_eq!(caps.instance_storage_read, cfg!(windows), "instance_search::read_caches is cfg(windows)");
        assert_eq!(caps.instance_storage_clear, cfg!(windows), "instance_copy::forget is cfg(windows)");
        // The odd one out among these flags: a dependency rather than a platform. The
        // pairing asserted is with `Cargo.toml`'s Android table, which is the only place
        // the git half can be left out, and it is written the same way the three above are
        // so that putting libgit2 back on Android is a change in two visible places.
        assert_eq!(caps.git_sync, cfg!(not(target_os = "android")), "the git half follows git2, which Android does not link");
        // The vault stops at the platform that hands an instance to a browser rather than
        // hosting it: see `Capabilities::credentials`. Its two companions below are the flags
        // that make that handoff work.
        assert_eq!(
            caps.credentials,
            cfg!(not(target_os = "android")),
            "the vault is offered where this app is the window an instance is opened in"
        );
        assert_eq!(
            caps.instance_auth,
            cfg!(not(target_os = "android")),
            "the phone's webview cancels a Basic challenge rather than answering it"
        );
        // And the flag that no longer stops at the phone: a document can go somewhere on every
        // platform this app ships to, whether it is a path or a granted reference.
        assert!(caps.local_files, "every platform this app ships to can open and save a document");
    }

    /// The offer exists on the two platforms that install, and loses to a package manager
    /// on either of them. This is the pairing that keeps a `deb` or a `winget` copy from
    /// being offered a second, rival install.
    #[test]
    fn the_install_offer_yields_to_a_package_manager() {
        assert!(install_supported(Os::Windows, false));
        assert!(install_supported(Os::Linux, false));
        assert!(!install_supported(Os::Windows, true), "a winget copy must not offer to install itself again");
        assert!(!install_supported(Os::Linux, true), "a deb copy must not offer to install itself again");
        assert!(!install_supported(Os::Macos, false), "a Mac installs by drag, manager or not");
        assert!(!install_supported(Os::Android, false), "the phone's installer places the app, so there is no second install to offer");
        assert!(!install_supported(Os::Other, false));
    }

    /// What counts as somebody else's copy, per platform, and what does not.
    #[test]
    fn a_copy_the_system_owns_is_somebody_elses() {
        let managed = |os: Os, image: &str, roots: &[&str]| {
            package_managed_in(
                os,
                &Placement {
                    image: Some(PathBuf::from(image)),
                    flatpak: false,
                    snap: false,
                    roots: roots.iter().map(PathBuf::from).collect(),
                },
            )
        };

        // Under a root the system owns, on each platform.
        assert!(managed(Os::Linux, "/usr/bin/lithic", &["/usr"]));
        assert!(managed(Os::Linux, "/nix/store/abc-lithic/bin/lithic", &["/nix/store"]));
        assert!(managed(Os::Windows, "C:\\Program Files\\Lithic\\Lithic.exe", &["C:\\Program Files"]));
        // Windows folds case, because NTFS does: a shouted path is the same place.
        assert!(managed(Os::Windows, "c:\\program files\\lithic\\lithic.exe", &["C:\\Program Files"]));
        assert!(managed(Os::Macos, "/Applications/Lithic.app", &["/Applications"]));

        // The component boundary is part of the rule: a folder whose name merely starts
        // with a root's name is not inside it, or every user folder called /usrstuff would
        // count as the system's.
        assert!(!managed(Os::Linux, "/usrfoo/bin/lithic", &["/usr"]));
        assert!(!managed(Os::Windows, "C:\\ProgramFiles2\\Lithic.exe", &["C:\\Program Files"]));

        // A user's own copy: unpacked somewhere of their choosing, or on a thumb drive,
        // where the drive letter is the user's rather than the system's.
        assert!(!managed(Os::Linux, "/home/u/Downloads/Lithic.AppImage", &["/usr", "/opt"]));
        assert!(!managed(Os::Windows, "E:\\Lithic.exe", &["C:\\Program Files"]));
        assert!(!managed(Os::Windows, "C:\\Users\\u\\Documents\\Lithic\\Lithic.exe", &["C:\\Program Files"]));

        // A sandbox is decided by its marker, not by where the file appears to be: inside
        // one, every path looks like the app's own.
        let sandboxed = |flatpak: bool, snap: bool| {
            package_managed_in(
                Os::Linux,
                &Placement {
                    image: Some(PathBuf::from("/app/bin/lithic")),
                    flatpak,
                    snap,
                    roots: Vec::new(),
                },
            )
        };
        assert!(sandboxed(true, false), "a flatpak's copy is the flatpak's");
        assert!(sandboxed(false, true), "a snap's copy is the snap's");
        assert!(!sandboxed(false, false));

        // Nothing to judge: an unknown location is not evidence of a manager.
        assert!(!package_managed_in(
            Os::Linux,
            &Placement { image: None, flatpak: false, snap: false, roots: vec![PathBuf::from("/usr")] }
        ));
    }

    /// The rule every platform's flash-browser search shares: the first candidate that is
    /// actually a file, and nothing invented when none is. The platform modules are then lists
    /// of places rather than three implementations of a search.
    #[test]
    fn the_first_candidate_that_exists_wins() {
        let root = std::env::temp_dir().join(format!("lithic-browser-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let present = root.join("chrome");
        std::fs::write(&present, b"stub").unwrap();
        let later = root.join("chromium");
        std::fs::write(&later, b"stub").unwrap();
        let missing = root.join("edge");

        assert_eq!(
            first_existing(&[missing.clone(), present.clone(), later]),
            Some(present),
            "the first one that exists is the one that is used"
        );
        assert_eq!(first_existing(&[missing]), None, "nothing is not the same as something");
        assert_eq!(first_existing(&[]), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The folder the program travels in: the executable's own folder on every platform but
    /// one, and the folder holding the bundle on macOS, because the executable is inside the
    /// app rather than beside it.
    #[test]
    fn the_program_folder_is_the_bundles_parent_on_macos_and_the_executables_elsewhere() {
        let image = |path: &str| PathBuf::from(path);
        assert_eq!(
            program_dir_on(Os::Windows, image("/apps/Lithic/Lithic.exe")),
            Some(PathBuf::from("/apps/Lithic"))
        );
        assert_eq!(
            program_dir_on(Os::Linux, image("/home/u/Documents/Lithic/Lithic.AppImage")),
            Some(PathBuf::from("/home/u/Documents/Lithic")),
            "an AppImage's own folder is the folder it travels in, extension and all"
        );
        assert_eq!(
            program_dir_on(Os::Macos, image("/Applications/Lithic.app/Contents/MacOS/Lithic")),
            Some(PathBuf::from("/Applications"))
        );
        assert_eq!(
            program_dir_on(Os::Macos, image("/Volumes/STICK/Lithic.app/Contents/MacOS/Lithic")),
            Some(PathBuf::from("/Volumes/STICK")),
            "a bundle on a stick travels with its own folder, which is the whole portable rule"
        );
        // A run that is not inside a bundle — a checkout's `cargo run` — keeps the plain rule
        // rather than reporting the folder above some unrelated `.app` in the path.
        assert_eq!(
            program_dir_on(Os::Macos, image("/Users/u/Lithic/src-tauri/target/debug/lithic")),
            Some(PathBuf::from("/Users/u/Lithic/src-tauri/target/debug"))
        );
        assert_eq!(program_dir_on(Os::Other, image("/opt/lithic")), Some(PathBuf::from("/opt")));
    }

    /// Beside the program on the two platforms that have always done it, and the macOS
    /// concession: an installed bundle keeps its state where the platform keeps an installed
    /// app's, and a carried one keeps it beside itself.
    #[test]
    fn the_state_folder_is_beside_the_program_except_for_an_installed_mac_bundle() {
        let data = Some(PathBuf::from("/home/u/Library/Application Support"));
        let installed = PathBuf::from("/home/u/Library/Application Support/Lithic");

        // Windows and Linux: the rule is the executable's folder, and nothing about it
        // changes because the location happens to be called Applications.
        for os in [Os::Windows, Os::Linux] {
            assert_eq!(
                state_dir_on(os, Some(PathBuf::from("/apps/Lithic")), data.clone(), true),
                Some(PathBuf::from("/apps/Lithic"))
            );
            assert_eq!(
                state_dir_on(os, Some(PathBuf::from("/Applications")), data.clone(), true),
                Some(PathBuf::from("/Applications")),
                "the portable rule does not learn the word Applications from macOS"
            );
        }

        // macOS, parked in an Applications folder: installed, so the state is the user's.
        assert_eq!(
            state_dir_on(Os::Macos, Some(PathBuf::from("/Applications")), data.clone(), true),
            Some(installed.clone())
        );
        assert_eq!(
            state_dir_on(Os::Macos, Some(PathBuf::from("/Users/u/Applications")), data.clone(), true),
            Some(installed.clone())
        );

        // macOS, carried: beside the bundle, whether that is a stick, a Desktop or Downloads.
        for carried in ["/Volumes/STICK", "/Users/u/Desktop", "/Users/u/Downloads/Lithic"] {
            assert_eq!(
                state_dir_on(Os::Macos, Some(PathBuf::from(carried)), data.clone(), true),
                Some(PathBuf::from(carried))
            );
        }

        // macOS, nowhere to write: a read-only mounted image or a translocated copy has no
        // beside to write to, and the user's own folder is the answer that works.
        assert_eq!(
            state_dir_on(Os::Macos, Some(PathBuf::from("/Volumes/Lithic")), data.clone(), false),
            Some(installed.clone())
        );
        // And with no app data folder to name at all, the answer is honestly nothing.
        assert_eq!(state_dir_on(Os::Macos, Some(PathBuf::from("/Volumes/Lithic")), None, false), None);

        // Android takes the installed branch too, for a related reason: the executable's
        // folder is inside the installed package, which is not writable and does not
        // survive the next update, so the state belongs to the user's app data folder.
        assert_eq!(
            state_dir_on(Os::Android, Some(PathBuf::from("/data/app/lib/arm64")), data.clone(), true),
            Some(installed.clone()),
            "a phone's program folder is inside the installed package"
        );
        assert_eq!(
            state_dir_on(Os::Android, Some(PathBuf::from("/data/app/lib/arm64")), None, true),
            None,
            "with no folder to name, a phone build has no sidecar rather than an unwritable one"
        );
    }

    /// What each platform can do, stated once so a change to one of these has to be a
    /// decision rather than a drift.
    #[test]
    fn each_platform_reports_what_it_can_do() {
        assert_eq!(launch_entry_kind(Os::Windows), Some("start-menu"));
        assert_eq!(launch_entry_kind(Os::Linux), Some("application-menu"));
        assert_eq!(launch_entry_kind(Os::Macos), None, "a dmg drag is the macOS install");
        assert_eq!(launch_entry_kind(Os::Android), None, "the installed package is the phone's launch entry");
        assert_eq!(from_name("windows"), Os::Windows);
        assert_eq!(from_name("linux"), Os::Linux);
        assert_eq!(from_name("macos"), Os::Macos);
        assert_eq!(from_name("android"), Os::Android);
        assert_eq!(from_name("freebsd"), Os::Other);
        assert_eq!(current(), from_name(std::env::consts::OS));
    }
}
