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

/// Replace a document's text.
pub fn write(document: &str, text: &str) -> Result<(), String> {
    fs::write(document, text).map_err(|error| error.to_string())
}

/// The name a row shows for a document: its last path component.
pub fn name(document: &str) -> String {
    Path::new(document)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| document.to_string())
}
