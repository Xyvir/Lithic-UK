//! The macOS answers to `platform`'s capabilities.
//!
//! The shortest of the three, and deliberately so. Two of Windows' five capabilities are
//! things macOS does *for* an app rather than things an app does to the system, and the
//! right implementation is to say so rather than to grow an equivalent:
//!
//! **Placing the app** is the drag from the disk image. A Mac distribution is a `.dmg`
//! holding `Lithic.app` beside a symlink to `/Applications`; the user drags the bundle
//! across and Finder does the copy. An app that also copied its own bundle into
//! `~/Documents/Lithic` would be a second copy of something already placed in the folder
//! the user chose, so `install_launch_entry` answers `None` and the capability table
//! reports no install rather than a launcher that never appears.
//!
//! **Registering file types** is the bundle's `Info.plist`. Launch Services reads the
//! document types a bundle declares when it is first seen, so the registration happens
//! because the app *is* a bundle rather than because it ran.
//!
//! What is left is the two process spawns, which are the same pair on any Unix: `open`
//! hands an address to the default browser, and `open -R` shows a file in Finder with the
//! file selected.
//!
//! NOT YET IMPLEMENTED HERE, and the reason the capability table reports false: the three
//! webview hooks (`webview_auth`, `instance_copy::forget`, `instance_search::read_caches`)
//! are Windows-only. WKWebView exposes the equivalents through a navigation delegate that
//! wry does not surface, so those stay on the list rather than in a comment somebody has
//! to find.

// Compiled on every platform so the local gate type-checks and lints it, and only called
// on macOS, which on Windows reads as code that is never used. See the note in
// `linux.rs`.
#![cfg_attr(windows, allow(dead_code))]
#![cfg_attr(target_os = "linux", allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Open an address in the default browser.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    spawn(open_arguments(url))
}

/// Show a file in Finder, with the file itself selected.
pub fn reveal(path: &Path) -> Result<(), String> {
    spawn(reveal_arguments(path))
}

/// Nothing to do: the disk image the user dragged the bundle from put it in place.
pub fn install_launch_entry(_program: &Path) -> Result<Option<PathBuf>, String> {
    Ok(None)
}

/// Nothing to do: the bundle's `Info.plist` is the registration.
pub fn register_file_associations(_program: &Path) -> Result<(), String> {
    Ok(())
}

/// Nothing to do: the Mach-O inside a bundle carries its own executable bit.
pub fn make_launchable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn open_arguments(url: &str) -> Vec<String> {
    vec![url.to_string()]
}

fn reveal_arguments(path: &Path) -> Vec<String> {
    vec!["-R".to_string(), path.to_string_lossy().into_owned()]
}

/// `open`, with its standard streams detached.
///
/// The output is not ours to show and a tooltip is not a terminal, so a line `open` would
/// have printed is discarded rather than buffered into a message nobody asked for.
fn spawn(arguments: Vec<String>) -> Result<(), String> {
    let opened = Command::new("open")
        .args(&arguments)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match opened {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("open could not open {}: {}", arguments.join(" "), error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two gestures, as the argument lists `open` is given.
    #[test]
    fn the_open_gestures_are_the_arguments_open_expects() {
        assert_eq!(open_arguments("https://lithic.uk"), vec!["https://lithic.uk".to_string()]);
        // `-R` is reveal, not open: it is the difference between a browser tab and a
        // Finder window with the file selected.
        assert_eq!(
            reveal_arguments(Path::new("/Users/u/Documents/Lithic/Lithic.app")),
            vec!["-R".to_string(), "/Users/u/Documents/Lithic/Lithic.app".to_string()]
        );
    }

    /// A Mac install creates nothing, and says so rather than reporting a path to a
    /// shortcut it did not write.
    #[test]
    fn installing_creates_no_entry_on_macos() {
        assert!(install_launch_entry(Path::new("/Applications/Lithic.app")).expect("no work").is_none());
        assert!(register_file_associations(Path::new("/Applications/Lithic.app")).is_ok());
        assert!(make_launchable(Path::new("/Applications/Lithic.app")).is_ok());
    }
}
