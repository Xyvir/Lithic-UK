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

/// The operating system this build is running on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    Linux,
    Macos,
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
        // The three webview capabilities below are the flag side of the `#[cfg(windows)]`
        // implementations in their own modules. They are written as the same condition
        // rather than as a bare `true` so that implementing one on Linux is a change in
        // two visible places, and the test at the bottom fails until both are made.
        webview_auth: cfg!(windows),
        instance_storage_read: cfg!(windows),
        instance_storage_clear: cfg!(windows),
    }
}

/// Whether the install offer applies on this platform, for this copy.
///
/// Separate from `capabilities()` so the pairing is a function a test can drive: the offer
/// answers the platform's question and the placement question, and a copy a package manager
/// owns must lose it even on a platform where the offer exists.
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
        Os::Other => Vec::new(),
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
        Os::Macos | Os::Other => None,
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
        Os::Other => None,
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
pub fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::open_in_browser(url)
    }
    #[cfg(not(windows))]
    {
        match current() {
            Os::Macos => macos::open_in_browser(url),
            _ => linux::open_in_browser(url),
        }
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
    }

    /// What each platform can do, stated once so a change to one of these has to be a
    /// decision rather than a drift.
    #[test]
    fn each_platform_reports_what_it_can_do() {
        assert_eq!(launch_entry_kind(Os::Windows), Some("start-menu"));
        assert_eq!(launch_entry_kind(Os::Linux), Some("application-menu"));
        assert_eq!(launch_entry_kind(Os::Macos), None, "a dmg drag is the macOS install");
        assert_eq!(from_name("windows"), Os::Windows);
        assert_eq!(from_name("linux"), Os::Linux);
        assert_eq!(from_name("macos"), Os::Macos);
        assert_eq!(from_name("freebsd"), Os::Other);
        assert_eq!(current(), from_name(std::env::consts::OS));
    }
}
