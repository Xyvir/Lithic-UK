//! Where the shim puts a copy of itself the desktop can reach, and what that copy registers.
//!
//! A browser serves a page from a loopback address and a temporary mount, and both are gone
//! when the session ends: an AppImage launched out of `~/Downloads` runs from an extracted
//! directory, and nothing a desktop remembers about *that* file outlives a reboot. So the same
//! install the desktop app performs is performed here, in the shim's own words, because the
//! shim is the distribution and there is no Tauri behind it to ask.
//!
//! What "install" means on Linux, in one list. It is deliberately the desktop app's list, read
//! from `src-tauri/src/platform/linux.rs`, because a machine can have either distribution and
//! the two must land in the same place with the same names or one would shadow the other:
//!
//!   * Copy the AppImage the person launched to `Documents/Lithic/Lithic.AppImage`. The
//!     *running image* (`$APPIMAGE`) is the file to copy, never `current_exe`, which answers
//!     with the executable inside the temporary mount, gone at the next reboot.
//!   * Write a freedesktop desktop entry to `$XDG_DATA_HOME/applications/lithic.desktop`,
//!     pointing at the copy with `%f` so a file manager hands over the file it was opened with.
//!     That one file is also the file-association registration: its `MimeType=` line is what a
//!     desktop reads to offer "Open With Lithic".
//!   * Install the icon into the icon theme rather than pointing at a path inside the mount.
//!   * Write a `shared-mime-info` definition for `application/x-lith` and refresh the MIME
//!     database, because that type is this project's own and no distribution ships it: without
//!     the definition a `.lith` resolves to nothing and the entry is never offered for one.
//!
//! Registration is non-destructive throughout, which is the desktop app's rule too: the entry
//! adds Lithic to a type's Open With list and steals no default association.
//!
//! What is missing on purpose: revealing the installed file in a file manager. The desktop app
//! opens the folder after installing, but this distribution's whole premise is a browser window
//! and no second one, so the launcher's own line ("Installed to ...") is the whole report. The
//! rule for a copy a package manager owns is the desktop app's as well and is not repeated here:
//! a shim is an AppImage the person downloaded, so there is no manager to yield to.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::command::{failed, failed_with, ok, path_text};
use crate::{data_home, home_dir, Response, APP_WINDOW_CLASS};

/// The file name of the desktop entry. The same name the desktop app writes, so one install
/// replaces the other rather than leaving two entries that disagree.
const ENTRY_FILE: &str = "lithic.desktop";

/// The icon's theme name. Never a path into the AppImage's mount, which would be broken after
/// a reboot.
const ICON_NAME: &str = "lithic";

/// The `shared-mime-info` file for this project's own type.
const MIME_FILE: &str = "lithic.xml";

/// The file name the copy takes. `.AppImage` is kept, or the kernel stops running it as one.
const TARGET_FILE: &str = "Lithic.AppImage";

/// The file types this app opens, as the MIME types a Linux desktop understands.
///
/// The same set the desktop app registers (`platform/linux.rs`), spelled the same way.
/// `application/x-lith` is the project's own type and is offered for a `.lith` only once the
/// definition below is installed; the rest are standard.
const MIME_TYPES: &str =
    "application/x-lith;text/markdown;text/plain;text/vnd.tiddlywiki;application/json;application/x-ipynb+json;text/html;";

/// Whether this copy has a file it can copy into a permanent place.
///
/// Only an AppImage is a file that survives being copied: a run from a checkout is a binary in
/// a `target/` directory, and a run inside one of those mounts is gone at reboot. So the copied
/// file is `$APPIMAGE` and nothing else, and a launch without one is offered no Install.
pub(crate) fn installable() -> bool {
    cfg!(target_os = "linux") && running_image().is_some()
}

/// The AppImage the person launched, per the runtime's own environment variable.
fn running_image() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The AppDir mount, set for the process the AppImage runtime starts. Where the icon is read
/// from, since the copy has not been made yet and the source is inside this mount.
fn appdir() -> Option<PathBuf> {
    std::env::var_os(crate::APPDIR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// `capabilities`
///
/// What this copy can offer, in the launcher's own vocabulary rather than a platform name, so
/// the page asks instead of guessing. The shape is the desktop app's `platform_capabilities`
/// minus the webview flags the shim has no answer for.
pub(crate) fn capabilities() -> Response {
    let install = installable();
    ok(json!({
        "os": std::env::consts::OS,
        "install": install,
        "launch_entry": if install { json!("application-menu") } else { Value::Null },
        "file_associations": cfg!(target_os = "linux"),
    }))
}

/// `install-status`
///
/// The three facts the footer's offer turns on, with the desktop app's own field names so the
/// launcher reads one shape in both modes. `up_to_date` is a byte comparison against the
/// running image, which is the desktop app's rule: a newer downloaded AppImage beside an older
/// installed copy reports stale, and running the installed copy reports current.
pub(crate) fn status() -> Response {
    let target = install_dir().map(|dir| dir.join(TARGET_FILE));
    let installed = target.as_deref().map(Path::is_file).unwrap_or(false);
    let running = running_image();
    let up_to_date = match (target.as_deref(), running.as_deref()) {
        (Some(target), Some(running)) => match (fs::read(target), fs::read(running)) {
            (Ok(installed), Ok(current)) => installed == current,
            _ => false,
        },
        _ => false,
    };
    ok(json!({
        "installed": installed,
        "up_to_date": up_to_date,
        "running_from_install": launched_from_install(),
        "path": target.as_deref().map(path_text).unwrap_or_default(),
    }))
}

/// `install`
///
/// Copy the running AppImage somewhere permanent and register it with the desktop's menu and
/// its file types. The answer names the copy and the entry, which is what the launcher's line
/// shows.
pub(crate) fn install() -> Response {
    let Some(source) = running_image() else {
        return failed("unsupported");
    };
    let (Some(dir), Some(data)) = (install_dir(), data_home()) else {
        return failed("no-install-dir");
    };
    let entry = data.join("applications").join(ENTRY_FILE);
    let layout = Layout { source, dir, appdir: appdir(), data_home: data };
    match perform(&layout) {
        Ok(target) => ok(json!({ "path": path_text(&target), "entry": path_text(&entry) })),
        Err(detail) => failed_with("install-failed", detail),
    }
}

/// Everything the install writes, named so the effectful part can be driven by a test on any
/// platform rather than only on a Linux desktop.
struct Layout {
    /// The AppImage the person launched.
    source: PathBuf,
    /// `Documents/Lithic`, where the copy goes.
    dir: PathBuf,
    /// The AppDir mount, when running as an AppImage, for the icon.
    appdir: Option<PathBuf>,
    /// `$XDG_DATA_HOME`, where the entry, the icon and the MIME file are written.
    data_home: PathBuf,
}

impl Layout {
    fn target(&self) -> PathBuf {
        self.dir.join(TARGET_FILE)
    }
}

/// Do the install: the copy, the entry, the icon and the MIME definition.
///
/// Only the copy is fatal. A missing icon or an unwritable MIME file is a signed-and-closed
/// mount or a locked folder, and neither is a reason to tell the person the install failed:
/// the entry that makes the app reachable, and the copy it points at, are already in place.
fn perform(layout: &Layout) -> Result<PathBuf, String> {
    let target = layout.target();
    fs::create_dir_all(&layout.dir).map_err(|error| error.to_string())?;
    // Copy only when the bytes differ, so a re-install keeps the copy's timestamp and does not
    // re-point an entry at a file that changed for no reason.
    let needs_copy = match (fs::read(&layout.source), fs::read(&target)) {
        (Ok(source), Ok(existing)) => source != existing,
        _ => true,
    };
    if needs_copy {
        fs::copy(&layout.source, &target).map_err(|error| error.to_string())?;
    }
    make_launchable(&target)?;

    let applications = layout.data_home.join("applications");
    fs::create_dir_all(&applications).map_err(|error| error.to_string())?;
    let icon = install_icon(layout);
    fs::write(applications.join(ENTRY_FILE), desktop_entry(&target, icon.as_deref()))
        .map_err(|error| error.to_string())?;

    let packages = layout.data_home.join("mime").join("packages");
    if fs::create_dir_all(&packages).is_ok() {
        let _ = fs::write(packages.join(MIME_FILE), mime_xml());
    }
    refresh_caches(&applications, &layout.data_home.join("mime"));
    Ok(target)
}

/// Mark the copy runnable. A no-op off unix, where the file arrives runnable.
fn make_launchable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Copy the icon out of the mount into the icon theme, returning the theme name.
///
/// The name, never the AppImage's own path: the mount is temporary. Best effort, because an
/// entry with no icon is still a working entry.
fn install_icon(layout: &Layout) -> Option<String> {
    let source = icon_source(layout.appdir.as_deref()?)?;
    let folder = layout
        .data_home
        .join("icons")
        .join("hicolor")
        .join("256x256")
        .join("apps");
    fs::create_dir_all(&folder).ok()?;
    fs::copy(&source, folder.join(format!("{ICON_NAME}.png"))).ok()?;
    Some(ICON_NAME.to_string())
}

/// The first icon in the packed app, in the order the build script is known to write them.
fn icon_source(appdir: &Path) -> Option<PathBuf> {
    [
        appdir.join("lithic.png"),
        appdir.join("usr/share/icons/hicolor/256x256/apps/lithic.png"),
        appdir.join("usr/share/icons/hicolor/128x128/apps/lithic.png"),
        appdir.join(".DirIcon"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

/// Refresh the two desktop databases that some desktops read instead of the folders themselves.
///
/// Best effort, and both programs are absent on a minimal system, which is not a failed
/// install. Linux only, since the two programs exist nowhere else.
fn refresh_caches(applications: &Path, mime: &Path) {
    #[cfg(target_os = "linux")]
    {
        for (program, argument) in [("update-desktop-database", applications), ("update-mime-database", mime)] {
            let _ = std::process::Command::new(program)
                .arg(argument)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (applications, mime);
    }
}

// ---------------------------------------------------------------------------
// Where the copy goes
// ---------------------------------------------------------------------------

/// The folder the copy is installed into, by the desktop app's rule.
///
/// The same folder `syncfolder::proposed` offers a first backup, and deliberately not a second
/// rule: `Documents/Lithic` is where the app puts itself *and* where its liths are meant to
/// live, which is why the desktop app answers both questions with one function
/// (`install_folder`).
pub(crate) fn install_dir() -> Option<PathBuf> {
    install_dir_on(documents_dir(), data_home(), home_dir())
}

/// The same decision with its inputs named, exactly as `platform::install_dir_on` makes it on
/// Linux: the person's Documents folder, then the data home, then home itself, each with
/// `Lithic` under it. Written out here rather than shared because the shim does not link the
/// desktop app; the two have to agree, and a test on each side pins the rule.
fn install_dir_on(documents: Option<PathBuf>, data_local: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    documents.or(data_local).or(home).map(|base| base.join("Lithic"))
}

/// The person's Documents folder, by the freedesktop rule.
///
/// Read from `user-dirs.dirs` rather than assumed to be `$HOME/Documents`, because the folder
/// carries the machine's own language in its name and only that file knows it. A machine with
/// no such file has no configured Documents folder, and the data home stands in for it.
fn documents_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".config"));
    let text = fs::read_to_string(config.join("user-dirs.dirs")).ok()?;
    parse_documents_dir(&text, &home)
}

/// The `XDG_DOCUMENTS_DIR` line out of a `user-dirs.dirs` file, with `$HOME` expanded.
///
/// Pure, so the language rule can be tested without a machine that speaks it. An unset or
/// empty value is no answer rather than a path of `""`, which is what would otherwise become
/// the current directory.
fn parse_documents_dir(text: &str, home: &Path) -> Option<PathBuf> {
    let value = text
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("XDG_DOCUMENTS_DIR=").map(str::trim))?;
    let value = value.trim_matches('"');
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix("$HOME/") {
        return Some(home.join(rest));
    }
    // A leading slash rather than `Path::is_absolute`, because this file is a freedesktop one
    // and the rule is written for a Linux filesystem: the local test run is on Windows, where
    // `Path` would call `/mnt/docs` relative and reject a value that is absolute where it counts.
    value.starts_with('/').then(|| PathBuf::from(value))
}

/// Whether this process is the installed copy: the same file, not merely the same bytes.
fn launched_from_install() -> bool {
    let (Some(target), Some(running)) = (install_dir().map(|dir| dir.join(TARGET_FILE)), running_image()) else {
        return false;
    };
    match (fs::canonicalize(running), fs::canonicalize(target)) {
        (Ok(running), Ok(target)) => running == target,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// The entry, the icon name and the MIME definition
// ---------------------------------------------------------------------------

/// The desktop entry, as text. Pure, so the format can be asserted without installing.
fn desktop_entry(program: &Path, icon: Option<&str>) -> String {
    let mut entry = String::from("[Desktop Entry]\n");
    entry.push_str("Type=Application\n");
    entry.push_str("Name=Lithic\n");
    entry.push_str("Comment=Notes, documents and diagrams in one file\n");
    entry.push_str(&format!("Exec={} %f\n", quote_exec(program)));
    if let Some(icon) = icon {
        entry.push_str(&format!("Icon={icon}\n"));
    }
    entry.push_str("Terminal=false\n");
    entry.push_str("Categories=Office;Utility;\n");
    entry.push_str(&format!("MimeType={MIME_TYPES}\n"));
    entry.push_str(&format!("StartupWMClass={APP_WINDOW_CLASS}\n"));
    entry
}

/// A program path as the `Exec=` line has to spell it.
///
/// The desktop entry format is not a shell, and its own rule is that an argument with a space
/// is wrapped in double quotes with `"`, `` ` ``, `$` and `\` escaped by a backslash. The
/// install folder is under Documents, which very often has a space somewhere above it.
fn quote_exec(program: &Path) -> String {
    let text = program.to_string_lossy();
    if !text.contains(' ') && !text.contains('\t') && !text.contains('"') {
        return text.into_owned();
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        if matches!(character, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

/// The `shared-mime-info` definition of this project's own type.
///
/// Without it a `.lith` resolves to no type, and a desktop cannot offer an entry that declares
/// it. The glob is what maps the extension to the type; the comment is what a file manager
/// shows.
fn mime_xml() -> String {
    String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <mime-info xmlns=\"http://www.freedesktop.org/standards/shared-mime-info\">\n\
         \x20 <mime-type type=\"application/x-lith\">\n\
         \x20   <comment>Lithic wiki</comment>\n\
         \x20   <glob pattern=\"*.lith\"/>\n\
         \x20 </mime-type>\n\
         </mime-info>\n",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A private scratch directory per test, removed by the OS's own temp cleanup.
    fn scratch(label: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("lithic-install-{label}-{}-{unique}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// The folder the person would look in comes first, and the data home is only the stand-in.
    #[test]
    fn the_install_folder_prefers_documents_then_the_data_home() {
        let docs = Some(PathBuf::from("/docs"));
        let data = Some(PathBuf::from("/data"));
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(install_dir_on(docs.clone(), data.clone(), home.clone()), Some(PathBuf::from("/docs/Lithic")));
        assert_eq!(install_dir_on(None, data.clone(), home.clone()), Some(PathBuf::from("/data/Lithic")));
        assert_eq!(install_dir_on(None, None, home.clone()), Some(PathBuf::from("/home/u/Lithic")));
        assert_eq!(install_dir_on(None, None, None), None);
    }

    /// The Documents folder is named in the machine's own language, and only the config knows it.
    #[test]
    fn the_documents_folder_is_read_from_the_desktop_config() {
        let home = Path::new("/home/u");
        assert_eq!(
            parse_documents_dir("XDG_DOCUMENTS_DIR=\"$HOME/Dokumente\"\n", home),
            Some(PathBuf::from("/home/u/Dokumente"))
        );
        assert_eq!(
            parse_documents_dir("# comment\nXDG_DOCUMENTS_DIR=\"/mnt/docs\"\n", home),
            Some(PathBuf::from("/mnt/docs"))
        );
        assert_eq!(parse_documents_dir("XDG_DOCUMENTS_DIR=\"\"\n", home), None);
        assert_eq!(parse_documents_dir("XDG_DESKTOP_DIR=\"$HOME/Desktop\"\n", home), None);
        assert_eq!(parse_documents_dir("", home), None);
    }

    /// The entry has to hand over the file it was opened with, and name the installed copy.
    #[test]
    fn the_entry_points_at_the_copy_and_receives_a_file() {
        let entry = desktop_entry(Path::new("/home/u/Documents/Lithic/Lithic.AppImage"), Some("lithic"));
        assert!(entry.contains("Exec=/home/u/Documents/Lithic/Lithic.AppImage %f"), "{entry}");
        assert!(entry.contains("MimeType=application/x-lith;"), "{entry}");
        assert!(entry.contains("Terminal=false"), "{entry}");
        assert!(entry.contains("Icon=lithic"), "{entry}");
        assert!(entry.contains(&format!("StartupWMClass={APP_WINDOW_CLASS}")), "{entry}");
        assert!(!entry.contains("StartupWMClass=\n"), "the window class must be named: {entry}");
    }

    /// A path with a space is the common case, and the format has its own quoting rule.
    #[test]
    fn an_exec_path_with_a_space_is_quoted() {
        assert_eq!(quote_exec(Path::new("/home/u/Lithic.AppImage")), "/home/u/Lithic.AppImage");
        assert_eq!(quote_exec(Path::new("/home/u/My Documents/Lithic.AppImage")), "\"/home/u/My Documents/Lithic.AppImage\"");
        assert_eq!(quote_exec(Path::new("/a/b $c/Lithic")), "\"/a/b \\$c/Lithic\"");
    }

    /// The MIME file is what makes a `.lith` resolve to this app's own type.
    #[test]
    fn the_mime_definition_names_the_lith_type_and_its_extension() {
        let xml = mime_xml();
        assert!(xml.contains("<mime-type type=\"application/x-lith\">"), "{xml}");
        assert!(xml.contains("<glob pattern=\"*.lith\"/>"), "{xml}");
        assert!(xml.contains("shared-mime-info"), "{xml}");
    }

    /// The whole install, driven against a scratch folder so it runs on any platform: the copy
    /// lands where the entry points, the entry is written, and the MIME file beside it.
    #[test]
    fn installing_writes_the_copy_the_entry_and_the_mime_file() {
        let root = scratch("perform");
        let source = root.join("Downloads").join("Lithic.AppImage");
        fs::create_dir_all(source.parent().unwrap()).expect("downloads");
        fs::write(&source, b"an appimage, in bytes").expect("source");
        let appdir = root.join("mount");
        fs::create_dir_all(&appdir).expect("mount");
        fs::write(appdir.join("lithic.png"), b"png").expect("icon");
        let data = root.join("data");

        let layout = Layout {
            source: source.clone(),
            dir: root.join("Documents").join("Lithic"),
            appdir: Some(appdir),
            data_home: data.clone(),
        };
        let target = perform(&layout).expect("install");
        assert_eq!(target, root.join("Documents").join("Lithic").join("Lithic.AppImage"));
        assert_eq!(fs::read(&target).expect("copy"), b"an appimage, in bytes");

        let entry = fs::read_to_string(data.join("applications").join(ENTRY_FILE)).expect("entry");
        assert!(entry.contains(&format!("Exec={} %f", target.display())), "{entry}");
        assert!(fs::read_to_string(data.join("mime").join("packages").join(MIME_FILE)).is_ok());
        assert!(data.join("icons").join("hicolor").join("256x256").join("apps").join("lithic.png").is_file());

        // A second run with identical bytes does not rewrite the copy.
        let first_modified = fs::metadata(&target).and_then(|meta| meta.modified()).expect("mtime");
        let again = perform(&Layout { source, dir: root.join("Documents").join("Lithic"), appdir: None, data_home: data.clone() });
        assert_eq!(again.expect("reinstall"), target);
        assert_eq!(fs::metadata(&target).and_then(|meta| meta.modified()).expect("mtime"), first_modified);
        // A missing icon is not a failure: the entry falls back to no Icon line.
        let entry = fs::read_to_string(data.join("applications").join(ENTRY_FILE)).expect("entry");
        assert!(!entry.contains("Icon="), "{entry}");

        let _ = fs::remove_dir_all(&root);
    }
}
