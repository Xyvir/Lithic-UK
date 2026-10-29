//! The document answers for every platform whose picker is the desktop's own dialog.
//!
//! One module rather than three, because this is the one capability where the three desktops do
//! not differ: Windows, Linux and macOS all reach `tauri-plugin-dialog`, which is a native panel
//! on each of them, and all three read and write with `std::fs`. What differs by platform is
//! *where* such a panel opens, and that is `install_dir`/`program_dir`'s answer rather than a
//! rule of its own (see `start_dir`).
//!
//! Android is the reason this is a module of its own at all. A phone's picker answers with a
//! document reference rather than a path, so its answers live in `android.rs` and are routed to
//! from `mod.rs`; everything above this line is the shape a desktop keeps.
//!
//! Compiled on every platform like its two neighbours, so the local gate sees it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Where a picker opens: the installed folder when the app has been installed, else the folder
/// holding the program (the folder holding the bundle on macOS), so a thumb-drive copy starts
/// where its liths are.
pub fn start_dir() -> Option<PathBuf> {
    super::install_dir()
        .filter(|dir| dir.is_dir())
        .or_else(super::program_dir)
}

/// The dialog's answer to "which files", converted to the vocabulary the rest of the crate uses.
///
/// A `file://` URL is turned into a path here rather than carried as a reference, because on a
/// desktop a path is what everything downstream reads and writes (`read_document`,
/// `write_document`, the recents row). Android is the platform where the reference itself is the
/// answer, and it never reaches this module.
pub fn pick(app: &AppHandle, multiple: bool) -> Result<Option<Vec<FilePath>>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut picker = app.dialog().file();
    if let Some(dir) = start_dir() {
        picker = picker.set_directory(dir);
    }
    if multiple {
        picker.pick_files(move |files| {
            let _ = sender.send(files);
        });
    } else {
        picker.pick_file(move |file| {
            let _ = sender.send(file.map(|file| vec![file]));
        });
    }
    let files = receiver.recv().ok().flatten();
    Ok(files.map(|files| files.into_iter().map(simplify).collect()))
}

/// A save picker: the name the document is proposed under, and the folder the picker starts in.
pub fn pick_save(app: &AppHandle, suggested_name: &str) -> Result<Option<FilePath>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut picker = app
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter("Lithic files", &["lith"]);
    if let Some(dir) = start_dir() {
        picker = picker.set_directory(dir);
    }
    picker.save_file(move |file| {
        let _ = sender.send(file);
    });
    Ok(receiver.recv().ok().flatten().map(simplify))
}

/// Turn the dialog's answer into a path where it is one, and hand back what it is otherwise.
///
/// `into_path` is deliberately not used: it *refuses* a reference the platform cannot express as
/// a path, and on a desktop that refusal is about a URL this module can still read (a `file://`
/// URL converts; anything else is not something a desktop picker produces).
fn simplify(file: FilePath) -> FilePath {
    match file {
        FilePath::Url(url) => match url.to_file_path() {
            Ok(path) => FilePath::Path(path),
            Err(_) => FilePath::Url(url),
        },
        path => path,
    }
}

/// A document's text.
pub fn read(document: &str) -> Result<String, String> {
    fs::read_to_string(document).map_err(|error| error.to_string())
}

/// A document's bytes, base64-encoded, for the one file this app opens without reading it
/// as text.
///
/// A `.pdf` is that file. Its pages are rendered by the wiki's own importer, which runs
/// inside the mounted document rather than in this process, so the bytes have to travel to
/// the page and base64 is the shape the IPC bridge carries them in. Nothing here parses the
/// PDF; reading it as text would only produce a lossy string, which is why `read` is not the
/// function for it.
pub fn read_base64(document: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(document).map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Replace a document's text.
pub fn write(document: &str, text: &str) -> Result<(), String> {
    fs::write(document, text).map_err(|error| error.to_string())
}

/// The folder this desktop puts downloads in.
///
/// The same answer on all three desktops, because it is the platform's own user folder rather
/// than a convention of ours: `dirs` reads it from the shell's known folders on Windows and
/// macOS and from `XDG_DOWNLOAD_DIR`, falling back to `~/Downloads`, on Linux. Taken only where
/// it is a real folder, so a machine with a redirected or absent one answers nothing rather than
/// a path a write would fail on. Android never reaches this: see `mod.rs`.
pub fn download_dir() -> Option<PathBuf> {
    dirs::download_dir().filter(|dir| dir.is_dir())
}

/// Write `text` as a new file in `folder`, under `suggested_name` or the next free number of it.
///
/// It answers the path it took, so the caller has the one fact a confirmed save is made of.
///
/// `create_new` rather than a check followed by a write: the name is claimed and the file made
/// in one step, so two downloads of the same name in the same moment take two names instead of
/// one quietly replacing the other. That matters because this folder is where a person keeps
/// copies, and the second copy of a backup is a second copy.
///
/// The numbering is a browser's (`notes.lith`, then `notes (1).lith`), because it is the one
/// convention a person reading their Downloads folder already knows. The bound is not a limit
/// anybody reaches: a folder holding a thousand candidates is a folder answering that every name
/// is taken, and an error says that better than a name nobody would read.
pub fn create_download(folder: &Path, suggested_name: &str, text: &str) -> Result<PathBuf, String> {
    let base = download_base_name(suggested_name);
    for number in 0..1000 {
        let candidate = folder.join(numbered_download_name(&base, number));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                file.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "{} already holds every name this download could take",
        folder.display()
    ))
}

/// The name a download is proposed under, reduced to its last component.
///
/// A page names the file it wants and never chooses a folder, so a name carrying a path is a
/// name that must not be allowed to write outside the one folder this exists for. An empty name
/// is a name this will not invent a folder from, and it gets the one word a download can always
/// be called.
fn download_base_name(suggested_name: &str) -> String {
    Path::new(suggested_name)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "download.lith".to_string())
}

/// `base` for the first copy, then the same name with the number a second copy takes.
fn numbered_download_name(base: &str, number: usize) -> String {
    if number == 0 {
        return base.to_string();
    }
    let path = Path::new(base);
    match path.extension() {
        Some(extension) => format!(
            "{} ({number}).{}",
            path.file_stem().unwrap_or_default().to_string_lossy(),
            extension.to_string_lossy()
        ),
        None => format!("{} ({number})", path.file_stem().unwrap_or_default().to_string_lossy()),
    }
}

/// The name a row shows for a document: its last path component.
pub fn name(document: &str) -> String {
    Path::new(document)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| document.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbering a person reading their Downloads folder already expects, which is the one
    /// thing here worth pinning: a second backup under the same name must not replace the first.
    #[test]
    fn a_second_download_is_numbered_rather_than_replaced() {
        assert_eq!(numbered_download_name("notes.lith", 0), "notes.lith");
        assert_eq!(numbered_download_name("notes.lith", 1), "notes (1).lith");
        assert_eq!(numbered_download_name("notes.lith", 12), "notes (12).lith");
        // A name with no extension keeps all of itself, and only the number is new.
        assert_eq!(numbered_download_name("notes", 3), "notes (3)");
    }

    /// A page names a file and never a folder: a name carrying a path must not reach outside the
    /// one folder this writes into, and an empty one must not become a file called `""`.
    #[test]
    fn a_download_name_is_a_name_and_not_a_path() {
        assert_eq!(download_base_name("notes.lith"), "notes.lith");
        assert_eq!(download_base_name("../../etc/passwd"), "passwd");
        assert_eq!(download_base_name("C:\\Users\\u\\notes.lith"), "notes.lith");
        assert_eq!(download_base_name(""), "download.lith");
        assert_eq!(download_base_name("   "), "download.lith");
    }

    /// The write itself: the first copy takes the name it was given, the second one beside it
    /// takes the next number, and neither is the other's bytes.
    #[test]
    fn two_downloads_of_one_name_are_two_files() {
        let folder = std::env::temp_dir().join(format!("lithic-download-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();

        let first = create_download(&folder, "backup.lith", "one").unwrap();
        let second = create_download(&folder, "backup.lith", "two").unwrap();
        assert_eq!(first.file_name().unwrap(), "backup.lith");
        assert_eq!(second.file_name().unwrap(), "backup (1).lith");
        assert_eq!(fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(fs::read_to_string(&second).unwrap(), "two");

        let _ = fs::remove_dir_all(&folder);
    }
}
