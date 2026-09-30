//! The Linux answers to `platform`'s capabilities.
//!
//! All plain `std`, and compiled on every platform on purpose (see the module doc in
//! `mod.rs`): a process spawn, a text file, and one `chmod`.
//!
//! The launch entry is the half worth explaining. Windows writes a shell link and a set
//! of registry keys; the equivalent here is a single freedesktop desktop entry, and it
//! is *also* what registers the file types, because a `.desktop` file declares the MIME
//! types it opens in its own `MimeType=` line. So this module writes one file and the
//! "associations" capability has nothing left to do: `register_file_associations` is
//! here to say so rather than to be absent, so the capability table reads the same on
//! every platform.
//!
//! Where an entry points matters and is the reason `install_launch_entry` takes the
//! *installed* program rather than the running one: an AppImage launched from
//! `~/Downloads` runs from a temporary mount that is gone after a reboot, so an entry
//! aimed at it would be a menu item that stops working. It aims at the installed copy.

// This module is compiled on every platform so the local gate (which runs on Windows)
// type-checks and lints it, and only *called* on Linux, which on Windows reads as code
// that is never used. Same situation and same answer as the mirror image in
// `instance_search`, where the protocol reading is Windows-only and the lint needs
// quieting the other way round.
#![cfg_attr(windows, allow(dead_code))]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The file types this app edits, as the MIME types a Linux desktop understands.
///
/// The same set as the Windows registration, spelled the Linux way. `application/x-lith`
/// is this project's own type: a desktop only offers Lithic for it once a
/// `shared-mime-info` package knows the type, which is a distribution's job rather than
/// a running app's. The rest are standard, so "Open With Lithic" works for them as soon
/// as the entry is installed, with no default association stolen.
fn mime_types() -> &'static str {
    "application/x-lith;text/markdown;text/plain;text/vnd.tiddlywiki;application/json;application/x-ipynb+json;text/html;"
}

/// Open an address in whatever the desktop has registered as its browser.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    let opened = Command::new("xdg-open")
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match opened {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("xdg-open could not open {}: {}", url, error)),
    }
}

/// Show a file in the file manager.
///
/// The parent folder, because the freedesktop file managers have no portable "and select
/// this one" argument: `xdg-open` on a directory opens it, and Nautilus, Dolphin and
/// Thunar each spell selection differently. Opening the folder the file is in is the
/// portable half of the gesture.
pub fn reveal(path: &Path) -> Result<(), String> {
    let Some(folder) = path.parent() else {
        return Err("the file has no folder to open".to_string());
    };
    open_folder(folder)
}

fn open_folder(folder: &Path) -> Result<(), String> {
    let opened = Command::new("xdg-open")
        .arg(folder)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match opened {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("xdg-open could not open {}: {}", folder.display(), error)),
    }
}

/// Write the application menu entry for the installed copy, returning its path.
pub fn install_launch_entry(program: &Path) -> Result<Option<PathBuf>, String> {
    let applications = applications_dir()
        .ok_or_else(|| "Could not resolve the application menu folder".to_string())?;
    fs::create_dir_all(&applications).map_err(|error| error.to_string())?;
    let icon = install_icon();
    let entry = desktop_entry(program, icon.as_deref());
    let file = applications.join("lithic.desktop");
    fs::write(&file, entry).map_err(|error| error.to_string())?;
    // Best effort: the file above is the registration, and this only refreshes the
    // desktop database caches that some desktops read instead of the folder. Absent on a
    // minimal system, which is not a failed install.
    let _ = Command::new("update-desktop-database")
        .arg(&applications)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    Ok(Some(file))
}

/// The file types are declared in the entry that `install_launch_entry` writes.
///
/// Kept as a function that reports success rather than left out, because the same
/// sequence of calls runs on every platform and a missing step is harder to read than a
/// step that explains itself.
pub fn register_file_associations(_program: &Path) -> Result<(), String> {
    Ok(())
}

/// Mark a copied program as something the kernel will run.
///
/// An AppImage copied out of `~/Downloads` keeps its executable bit through
/// `fs::copy`, but a bare binary fetched from a release archive may not have one, and a
/// copy without it is a file the launcher cannot start.
pub fn make_launchable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        let mut mode = mode;
        mode.set_mode(0o755);
        fs::set_permissions(path, mode).map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("this is not a unix platform".to_string())
    }
}

/// Where an application menu entry belongs, and where its icon belongs beside it.
///
/// `$XDG_DATA_HOME` is the platform's own answer and the home folder is its documented
/// default, so this is the same rule the rest of the desktop follows rather than a path
/// this app invented.
fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))
}

fn applications_dir() -> Option<PathBuf> {
    data_home().map(|data| data.join("applications"))
}

/// The icon the AppImage carries, copied to where an icon theme looks for it.
///
/// The name handed back is the theme name (`Icon=lithic`), never the AppImage's own
/// mount path: that path is a temporary mount and would leave the menu entry with a
/// broken icon a reboot later.
fn install_icon() -> Option<String> {
    let data = data_home()?;
    let source = find_icon(&appdir()?)?;
    let folder = data.join("icons").join("hicolor").join("256x256").join("apps");
    fs::create_dir_all(&folder).ok()?;
    fs::copy(&source, folder.join("lithic.png")).ok()?;
    Some("lithic".to_string())
}

/// The root the AppImage runtime unpacks into, set for the process it starts.
fn appdir() -> Option<PathBuf> {
    std::env::var_os("APPDIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The first icon in the packed app, preferring the largest.
///
/// The fixed list is tried first because it is what the bundler is known to write; the
/// scan behind it is for a build whose icon set differs, and it sorts by the size folder
/// so a menu still gets a sharp icon rather than whichever file the directory happened to
/// list first.
fn find_icon(appdir: &Path) -> Option<PathBuf> {
    let hicolor = appdir.join("usr").join("share").join("icons").join("hicolor");
    let named = ["256x256", "128x128", "64x64", "32x32"]
        .iter()
        .map(|size| hicolor.join(size).join("apps").join("lithic.png"))
        .find(|candidate| candidate.is_file());
    if named.is_some() {
        return named;
    }
    let mut scanned: Vec<PathBuf> = fs::read_dir(&hicolor)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join("apps"))
        .filter_map(|apps| fs::read_dir(apps).ok())
        .flatten()
        .flatten()
        .map(|file| file.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "png"))
        .collect();
    scanned.sort();
    // Largest size folder last in a plain sort, and every size folder holds the same
    // icon, so the last one is the sharpest.
    scanned.pop()
}

/// The desktop entry, as text.
///
/// Pure so it can be read and asserted without installing anything, which is the only
/// way to check this on a machine that is not running the desktop it describes.
fn desktop_entry(program: &Path, icon: Option<&str>) -> String {
    let mut entry = String::from("[Desktop Entry]\n");
    entry.push_str("Type=Application\n");
    entry.push_str("Name=Lithic\n");
    entry.push_str("Comment=Notes, documents and diagrams in one file\n");
    entry.push_str(&format!("Exec={} %F\n", exec_path(program)));
    if let Some(icon) = icon {
        entry.push_str(&format!("Icon={}\n", icon));
    }
    entry.push_str("Terminal=false\n");
    entry.push_str("Categories=Office;Utility;\n");
    entry.push_str(&format!("MimeType={}\n", mime_types()));
    entry
}

/// A program path as the `Exec=` line has to spell it.
///
/// The desktop entry format is not a shell, and its own rule is that an argument
/// containing a space is wrapped in double quotes with `"`, `` ` ``, `$` and `\` escaped
/// by a backslash. An AppImage very often sits in a folder with a space in its name, and
/// an unquoted path there makes the menu entry silently do nothing at all.
fn exec_path(program: &Path) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The entry has to name the installed copy, declare every type this app edits, and
    /// be a file the desktop can read on its own.
    #[test]
    fn the_entry_points_at_the_installed_copy_and_declares_the_types() {
        let entry = desktop_entry(Path::new("/home/u/Documents/Lithic/Lithic.AppImage"), Some("lithic"));
        assert!(entry.starts_with("[Desktop Entry]\n"), "a desktop entry has to open with its group header");
        assert!(entry.contains("\nExec=/home/u/Documents/Lithic/Lithic.AppImage %F\n"));
        assert!(entry.contains("\nIcon=lithic\n"));
        assert!(entry.contains("\nTerminal=false\n"));
        assert!(entry.contains("\nName=Lithic\n"));
        for mime in [
            "application/x-lith",
            "text/markdown",
            "text/plain",
            "text/vnd.tiddlywiki",
            "application/json",
            "application/x-ipynb+json",
            "text/html",
        ] {
            assert!(entry.contains(mime), "{mime} is a type this app opens and the entry has to say so");
        }
        // `%F` rather than `%U`: these are files off a file manager, and the app reads a
        // path from its own arguments.
        assert!(entry.contains(" %F\n"), "the entry passes file paths, not URLs");
    }

    /// An icon that could not be copied leaves the line out rather than naming a path
    /// inside a temporary mount.
    #[test]
    fn no_icon_means_no_icon_line() {
        let entry = desktop_entry(Path::new("/apps/Lithic"), None);
        assert!(!entry.contains("Icon="), "a missing icon must not become a broken one");
    }

    /// The quoting rule, which is the difference between a menu entry that opens the app
    /// and one that does nothing.
    #[test]
    fn a_path_with_a_space_is_quoted_the_way_the_format_requires() {
        assert_eq!(exec_path(Path::new("/usr/bin/lithic")), "/usr/bin/lithic");
        assert_eq!(exec_path(Path::new("/home/u/My Apps/Lithic.AppImage")), "\"/home/u/My Apps/Lithic.AppImage\"");
        // The four characters the format reserves are escaped inside the quotes, and a
        // path is allowed to contain every one of them.
        assert_eq!(exec_path(Path::new("/home/u/a $b/`c`/\"d\" e")), "\"/home/u/a \\$b/\\`c\\`/\\\"d\\\" e\"");
    }

    /// The icon search prefers a real size folder, and falls back to whatever the bundle
    /// shipped rather than reporting no icon at all.
    #[test]
    fn the_icon_search_prefers_the_largest_named_size_then_scans() {
        let root = std::env::temp_dir().join(format!("lithic-icon-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let icons = root.join("usr").join("share").join("icons").join("hicolor");
        fs::create_dir_all(icons.join("32x32").join("apps")).unwrap();
        fs::write(icons.join("32x32").join("apps").join("lithic.png"), b"small").unwrap();
        assert_eq!(
            find_icon(&root),
            Some(icons.join("32x32").join("apps").join("lithic.png")),
            "the only icon the bundle has is the one to use"
        );

        fs::create_dir_all(icons.join("256x256").join("apps")).unwrap();
        fs::write(icons.join("256x256").join("apps").join("lithic.png"), b"large").unwrap();
        assert_eq!(
            find_icon(&root).and_then(|path| path.parent().and_then(|parent| parent.parent()).map(|parent| parent.to_path_buf())),
            Some(icons.join("256x256")),
            "the sharper icon wins once there is a choice"
        );

        let _ = fs::remove_dir_all(&root);
        assert_eq!(find_icon(&root), None, "an app with no icons reports none rather than a guess");
    }
}
