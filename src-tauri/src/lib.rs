use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

mod credentials;
mod webview_auth;
mod gitcore;
mod instance_search;
mod instance_copy;
mod cdp;

struct StartupFile(Mutex<Option<String>>);

#[derive(serde::Serialize)]
struct LithFile {
    name: String,
    path: String,
    text: String,
}

#[derive(serde::Serialize)]
struct SavedLithFile {
    name: String,
    path: String,
}

#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn get_cli_args() -> Vec<String> {
    std::env::args().collect()
}

#[tauri::command]
fn read_lith_path(path: String) -> Result<LithFile, String> {
    let path = PathBuf::from(path);
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(LithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        text,
    })
}

/// Default dialog starting point: the installed bundle folder when the app
/// has been installed (Documents\Lithic), else the exe's own folder so
/// thumb-drive bundles start where the liths live.
fn dialog_start_dir() -> Option<PathBuf> {
    install_target()
        .filter(|path| path.is_file())
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .or_else(exe_dir)
}

// The dialog commands are async, and that is load-bearing: a sync command runs
// on the main thread, and Tauri 2's blocking file pickers must not be called
// there. An async command gets a worker thread, so it can park on a channel
// while the dialog's own callback (which fires on the main thread) delivers the
// chosen path. Same modality guarantee as v1's sync command, without the
// deadlock.
#[tauri::command]
async fn open_lith_file(app: tauri::AppHandle) -> Result<Option<LithFile>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut picker = app
        .dialog()
        .file()
        .add_filter("Lithic files", &["lith"])
        .add_filter("Text & data files", &["md", "txt", "tid", "json", "ipynb", "html", "htm"])
        .add_filter("All files", &["*"]);
    if let Some(dir) = dialog_start_dir() {
        picker = picker.set_directory(dir);
    }
    picker.pick_file(move |file| {
        let _ = sender.send(file);
    });
    let Some(file) = receiver.recv().ok().flatten() else { return Ok(None); };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(Some(LithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        text,
    }))
}

#[tauri::command]
async fn save_lith_file(
    app: tauri::AppHandle,
    text: String,
    suggested_name: String,
    path: Option<String>,
) -> Result<SavedLithFile, String> {
    // An explicit path skips the dialog entirely (a wiki saving over itself).
    let selected = match path {
        Some(path) => Some(PathBuf::from(path)),
        None => {
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut picker = app
                .dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Lithic files", &["lith"]);
            if let Some(dir) = dialog_start_dir() {
                picker = picker.set_directory(dir);
            }
            picker.save_file(move |file| {
                let _ = sender.send(file);
            });
            receiver
                .recv()
                .ok()
                .flatten()
                .map(|file| file.into_path())
                .transpose()
                .map_err(|error| error.to_string())?
        }
    };

    let Some(path) = selected else { return Err("Save cancelled".to_string()); };
    fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(SavedLithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Write arbitrary text to an absolute path (fancy-editor in-place saves for
/// the scratch file types: .md/.txt/.tid/.json/.ipynb). Only existing paths may be
/// overwritten — new files go through save_lith_file's dialog.
#[tauri::command]
fn write_text_path(path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err(format!("Refusing to overwrite non-file path: {}", path.display()));
    }
    fs::write(&path, text).map_err(|error| error.to_string())
}

/// Copy a Lith into a folder that is already backed up.
///
/// What the launcher used to offer instead — set up a second repository for
/// whatever folder that file happens to live in — answered "this file is not
/// backed up" with "now you maintain two backups", and made the user's folder
/// layout decide how many repositories exist. Copying into the covered folder is
/// the local answer: the file lands where saves are already pushed.
///
/// A copy, not a move. The original is the user's and stays where it is, which
/// is also why an existing file of the same name is refused rather than
/// overwritten: the destination may hold a different Lith with that name.
#[tauri::command]
fn copy_lith_to_synced_dir(path: String, folder: String) -> Result<SavedLithFile, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("{} is not a file", source.display()));
    }
    let target_dir = PathBuf::from(&folder);
    if !target_dir.is_dir() {
        return Err(format!("{} is not a folder", target_dir.display()));
    }
    let name = source
        .file_name()
        .ok_or_else(|| "The file has no name".to_string())?
        .to_os_string();
    let target = target_dir.join(&name);
    if target.exists() {
        return Err(format!(
            "{} is already in that folder",
            name.to_string_lossy()
        ));
    }
    fs::copy(&source, &target).map_err(|error| error.to_string())?;
    Ok(SavedLithFile {
        name: name.to_string_lossy().into_owned(),
        path: target.to_string_lossy().into_owned(),
    })
}

/// Canonical per-user install target for the monolith executable: visible
/// Documents\Lithic\Lithic.exe, falling back out of the way when Documents
/// is unavailable. Shared by install and status queries.
fn install_target() -> Option<PathBuf> {
    dirs::document_dir()
        .map(|docs| docs.join("Lithic"))
        .or_else(|| dirs::data_local_dir().map(|local| local.join("Programs").join("Lithic")))
        .or_else(|| dirs::home_dir().map(|home| home.join("Lithic")))
        .map(|dir| dir.join("Lithic.exe"))
}

/// What an install did, so the launcher can say where the program went and
/// whether it also picked up a Start Menu entry.
#[derive(serde::Serialize)]
struct InstallResult {
    path: String,
    start_menu: Option<String>,
}

/// Write a Windows shell link.
///
/// Through the shell's own `IShellLink`, rather than by hand-rolling the binary
/// format or scripting a launcher: Windows owns the format, so the result is
/// exactly what "Create shortcut" would have made and behaves like it —
/// pinnable, renameable, movable, and readable by Explorer and the taskbar.
#[cfg(windows)]
fn write_shell_link(link: &Path, exe: &Path) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let exe_text = exe.to_string_lossy().into_owned();
    let working_dir = exe
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .unwrap_or_default();

    // SAFETY: COM is initialized on this thread before the objects are created,
    // and every HSTRING outlives the call that reads it.
    unsafe {
        // Anything other than success means COM could not be started here. The
        // usual case is RPC_E_CHANGED_MODE — this thread already owns a
        // different apartment model — which is fine: every apartment can build
        // a shell link, and that state is the caller's to unwind, not ours.
        let owned_apartment = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let written = (|| -> Result<(), String> {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetPath(&HSTRING::from(exe_text.as_str()))
                .map_err(|error| error.to_string())?;
            shell_link
                .SetWorkingDirectory(&HSTRING::from(working_dir.as_str()))
                .map_err(|error| error.to_string())?;
            shell_link
                .SetDescription(&HSTRING::from("Lithic — local-first wiki launcher"))
                .map_err(|error| error.to_string())?;
            // Index 0 of the exe's own icon, so the entry is recognisably Lithic
            // in the Start Menu and on the taskbar once pinned.
            shell_link
                .SetIconLocation(&HSTRING::from(exe_text.as_str()), 0)
                .map_err(|error| error.to_string())?;
            let file: IPersistFile = shell_link.cast().map_err(|error| error.to_string())?;
            // Save writes or overwrites; a stale link would keep pointing at a
            // previous install location after the app is moved.
            file.Save(&HSTRING::from(link.to_string_lossy().as_ref()), true)
                .map_err(|error| error.to_string())
        })();
        if owned_apartment {
            CoUninitialize();
        }
        written
    }
}

/// The user's Start Menu entry for the installed copy.
///
/// Documents\Lithic is on nobody's Start Menu, so without this the app can only
/// be launched by finding the exe. This is what makes it appear under Apps > All
/// so it can be pinned to the taskbar like any other program.
#[cfg(windows)]
fn create_start_menu_shortcut(exe: &Path) -> Result<PathBuf, String> {
    let programs = dirs::data_dir()
        .map(|roaming| roaming.join("Microsoft").join("Windows").join("Start Menu").join("Programs"))
        .ok_or_else(|| "Could not resolve the Start Menu folder".to_string())?;
    fs::create_dir_all(&programs).map_err(|error| error.to_string())?;
    let link = programs.join("Lithic.lnk");
    write_shell_link(&link, exe)?;
    Ok(link)
}

/// Install state for the launcher's PWA-style button: hidden once an
/// installed copy exists and matches the running exe; shown as an update
/// when the installed copy differs (older build).
#[derive(serde::Serialize)]
struct InstallStatus {
    installed: bool,
    up_to_date: bool,
    path: String,
}

#[tauri::command]
fn install_status() -> InstallStatus {
    let target = install_target();
    let installed = target.as_ref().map(|path| path.is_file()).unwrap_or(false);
    let up_to_date = match (target.as_ref(), std::env::current_exe().ok()) {
        (Some(target), Some(exe)) => match (fs::read(target), fs::read(&exe)) {
            (Ok(installed_bytes), Ok(running_bytes)) => installed_bytes == running_bytes,
            _ => false,
        },
        _ => false,
    };
    InstallStatus {
        installed,
        up_to_date,
        path: target
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Copy the running executable to a stable, *visible* per-user location so
/// file associations ("Open with Lithic") survive updates and app moves, and
/// register per-user Windows "Open with" entries for the editor file types.
/// Registration is deliberately non-destructive: it adds Lithic to each
/// extension's Open With list without stealing any default association.
#[tauri::command]
fn install_monolith() -> Result<InstallResult, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;

    // Documents\Lithic\Lithic.exe: user-visible and statically reachable.
    // (Copying a running exe is safe on Windows: the source is locked for
    // write/delete, not for read, so self-copy needs no external download.)
    let target = install_target().ok_or_else(|| "Could not resolve a user program directory".to_string())?;
    let target_dir = target
        .parent()
        .map(|parent| parent.to_path_buf())
        .ok_or_else(|| "Could not resolve a user program directory".to_string())?;

    // Copy only when different to keep timestamps stable across re-installs.
    let needs_copy = match fs::read(&exe) {
        Ok(current) => fs::read(&target).map(|existing| existing != current).unwrap_or(true),
        Err(_) => true,
    };
    if needs_copy {
        fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
        fs::copy(&exe, &target).map_err(|error| error.to_string())?;
    }

    // Tidy up a copy left by an earlier install that used the artifact's
    // own name (e.g. Lithic-Offline.exe) instead of the canonical target.
    if let Some(legacy) = exe.file_name().map(|name| target_dir.join(name)) {
        if legacy != target {
            let _ = fs::remove_file(&legacy);
        }
    }

    // Associations point at the *copied* exe so they stay valid even if the
    // original install location changes.
    #[cfg(windows)]
    if let Err(error) = register_open_with(&target.to_string_lossy()) {
        // Best-effort: the copy already succeeded; surface for debugging.
        eprintln!("Open With registration failed: {}", error);
    }

    // Best effort like the associations: the copy already succeeded, and a
    // missing shortcut should not turn a working install into a failure.
    #[cfg(windows)]
    let start_menu = match create_start_menu_shortcut(&target) {
        Ok(link) => Some(link.to_string_lossy().into_owned()),
        Err(error) => {
            eprintln!("Start Menu shortcut failed: {}", error);
            None
        }
    };
    #[cfg(not(windows))]
    let start_menu: Option<String> = None;

    // Reveal the installed exe in Explorer so the user sees where it went.
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&target)
        .spawn();

    Ok(InstallResult {
        path: target.to_string_lossy().into_owned(),
        start_menu,
    })
}

/// Extensions the desktop app opens, with their Open With descriptions.
#[cfg(windows)]
const ASSOCIATION_TYPES: &[(&str, &str)] = &[
    ("lith", "Lithic Wiki"),
    ("md", "Lithic Markdown"),
    ("txt", "Lithic Text"),
    ("tid", "Lithic Tiddler"),
    ("json", "Lithic JSON"),
    ("ipynb", "Lithic Notebook"),
    ("html", "Lithic HTML"),
];

/// Per-user (HKCU) Open With registration: a ProgID per extension whose
/// open command targets the installed exe, plus an entry appended to the
/// extension's OpenWithProgids list. Never touches default associations.
#[cfg(windows)]
fn register_open_with(exe_path: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|error| error.to_string())?;

    for (ext, description) in ASSOCIATION_TYPES {
        let progid = format!("Lithic.{}", ext);
        let (key, _) = classes
            .create_subkey(&progid)
            .map_err(|error| error.to_string())?;
        key.set_value("", &format!("{} Document", description))
            .map_err(|error| error.to_string())?;
        let (cmd, _) = key
            .create_subkey(r"shell\open\command")
            .map_err(|error| error.to_string())?;
        cmd.set_value("", &format!("\"{}\" \"%1\"", exe_path))
            .map_err(|error| error.to_string())?;

        // Append Lithic to the extension's Open With list via the
        // OpenWithProgids subkey, where each *value name* is a ProgID.
        // Existing entries are preserved; no default association changes.
        let (ext_key, _) = classes
            .create_subkey(format!(".{}", ext))
            .map_err(|error| error.to_string())?;
        let (open_with, _) = ext_key
            .create_subkey("OpenWithProgids")
            .map_err(|error| error.to_string())?;
        open_with
            .set_value(&progid, &String::new())
            .map_err(|error| error.to_string())?;
    }

    // Generic application registration so "Open with" -> "Choose another
    // app" lists Lithic for every supported type. Keyed by the installed
    // binary's file name so it matches wherever the copy lands.
    let installed_name = PathBuf::from(exe_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "lithic.exe".to_string());
    let (app, _) = classes
        .create_subkey(format!(r"Applications\{}", installed_name))
        .map_err(|error| error.to_string())?;
    app.set_value("FriendlyAppName", &"Lithic".to_string())
        .map_err(|error| error.to_string())?;
    let (cmd, _) = app
        .create_subkey(r"shell\open\command")
        .map_err(|error| error.to_string())?;
    cmd.set_value("", &format!("\"{}\" \"%1\"", exe_path))
        .map_err(|error| error.to_string())?;
    // SupportedTypes is likewise a subkey whose value names are the
    // extensions this application can open.
    let (supported, _) = app
        .create_subkey("SupportedTypes")
        .map_err(|error| error.to_string())?;
    for (ext, _) in ASSOCIATION_TYPES {
        supported
            .set_value(format!(".{}", ext), &String::new())
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

// Git for the GitHub sync is in-process via libgit2 — see `gitcore`. There is
// no spawn left anywhere: nothing for the user to install, no PATH to get
// wrong, and no child console window to flash on Windows.

/// Extensions the GitHub sync treats as user documents. Used to report a
/// divergence worth mentioning; every remote-only file is rescued regardless
/// of type so the union push below can never delete one.
const SYNC_DOC_EXTENSIONS: [&str; 7] = ["lith", "json", "md", "tid", "txt", "ipynb", "html"];

/// True for the document types the sync reports on.
fn is_sync_doc(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| SYNC_DOC_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Progress line for the launcher's sync modal. Connect is a handful of long
/// blocking calls (fetch, the rescue writes, commit, push), so the modal shows
/// the stage it is on instead of a dead "Syncing…" label that reads as frozen.
#[derive(Clone, serde::Serialize)]
struct SyncProgress {
    stage: String,
    detail: String,
}

/// What `git_sync_setup` hands back: the summary line for the modal, plus the
/// folder's wikis so a first connect can slot them into recents immediately.
#[derive(serde::Serialize)]
struct GitSyncSetup {
    summary: String,
    recents: Vec<String>,
}

/// A staging line: the total first, then how far along it is, because "0 of
/// 3,910" as the opening line reads like a fault rather than a beginning.
fn stage_label(verb: &str, done: usize, total: usize) -> String {
    if done == 0 {
        format!("{} {} files…", verb, total)
    } else {
        format!("{} {} of {} files…", verb, done, total)
    }
}

/// One stage of the sync: written to the log and emitted to the modal. The log
/// line is why `detail` may be a running count — the modal only needs the
/// latest, but "how far did it get" is the question afterwards. Best effort on
/// the emit: a closed window just means nobody is watching.
fn report(window: &tauri::WebviewWindow, stage: &str, detail: &str) {
    log_sync(&format!("{} · {}", stage, detail));
    let _ = window.emit(
        "git-sync-progress",
        SyncProgress {
            stage: stage.to_string(),
            detail: detail.to_string(),
        },
    );
}

// --- Sync log (disabled) ----------------------------------------------------
// The modal shows one stage and no history, and on Windows this build has no
// console at all, so a sync that stalls or fails leaves nothing to look at
// afterwards. This file used to be that record: which folder, which stage, how
// far it got, and how it ended — appended per stage and rotated at a megabyte.
// It is verbose for ordinary use, so it is commented out; uncomment the block
// below to bring it back for troubleshooting.
//
// To re-enable: restore the static and `sync_log_path` here, then uncomment the
// body of `log_sync` below (the `[+Ns]` offset comes from `SYNC_STARTED`, which
// marks where the current run began, so a stall can be measured from one run's
// start without needing a calendar in a build that has no date library).
// static SYNC_STARTED: Mutex<Option<std::time::Instant>> = Mutex::new(None);
//
// fn sync_log_path() -> Option<PathBuf> {
//     dirs::data_local_dir().map(|dir| dir.join("Lithic").join("sync.log"))
// }

fn log_sync(message: &str) {
    // Body commented out; see the note above. The calls stay in place so
    // re-enabling is a matter of uncommenting here, not rethreading them.
    let _ = message;
    /*
    let Some(path) = sync_log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(&path)
        .map(|meta| meta.len() > 1_000_000)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&path);
    }
    let elapsed = SYNC_STARTED
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .map(|started| started.elapsed().as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[+{}s] {}", elapsed, message);
    }
    */
}

/// Start a run's log: the marker line, then the folder this run acts on.
/// No-op while verbose sync logging is commented out.
fn begin_sync_log(_dir: &Path, _repo: &str) {}

/// What the first-connect merge did, for the message the launcher shows.
#[derive(Debug, Default, PartialEq, Eq)]
struct SyncMerge {
    /// Remote files the local folder did not have; brought down.
    rescued: Vec<String>,
    /// Documents present on both sides with different content. The folder's
    /// copy is kept, so these are reported rather than acted on.
    diverged: Vec<String>,
}

/// The desktop counterpart of the self-host `/setup` rescue step
/// (deploy/github-sync.sh): fetch (never merge working trees), then bring down
/// everything only the remote has.
///
/// The folder is the source of truth and GitHub is the backup, so a document
/// that exists on both sides with different content keeps its local copy — the
/// same thing an ordinary save does, since `git_sync_commit` never pulls.
/// Nothing is ever overwritten on this side, and the remote's previous copy
/// stays in the repository's history.
///
/// Every remote-only file is rescued, not just documents: the push that follows
/// rewrites the remote branch, so anything left behind would be deleted from
/// GitHub. Offline, or a remote branch that does not exist yet, leaves the
/// folder untouched.
fn merge_with_remote_branch(
    dir: &Path,
    progress: &dyn Fn(&str, &str),
) -> Result<SyncMerge, String> {
    let mut merge = SyncMerge::default();
    let repo = gitcore::open(dir)?;
    let url = gitcore::remote_url(&repo, "origin").unwrap_or_default();
    progress("fetch", "Fetching from GitHub…");
    if !gitcore::fetch_main(&repo, &url)? {
        return Ok(merge);
    }
    // Remote-only entries are the slowest part of a first connect on a big
    // repo, so count them up front and report each one as it lands.
    progress("merge", "Comparing with GitHub…");
    let files = match gitcore::files_at(&repo, gitcore::REMOTE_MAIN) {
        Ok(files) => files,
        Err(_) => return Ok(merge),
    };

    let remote_only = files
        .iter()
        .filter(|entry| !dir.join(entry.as_str()).exists())
        .count();
    if remote_only > 0 {
        progress(
            "pull",
            &format!(
                "Pulling {} file{} from GitHub…",
                remote_only,
                if remote_only == 1 { "" } else { "s" }
            ),
        );
    }
    let mut pulled = 0usize;

    for entry in files {
        // Checked per file rather than per stage: a first connect to a repository
        // with thousands of files spends its whole time in this loop, and
        // Cancel has to land somewhere inside it.
        if gitcore::cancelled() {
            return Err("Sync cancelled.".to_string());
        }
        let local = dir.join(&entry);
        if !local.exists() {
            if let Some(parent) = local.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            // Written from the object database rather than checked out, so the
            // bytes are exactly what GitHub holds: no line-ending filter can
            // rewrite a rescued document on its way to disk.
            let bytes = gitcore::bytes_at(&repo, gitcore::REMOTE_MAIN, &entry)?;
            fs::write(&local, bytes).map_err(|error| error.to_string())?;
            pulled += 1;
            if remote_only > 1 {
                progress(
                    "pull",
                    &format!("Pulled {}/{} · {}", pulled, remote_only, entry),
                );
            }
            merge.rescued.push(entry);
            continue;
        }
        if !is_sync_doc(&entry) {
            continue;
        }
        let identical = gitcore::bytes_at(&repo, gitcore::REMOTE_MAIN, &entry)
            .map(|remote| fs::read(&local).map(|local| local == remote).unwrap_or(false))
            .unwrap_or(false);
        if identical {
            // Byte-identical to the remote copy: nothing to report.
            continue;
        }
        merge.diverged.push(entry);
    }

    Ok(merge)
}

/// Point the folder at a remote, merge in what only the remote has, and
/// publish the union. Split out from the command so the whole connect flow can
/// run against a local remote in tests; `remote_url` already embeds the token.
fn sync_with_remote(
    dir: &Path,
    remote_url: &str,
    progress: &dyn Fn(&str, &str),
) -> Result<SyncMerge, String> {
    let created = !dir.join(".git").is_dir();
    let repo = if created {
        gitcore::init(dir)?
    } else {
        gitcore::open(dir)?
    };
    gitcore::ensure_identity(&repo);
    let _ = gitcore::remove_remote(&repo, "origin");
    gitcore::set_remote(&repo, "origin", remote_url)?;
    // Attached now, whatever a Disconnect once said about this folder.
    gitcore::clear_detached(&repo);
    log_sync(&format!(
        "repository {} ({})",
        if created { "created" } else { "opened" },
        dir.display()
    ));

    // A commit must exist before the merge can compare against the remote and
    // before a branch can be pushed.
    if !gitcore::head_exists(&repo) {
        progress("commit", "Committing the folder's files…");
        let staged = gitcore::stage_working_tree(
            &repo,
            Some(gitcore::FIRST_SYNC_FILE_CAP),
            gitcore::cancelled,
            |done, total| progress("commit", &stage_label("Committing", done, total)),
        )?;
        log_sync(&format!(
            "first connect staged {} files (over_cap {} cancelled {})",
            staged.files, staged.over_cap, staged.cancelled
        ));
        // Both exits leave the folder as it was found: nothing staged, nothing
        // committed, and a repository Lithic created is removed again. A
        // declined or cancelled first connect must not leave a `.git` sitting in
        // somebody's Downloads folder.
        if staged.over_cap || staged.cancelled {
            let _ = gitcore::remove_remote(&repo, "origin");
            drop(repo);
            if created {
                let _ = fs::remove_dir_all(dir.join(".git"));
            }
            return Err(if staged.over_cap {
                // The count is exact, because the walk only counts here: nothing
                // was hashed and the index is untouched.
                format!(
                    "This folder holds {} files. Back up the folder your liths live in.",
                    staged.files
                )
            } else {
                "Sync cancelled.".to_string()
            });
        }
        gitcore::commit(&repo, "Initial sync from Lithic", true)?;
    }

    // Everything only GitHub has comes down, the folder keeps its own version of
    // anything that exists on both sides, and then the union goes up.
    let merge = merge_with_remote_branch(dir, progress)?;
    log_sync(&format!(
        "merged: {} rescued, {} kept local",
        merge.rescued.len(),
        merge.diverged.len()
    ));
    if gitcore::cancelled() {
        return Err("Sync cancelled.".to_string());
    }

    progress("commit", "Recording the merged state…");
    let staged = gitcore::stage_working_tree(
        &repo,
        None,
        gitcore::cancelled,
        |done, total| progress("commit", &stage_label("Recording", done, total)),
    )?;
    if staged.cancelled {
        return Err("Sync cancelled.".to_string());
    }
    gitcore::commit(&repo, "System: finalize GitHub sync", false)?;
    gitcore::set_upstream(&repo, "origin", "main");
    progress("push", "Pushing to GitHub…");
    gitcore::push_main(&repo, remote_url, true)?;
    Ok(merge)
}

/// Set up the directory containing `path` as a git repo synced to a GitHub
/// remote — the desktop counterpart of the self-host github-sync workflow:
/// init (if needed), point origin at the repo with the token embedded (same as
/// self-host's oauth2 URL), run the same first-connect merge the CGI does —
/// remote-only files come down, a name clash keeps the local copy — then
/// publish the union, then hand back the folder's wikis so a first connect can
/// populate the launcher's recents. The git work is blocking (libgit2
/// fetch/commit/push over HTTPS), so it runs on the blocking pool rather than
/// holding an async worker for the length of a network round trip, and each
/// stage is reported to the modal as it starts.
#[tauri::command]
async fn git_sync_setup(
    path: String,
    repo: String,
    token: String,
    window: tauri::WebviewWindow,
) -> Result<GitSyncSetup, String> {
    let dir = sync_dir_of(Path::new(&path))
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?;
    let repo = repo.trim().trim_end_matches(".git").trim().to_string();
    if repo.is_empty() || token.trim().is_empty() {
        return Err("Both repository (owner/name) and token are required".to_string());
    }

    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<GitSyncSetup, String> {
        let url = sync_remote_url(&repo, token.trim());
        // A request left over from a previous run would cancel this one before it
        // did anything.
        gitcore::clear_cancel();
        begin_sync_log(&dir, &repo);
        // The cancel flag belongs to this run and not to the app: left set after a
        // cancelled connect it would abort the next save's push, which would then
        // report a failed backup over a backup nobody asked it to stop.
        let merge = match sync_with_remote(&dir, &url, &|stage, detail| report(&window, stage, detail)) {
            Ok(merge) => {
                gitcore::clear_cancel();
                merge
            }
            Err(error) => {
                gitcore::clear_cancel();
                return Err(error);
            }
        };

        let mut summary = format!("Backed up to github.com/{}", repo);
        if !merge.rescued.is_empty() {
            summary.push_str(&format!(" · pulled {} from GitHub", merge.rescued.len()));
        }
        if !merge.diverged.is_empty() {
            summary.push_str(&format!(" · kept {} local", merge.diverged.len()));
        }
        log_sync(&format!("done · {}", summary));
        Ok(GitSyncSetup {
            summary,
            recents: list_lith_wikis(&dir, WIKI_LIST_LIMIT),
        })
    })
    .await;
    match outcome {
        Ok(Ok(setup)) => Ok(setup),
        Ok(Err(error)) => {
            log_sync(&format!("failed · {}", error));
            Err(error)
        }
        Err(error) => {
            log_sync(&format!("failed · {}", error));
            Err(error.to_string())
        }
    }
}

/// Stop the running connect at its next checkpoint.
///
/// Returns immediately: the work carries on to the end of whatever libgit2 call
/// it is inside, then unwinds and reports its own outcome. The launcher must
/// therefore keep showing progress until `git_sync_setup` itself answers rather
/// than treating this as having finished the job.
#[tauri::command]
fn git_sync_cancel() {
    gitcore::cancel();
}

/// Absolute paths of the folder's own `.lith` wikis, newest first: what a first
/// connect drops into the launcher's recents, so the wikis GitHub just handed
/// the user are visible without hunting through the mount dialog.
///
/// Flat on purpose — top-level files only, nothing from subfolders. A synced
/// folder is one unit the user adds, and wikis that ride along from deeper in
/// the tree are the ones that later become a support headache: rename the
/// parent and the backup quietly stops matching. A subfolder worth backing up
/// is a folder the user adds on its own.
///
/// `max_results` is a parameter because the two callers want different things:
/// a first connect samples the newest wikis to put a few rows in front of the
/// user, while a rebuild re-indexes as much as it can find.
const WIKI_LIST_LIMIT: usize = 20;
const REINDEX_LIST_LIMIT: usize = 500;

fn list_lith_wikis(dir: &Path, max_results: usize) -> Vec<String> {
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".lith") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push((modified, entry.path().to_string_lossy().into_owned()));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found
        .into_iter()
        .take(max_results)
        .map(|(_, path)| path)
        .collect()
}

/// The managed repository backing each of these wiki paths, as the folder that
/// contains it — absent when no repository covers the path.
///
/// Walks *up* from each file, because the commit does: staging is recursive, so
/// a wiki in `Lithic/projects/` really is published by the repository at
/// `Lithic/`. Reporting it as un-backed-up would be false, and worse, it would
/// point the user at "back up this folder" for a folder inside a repository —
/// which git handles badly. Answering this in one call also spares the desktop
/// app a status round trip per ancestor per row.
///
/// Discovery stays flat (`list_lith_wikis`); this only resolves containment for
/// a file the user already has in front of them.
#[tauri::command]
fn git_sync_coverage(paths: Vec<String>) -> std::collections::HashMap<String, String> {
    let mut backed: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for path in paths {
        if let Some(root) = sync_dir_of(Path::new(&path)).and_then(|dir| managed_root_for(&dir)) {
            backed.insert(path.clone(), root.to_string_lossy().into_owned());
        }
    }
    backed
}

/// The folder a sync path names: the path itself when it is a folder, else the
/// folder holding it.
///
/// Commands address a Lith, but the launcher also hands over a folder once it has
/// resolved which folder the backup acts on, and a rebuild hands over whichever of
/// the two it holds. Accepting both keeps one command serving both callers, rather
/// than a mode flag or a second command per subject.
fn sync_dir_of(given: &Path) -> Option<PathBuf> {
    if given.is_dir() {
        return Some(given.to_path_buf());
    }
    given.parent().map(Path::to_path_buf)
}

/// Whether this folder is itself a repository Lithic manages.
///
/// The marker is an origin URL Lithic wrote, with the token embedded — the same
/// one self-host writes — and it is what keeps a git folder the user made
/// themselves out of every automatic commit and push.
fn is_managed_dir(dir: &Path) -> bool {
    dir.join(".git").is_dir() && managed_remote_url(dir).is_some()
}

/// Whether a Lithic attachment here is *finished*: the marker **and** a commit.
///
/// A stricter question than `is_managed_dir`, and deliberately so. A connect that
/// was killed, or refused for the folder holding thousands of files, leaves the
/// marker behind with no commit — measured on the user's machine, a Downloads
/// folder carrying `remote.origin.url` and no branch at all. Treating that as an
/// attachment is what would keep aiming the backup at the folder that failed. A save
/// is still committed into such a folder (a save only needs the marker); what it
/// cannot do is outrank the folder the user actually attached.
fn is_attached(dir: &Path) -> bool {
    is_managed_dir(dir) && has_commit(dir)
}

/// Whether Lithic has ever committed here — so a repository it made is on disk,
/// whatever became of the remote.
fn has_commit(dir: &Path) -> bool {
    gitcore::open(dir)
        .map(|repo| gitcore::head_exists(&repo))
        .unwrap_or(false)
}

/// Whether the folder the app is installed in leaves a repository a previous
/// attachment made, which is the one thing `is_attached` cannot tell apart from a
/// first connect.
///
/// The marker is deliberately not required here, and that asymmetry is the point:
/// `is_attached` walks up from a file the user happened to open — possibly inside a
/// source checkout — so it demands positive proof the folder is Lithic's, while these
/// are only ever the app's own folders. Meanwhile a remote *can* legitimately be gone
/// while the attachment is real: a Disconnect removes it, and a stalled connect can
/// lose it. A commit is what a previous attachment leaves behind either way — the
/// measured case being the user's `Documents\Lithic`, whose commits survive and whose
/// origin does not. A repository the user deliberately disconnected is not preferred
/// again (`lithic.detached`), which is also the only way to point the backup at a
/// different folder afterwards.
fn is_left_repository(dir: &Path) -> bool {
    if !dir.join(".git").is_dir() || !has_commit(dir) {
        return false;
    }
    gitcore::open(dir)
        .map(|repo| !gitcore::is_detached(&repo))
        .unwrap_or(false)
}

/// Every folder at or above `dir`, nearest first. Walks up because that is what a
/// commit does: staging is recursive, so a wiki in a subfolder is published by the
/// repository at the root.
fn walk_up(dir: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    std::iter::successors(Some(dir.to_path_buf()), |current| {
        current.parent().map(Path::to_path_buf)
    })
}

/// The nearest folder at or above `dir` that is a repository Lithic manages.
fn managed_root_for(dir: &Path) -> Option<PathBuf> {
    walk_up(dir).find(|candidate| is_managed_dir(candidate))
}

/// The nearest folder at or above `dir` that is a finished attachment.
fn attached_root_for(dir: &Path) -> Option<PathBuf> {
    walk_up(dir).find(|candidate| is_attached(candidate))
}

/// The folder the app installs itself into — `Documents\Lithic`, or the fallback
/// `install_target` names when Documents is not available.
fn install_folder() -> Option<PathBuf> {
    install_target().and_then(|target| target.parent().map(Path::to_path_buf))
}

/// Where a Lithic library lives, best first.
///
/// `Documents\Lithic` is the folder the app installs into and the one liths are
/// meant to live in, so it is the first candidate whether or not the app was
/// installed from here. The running exe's own folder is the second: a portable or
/// thumb-drive bundle keeps its liths beside the program, which is also where the
/// mount dialog starts looking.
fn library_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    if let Some(dir) = install_folder() {
        folders.push(dir);
    }
    if let Some(dir) = exe_dir() {
        if !folders.contains(&dir) {
            folders.push(dir);
        }
    }
    folders
}

/// The folder Lithic itself prefers, given the path the launcher derived on its
/// own. Two rules, in this order:
///
/// 1. the folder behind `derived`, when Lithic already backs it up — the Lith the
///    user is looking at is the one they mean;
/// 2. a library folder a previous attachment left a repository in.
///
/// The second rule is what stops a stray file from moving the backup: save one
/// exported Lith into Downloads and it becomes the newest recent row, and the
/// folder derived from that row would otherwise become what the next connect
/// commits — the measured failure this exists to prevent, a first connect aimed at
/// a Downloads folder of 3,910 files. Nothing here overrules a folder the launcher
/// derived from the picker: `None` means the caller keeps what it chose, which is
/// also what a Disconnect leaves behind — the folder you are working in is the next
/// thing the dialog proposes.
fn preferred_sync_folder(derived: Option<&Path>, libraries: &[PathBuf]) -> Option<PathBuf> {
    if let Some(root) = derived.and_then(sync_dir_of).and_then(|dir| attached_root_for(&dir)) {
        return Some(root);
    }
    libraries.iter().find(|dir| is_left_repository(dir)).cloned()
}

/// The folder the backup should act on, with the user's own pick in front of Lithic's
/// inference.
///
/// A separate function rather than a rule inside `preferred_sync_folder` on purpose: that
/// one is Lithic working out which folder the user means from evidence, and this is the
/// user having said so. The order is deliberate and so is the check — a recorded folder
/// that is not on this machine falls through to the inference instead of naming a path
/// that is not there.
fn resolved_sync_folder(chosen: Option<&Path>, derived: Option<&Path>, libraries: &[PathBuf]) -> Option<PathBuf> {
    if let Some(dir) = chosen.filter(|dir| dir.is_dir()) {
        return Some(dir.to_path_buf());
    }
    preferred_sync_folder(derived, libraries)
}

/// Whether a folder keeps a Lith of its own. Flat, because that is how every other
/// reader here lists a folder: a wiki in a subfolder belongs to that subfolder.
fn holds_a_lith(dir: &Path) -> bool {
    !list_lith_wikis(dir, 1).is_empty()
}

/// The folder to propose when Lithic has nothing of its own to go on: a fresh download
/// with no recents, no open Lith and no repository anywhere.
///
/// The running exe's own folder, but only where that folder is evidence rather than an
/// accident of where the program was unzipped. Evidence is the app's own install folder
/// (`Documents\Lithic`, where liths are meant to live, and where the installer puts the
/// program) or a bundle that already keeps a Lith beside the program, which is the
/// portable case this rule exists for. Anywhere else says nothing about where the liths
/// are: a Downloads folder, an extracted zip, a `Program Files` install. And a proposal
/// is not free, because the first connect commits what it finds and a repository that
/// exists is what every rule above it prefers from then on — the measured version of
/// that mistake being a first connect aimed at a Downloads folder of 3,910 files.
/// Failing both, the folder the app installs into, when it is on disk; failing that,
/// nothing, and the dialog asks instead of guessing.
fn proposed_sync_folder(exe: Option<&Path>, install: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = exe {
        if install == Some(dir) || holds_a_lith(dir) {
            return Some(dir.to_path_buf());
        }
    }
    install.filter(|dir| dir.is_dir()).map(Path::to_path_buf)
}

/// The folder the backup acts on, in the order the answers outrank each other: the pick
/// recorded in the sidecar, then Lithic's inference, then — only when the launcher had no
/// subject of its own — the proposed folder.
///
/// The proposal is last and conditional, which is the whole reason it is here rather than
/// another rule inside `preferred_sync_folder`: a derived path is the launcher saying which
/// Lith the user is looking at, and the folder that path implies beats a proposal about the
/// program's own folder. A proposal that outranked it would aim the backup at the folder
/// the app happens to sit in while the user was working somewhere else entirely.
fn answer_folder(
    chosen: Option<&Path>,
    derived: Option<&Path>,
    libraries: &[PathBuf],
    proposal: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(dir) = resolved_sync_folder(chosen, derived, libraries) {
        return Some(dir);
    }
    if derived.is_some() {
        return None;
    }
    proposal.map(Path::to_path_buf)
}

/// What `git_sync_folder` answers, and why it is two fields rather than one: the dialog
/// names the folder it is about to act on, and it also has to know whether that folder is
/// the user's own pick — the only case where offering to go back to the automatic one makes
/// sense.
#[derive(serde::Serialize)]
struct SyncFolderAnswer {
    /// `None` means nothing is attached near either and nothing can be proposed, and the
    /// launcher draws the folder line empty — see `preferred_sync_folder` and
    /// `proposed_sync_folder`.
    folder: Option<String>,
    /// The folder in force is the one the sidecar records, not one Lithic worked out.
    overridden: bool,
}

/// The folder the desktop app's backup should act on, given the path the launcher derived
/// for itself.
#[tauri::command]
fn git_sync_folder(derived: Option<String>) -> SyncFolderAnswer {
    let chosen = chosen_sync_folder();
    // An empty string is a launcher with nothing to name, not a folder called nothing.
    let derived = derived.filter(|path| !path.trim().is_empty());
    let proposal = proposed_sync_folder(exe_dir().as_deref(), install_folder().as_deref());
    let folder = answer_folder(
        chosen.as_deref(),
        derived.as_deref().map(Path::new),
        &library_folders(),
        proposal.as_deref(),
    );
    SyncFolderAnswer {
        folder: folder.map(|dir| dir.to_string_lossy().into_owned()),
        overridden: chosen.is_some(),
    }
}

/// Every `.lith` under a folder, for the launcher's re-index.
///
/// Accepts a folder or any file inside it, so the caller can hand over the same
/// path it uses as its sync target without knowing which it holds.
#[tauri::command]
fn list_folder_liths(path: String) -> Vec<String> {
    let Some(dir) = sync_dir_of(Path::new(&path)) else {
        return Vec::new();
    };
    list_lith_wikis(&dir, REINDEX_LIST_LIMIT)
}

/// The origin URL of a folder Lithic manages, if it manages one. Saves only
/// auto-commit in these repositories: Lithic's remotes embed the oauth2 token
/// (the marker self-host uses too), so opening a file from a git folder the
/// user made themselves never causes it to be committed or pushed anywhere.
fn managed_remote_url(dir: &Path) -> Option<String> {
    let repo = gitcore::open(dir).ok()?;
    let url = gitcore::remote_url(&repo, "origin")?;
    url.contains("oauth2:").then_some(url)
}

/// Lithic's remote shape: the token is embedded in the URL, exactly as
/// self-host's github-sync.sh writes it, and it doubles as the marker that
/// tells us a folder is ours to commit into. One function builds it so the
/// connect path and the reconnect path cannot drift apart.
fn sync_remote_url(repo: &str, token: &str) -> String {
    format!("https://oauth2:{}@github.com/{}.git", token, repo)
}

/// A managed remote taken apart. The embedded token is what marks the folder
/// as ours; owner/name are what a health check needs to address the repository.
#[derive(Debug, PartialEq, Eq)]
struct ManagedRemote {
    owner: String,
    name: String,
    token: String,
}

/// Split `https://oauth2:<token>@github.com/<owner>/<name>.git` back into its
/// parts, for the callers that need the repository and the credential rather
/// than the raw URL.
///
/// Lenient about the path — a missing `.git` or a trailing slash still parses —
/// because this also reads remotes an older Lithic or self-host may have
/// written. A URL that carries the marker but cannot be read reports as
/// malformed to the user, which is a state reconnect can repair.
fn parse_managed_remote(url: &str) -> Option<ManagedRemote> {
    let (userinfo, host_and_path) = url.split_once("://")?.1.split_once('@')?;
    let token = userinfo.strip_prefix("oauth2:")?.trim();
    if token.is_empty() {
        return None;
    }
    let path = host_and_path.split_once('/')?.1.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(ManagedRemote {
        owner: owner.to_string(),
        name: name.to_string(),
        token: token.to_string(),
    })
}

/// What one save's backup did.
///
/// `pushed: false` with no error means there was nothing for Lithic to do — the
/// folder is not a managed sync repository. With an error it means the copy on
/// GitHub is now behind. Either way the save itself succeeded, which is why a
/// failed push is reported here rather than returned as a failure: an offline
/// save must still work.
#[derive(serde::Serialize)]
struct GitSyncCommit {
    /// The folder is a Lithic-managed repository, so this save was a backup.
    /// Told apart from "nothing to do" because only a real push proves the
    /// connection works, and the launcher must not read silence as success.
    managed: bool,
    pushed: bool,
    error: Option<String>,
}

impl GitSyncCommit {
    fn nothing() -> Self {
        Self { managed: false, pushed: false, error: None }
    }

    fn ok() -> Self {
        Self { managed: true, pushed: true, error: None }
    }

    fn failed(error: String) -> Self {
        Self { managed: true, pushed: false, error: Some(error) }
    }
}

/// What this app has done about backups since it started: why each folder's last
/// backup failed, if it did, and which backups are running right now.
///
/// The save that fails happens inside the engine document, which is a rewrite of
/// the launcher page — so the event it fires has nowhere to land, and the icon
/// only learns about it when the launcher comes back. Remembering the outcome
/// here is what makes a backup that stopped landing visible at all, instead of a
/// log line nobody reads.
///
/// "Running right now" is recorded for the same reason in reverse: coming back
/// from a wiki reloads the launcher, and the push triggered by that wiki's exit
/// save is still in progress in Rust. Without this the icon would look idle
/// while a backup is genuinely under way.
#[derive(Default)]
struct CommitLog {
    failures: Mutex<std::collections::HashMap<String, String>>,
    /// Counted rather than flagged, so two backups of one folder cannot clear the
    /// mark when only the first of them finishes.
    in_flight: Mutex<std::collections::HashMap<String, u32>>,
}

impl CommitLog {
    /// `None` clears the folder: a push that landed is the fix, so there is
    /// nothing left to warn about.
    fn record(&self, folder: &str, error: Option<String>) {
        let Ok(mut log) = self.failures.lock() else { return };
        match error {
            Some(error) => {
                log.insert(folder.to_string(), error);
            }
            None => {
                log.remove(folder);
            }
        }
    }

    fn last_error(&self, folder: &str) -> Option<String> {
        self.failures.lock().ok()?.get(folder).cloned()
    }

    /// A backup of this folder has started. Called before the git work, because
    /// the push — the long part — is what the launcher can come back and ask
    /// about.
    fn begin(&self, folder: &str) {
        let Ok(mut map) = self.in_flight.lock() else { return };
        *map.entry(folder.to_string()).or_insert(0) += 1;
    }

    /// That backup finished, however it finished.
    fn finish(&self, folder: &str) {
        let Ok(mut map) = self.in_flight.lock() else { return };
        match map.get_mut(folder) {
            Some(count) if *count > 1 => *count -= 1,
            _ => {
                map.remove(folder);
            }
        }
    }

    fn in_flight(&self, folder: &str) -> bool {
        self.in_flight
            .lock()
            .map(|map| map.contains_key(folder))
            .unwrap_or(false)
    }
}

/// The log's key for a folder: separators normalized, because the same folder
/// arrives here from the engine's own saver and from the launcher's recent list,
/// and those two do not have to spell it with the same slash. A key that missed
/// would silently drop the one signal that a backup stopped landing.
fn folder_key(dir: &Path) -> String {
    dir.to_string_lossy().replace('\\', "/")
}

/// Process-wide on purpose: this is process-scoped truth about what this app has
/// done since it started, and the commands that read and write it are stateless
/// by design (an async command holding a managed `State` borrow cannot span an
/// await, which is exactly what a heartbeat does).
static COMMIT_LOG: std::sync::OnceLock<CommitLog> = std::sync::OnceLock::new();

fn commit_log() -> &'static CommitLog {
    COMMIT_LOG.get_or_init(CommitLog::default)
}

/// The synchronous half: stage the file, commit it, and push.
fn commit_saved_file(
    dir: &Path,
    file: &Path,
    url: &str,
    message: &str,
) -> Result<GitSyncCommit, String> {
    let repo = gitcore::open(dir)?;
    gitcore::ensure_identity(&repo);

    let Some(file_name) = file.file_name().and_then(|name| name.to_str()) else {
        return Ok(GitSyncCommit::nothing());
    };
    gitcore::stage_path(&repo, file_name)?;
    gitcore::commit(&repo, message, false)?;
    // Push best-effort: offline saves must still succeed locally. The failure
    // travels back to the launcher instead of only into a log line, so a green
    // icon can never sit over a backup that stopped landing.
    match gitcore::push_main(&repo, url, false) {
        Ok(()) => Ok(GitSyncCommit::ok()),
        Err(error) => {
            eprintln!("git push skipped: {}", error);
            Ok(GitSyncCommit::failed(error))
        }
    }
}

/// Auto-commit of one saved file, recording what the backup did so the launcher
/// can report it later. Skips non-synced folders so plain saves never error, and
/// runs the git work — including a network push — on the blocking pool rather
/// than holding an async worker for the length of a round trip.
async fn git_sync_commit_inner(
    path: String,
    message: String,
    log: &CommitLog,
) -> Result<GitSyncCommit, String> {
    let file = PathBuf::from(&path);
    let dir = match file.parent().filter(|parent| parent.is_dir()) {
        Some(dir) => dir.to_path_buf(),
        None => return Ok(GitSyncCommit::nothing()),
    };
    if !dir.join(".git").is_dir() {
        return Ok(GitSyncCommit::nothing());
    }
    // A save is not the operation a Connect's Cancel was aimed at, so it starts
    // with a clean flag: only a request that arrives while this push is in
    // flight can stop it.
    gitcore::clear_cancel();
    // Only auto-commit in repos Lithic configured itself: its remotes embed
    // the oauth2 token, mirroring self-host, so a git folder the user opened a
    // file from is never touched by saves.
    let Some(url) = managed_remote_url(&dir) else {
        return Ok(GitSyncCommit::nothing());
    };
    let folder = folder_key(&dir);
    // Bracket the whole git call, push included: this is what lets the launcher
    // show "syncing" for a backup that outlives the wiki page that started it.
    log.begin(&folder);
    let joined = tauri::async_runtime::spawn_blocking(move || {
        commit_saved_file(&dir, &file, &url, &message)
    })
    .await;
    // Cleared before the join is inspected, so a task that died cannot leave the
    // icon pulsing forever.
    log.finish(&folder);
    let outcome = joined.map_err(|error| error.to_string())?;

    match outcome {
        Ok(commit) => {
            log.record(&folder, commit.error.clone());
            Ok(commit)
        }
        Err(error) => {
            // A stage or commit failure is just as much a backup that did not
            // happen as a rejected push.
            log.record(&folder, Some(error.clone()));
            Err(error)
        }
    }
}

#[tauri::command]
async fn git_sync_commit(path: String, message: String) -> Result<GitSyncCommit, String> {
    git_sync_commit_inner(path, message, commit_log()).await
}

// --- GitHub OAuth device flow ------------------------------------------------
// The self-host launcher proxies these two GitHub endpoints through its CGI
// handler (deploy/github-sync.sh) because a browser can't call them directly.
// The desktop app has no such restriction: tauri::api::http (reqwest) calls
// GitHub from Rust, so the same GitHub App device flow works server-free.

/// Device-flow app client id (the "Lithic Sync" GitHub App). Same shape as
/// self-host's GITHUB_CLIENT_ID; overridable for local testing.
fn github_client_id() -> String {
    std::env::var("GITHUB_CLIENT_ID")
        .unwrap_or_else(|_| "Iv23lippjEJMp4KLlLKI".to_string())
}

/// One shared outbound HTTP client.
///
/// reqwest's client owns the connection pool and the TLS configuration, and v1's
/// `tauri::api::http` wrapper built a fresh one per call — the device flow polls
/// every few seconds, so that re-handshook on every poll. Redirects are capped
/// rather than unlimited: GitHub and a self-hosted instance each answer with a
/// small number of their own, and nothing here should be walked further.
fn http_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(3))
                .build()
                .ok()
        })
        .as_ref()
}

async fn github_post_form(url: &str, form: &str) -> Result<serde_json::Value, String> {
    let client = http_client().ok_or_else(|| "no HTTP client".to_string())?;
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form.to_string())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    // Deliberately not `error_for_status`: GitHub reports an expired device code
    // and a rate limit as a 4xx whose *body* says so, and the poller reads it.
    response.json().await.map_err(|error| error.to_string())
}

async fn github_api_get(url: &str, token: &str) -> Result<serde_json::Value, String> {
    let client = http_client().ok_or_else(|| "no HTTP client".to_string())?;
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Lithic-Sync")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(format!("GitHub API returned {}", status));
    }
    response.json().await.map_err(|error| error.to_string())
}

async fn github_api_post(url: &str, token: &str, json: &serde_json::Value) -> Result<serde_json::Value, String> {
    let client = http_client().ok_or_else(|| "no HTTP client".to_string())?;
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Lithic-Sync")
        .header("Content-Type", "application/json")
        .json(json)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    // Parsed tolerantly: the error message is worth having, but a non-JSON error
    // page must still surface as the status rather than a decode failure.
    let data = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    if status >= 400 {
        let message = data
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("request failed");
        return Err(format!("GitHub API error ({}): {}", status, message));
    }
    Ok(data)
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|field| field.as_str()).map(|field| field.to_string())
}

/// Step 1 of the device flow: ask GitHub for a user code to authorize the
/// Lithic Sync app. Mirrors self-host's /api/github/device-code handler.
#[tauri::command]
async fn github_device_code() -> Result<serde_json::Value, String> {
    let form = format!("client_id={}&scope=repo", github_client_id());
    let data = github_post_form("https://github.com/login/device/code", &form).await?;
    if let Some(error) = json_str(&data, "error") {
        return Err(json_str(&data, "error_description").unwrap_or(error));
    }
    Ok(data)
}

/// Step 2 of the device flow: poll the token endpoint while the user
/// authorizes. Returns `pending` until GitHub issues the access token.
#[tauri::command]
async fn github_device_poll(device_code: String) -> Result<serde_json::Value, String> {
    let form = format!(
        "client_id={}&device_code={}&grant_type=urn:ietf:params:oauth:grant-type:device_code",
        github_client_id(),
        device_code
    );
    let data = github_post_form("https://github.com/login/oauth/access_token", &form).await?;
    if let Some(token) = json_str(&data, "access_token") {
        return Ok(serde_json::json!({ "access_token": token }));
    }
    match json_str(&data, "error").as_deref() {
        // Expected while the user is still typing the code.
        Some("authorization_pending") => Ok(serde_json::json!({ "pending": true })),
        // GitHub asks the client to back off; surfaced so the poller can wait longer.
        Some("slow_down") => Ok(serde_json::json!({ "pending": true, "slow_down": true })),
        Some(error) => Err(json_str(&data, "error_description").unwrap_or_else(|| error.to_string())),
        None => Err("GitHub did not return a token".to_string()),
    }
}

#[derive(serde::Serialize)]
struct ManagedRepo {
    full_name: String,
}

/// Repos the user owns, filtered client-side by the UI for Lithic-managed
/// names (parity with self-host's /api/github/list-repos).
#[tauri::command]
async fn github_list_repos(token: String) -> Result<Vec<ManagedRepo>, String> {
    let data = github_api_get(
        "https://api.github.com/user/repos?type=owner&sort=updated&per_page=100",
        token.trim(),
    )
    .await?;
    let array = match data.as_array() {
        Some(array) => array.clone(),
        None => return Err("Unexpected response from GitHub".to_string()),
    };
    Ok(array
        .iter()
        .filter_map(|repo| {
            let full_name = json_str(repo, "full_name")?;
            Some(ManagedRepo { full_name })
        })
        .collect())
}

/// Create a private sync repo (parity with self-host's /api/github/create-repo).
#[tauri::command]
async fn github_create_repo(token: String, name: String) -> Result<ManagedRepo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Repository name is required".to_string());
    }
    let data = github_api_post(
        "https://api.github.com/user/repos",
        token.trim(),
        &serde_json::json!({
            "name": name,
            "private": true,
            "description": "Lithic Automated Sync"
        }),
    )
    .await?;
    let full_name = json_str(&data, "full_name").ok_or_else(|| "GitHub did not return the new repository".to_string())?;
    Ok(ManagedRepo { full_name })
}

#[derive(serde::Serialize)]
struct GitSyncStatus {
    connected: bool,
    repo: String,
    /// A backup of this folder is running right now, so the launcher can say so
    /// instead of showing an idle icon over work in progress.
    in_flight: bool,
}

/// Status for the reactive sync icon: connected only when the file's folder
/// is a git repo whose origin was configured by Lithic (oauth2 remote, same
/// marker git_sync_commit uses).
#[tauri::command]
fn git_sync_status(path: String) -> Option<GitSyncStatus> {
    let dir = sync_dir_of(Path::new(&path))?;
    if !dir.join(".git").is_dir() {
        return None;
    }
    let url = managed_remote_url(&dir)?;
    let repo = url
        .split("github.com/")
        .nth(1)
        .map(|tail| tail.trim_end_matches(".git").trim().to_string())
        .unwrap_or_else(|| "github repository".to_string());
    let in_flight = commit_log().in_flight(&folder_key(&dir));
    Some(GitSyncStatus { connected: true, repo, in_flight })
}

/// Disconnect: drop the managed origin remote. Refuses to touch repos the
/// user configured themselves (no oauth2 marker) — those aren't ours.
#[tauri::command]
fn git_sync_disconnect(path: String) -> Result<(), String> {
    let dir = sync_dir_of(Path::new(&path))
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?;
    let repo = gitcore::open(&dir)?;
    let url = gitcore::remote_url(&repo, "origin").unwrap_or_default();
    if !url.contains("oauth2:") {
        return Err("This folder is not a Lithic-managed sync folder".to_string());
    }
    gitcore::remove_remote(&repo, "origin")?;
    // Recorded, because the commits stay behind: without it the launcher would keep
    // preferring this folder and there would be no way to back up another one.
    gitcore::mark_detached(&repo);
    Ok(())
}

// --- Bookmarked instances (the meta-launcher) --------------------------------
// A self-hosted instance usually serves its manifest and favicon without
// `Access-Control-Allow-Origin` unless its operator added one, and a browser
// cannot tell a blocked-but-fine instance from a dead host: both reject the
// fetch, because a CORS-blocked response is withheld from the script entirely.
// Measured against a stock self-host deployment: `/manifest.json` answers 200
// with no such header, so the launcher's own probe reported "not a Lithic
// instance" about a perfectly good one. The desktop app asks from Rust instead,
// where the real status and the real bytes are visible, which is what makes
// bookmarking work at all.

/// What a cross-origin probe of another instance learned.
#[derive(serde::Serialize)]
struct InstanceProbe {
    /// `lithic` | `other` | `protected` | `unreachable`.
    state: &'static str,
    /// The HTTP status, or 0 when nothing answered.
    status: u16,
}

/// Classify `/manifest.json`.
///
/// Pure, because the cases that decide whether the user is let through are the
/// ones a real deployment produces, and they are otherwise only reachable with a
/// protected server in hand. `protected` is not a failure: 401 and 403 mean
/// something is there and asking for credentials, which the user confirms by
/// hand rather than being refused.
fn classify_manifest(status: u16, body: &[u8]) -> &'static str {
    if status == 401 || status == 403 {
        return "protected";
    }
    if !(200..=299).contains(&status) {
        return "other";
    }
    let lithic = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .map(|manifest| {
            manifest.get("name").and_then(|value| value.as_str()) == Some("Lithic")
                || manifest.get("short_name").and_then(|value| value.as_str()) == Some("Lithic")
        })
        .unwrap_or(false);
    if lithic {
        "lithic"
    } else {
        "other"
    }
}

/// Is this address a Lithic instance, in a way the browser cannot check?
/// The cached wikis other instances keep in this app's own storage.
///
/// The launcher asks for the addresses it bookmarked and gets back whatever their
/// origins have cached. Nothing here reaches the network, and the argument is the
/// limit of what can be read: an address the user did not save is never looked at.
///
/// Empty is a complete answer. Every way this can come to nothing — an origin with no
/// Lithic storage, a store never written, a runtime without the protocol, a platform
/// without the hook — is "no cached wikis here", which the launcher shows as nothing.
#[tauri::command]
async fn instance_cache_search(
    app: tauri::AppHandle,
    origins: Vec<String>,
) -> Vec<instance_search::InstanceCacheRead> {
    // The protocol calls belong to the thread that owns the webview, and they wait for
    // it to answer, so this runs on a blocking task while the launcher's search stays
    // responsive.
    let Some(window) = tauri::Manager::get_webview_window(&app, "main") else { return Vec::new() };
    tauri::async_runtime::spawn_blocking(move || instance_search::read_caches(&window, &origins))
        .await
        .unwrap_or_default()
}

/// Drop the copy this app downloaded of one instance.
///
/// The × on a bookmarked instance is the gesture, and this is the half of it the
/// launcher's own page cannot do: that copy sits under the instance's origin, which is
/// another origin's storage to everything but the app itself (see `instance_copy`). The
/// saved login is not involved — credentials live in the vault file, and forgetting one
/// is the vault's own named action.
#[tauri::command]
async fn forget_instance_copy(app: tauri::AppHandle, origin: String) -> instance_copy::CopyDropped {
    // The protocol calls belong to the thread that owns the webview, and they wait for it
    // to answer, so this runs on a blocking task while the launcher stays responsive.
    let Some(window) = tauri::Manager::get_webview_window(&app, "main") else {
        // No window to speak to: there is nowhere left to draw a sentence about this, so
        // it is reported as unsupported rather than as a copy that is still there.
        return instance_copy::CopyDropped::unsupported();
    };
    tauri::async_runtime::spawn_blocking(move || instance_copy::forget(&window, &origin))
        .await
        .unwrap_or_else(|_| instance_copy::CopyDropped::unsupported())
}

#[tauri::command]
async fn probe_instance(url: String, state: tauri::State<'_, VaultState>) -> Result<InstanceProbe, String> {
    // `Result` because a Tauri 2 async command that borrows state has to return
    // one. Nothing here actually fails: being unreachable is a verdict the
    // launcher renders, exactly as before, so every path still answers `Ok`.
    let unreachable = InstanceProbe { state: "unreachable", status: 0 };
    let Some(client) = http_client() else {
        return Ok(unreachable);
    };
    // A protected instance answers `lithic` once the vault can supply credentials
    // for it, which is what turns "ask the user to confirm" into a plain verify.
    let mut request = client
        .get(format!("{url}/manifest.json"))
        .timeout(std::time::Duration::from_secs(6));
    if let Some(header) = credential_header(&url, &state) {
        request = request.header("Authorization", header);
    }
    let Ok(response) = request.send().await else {
        return Ok(unreachable);
    };
    let status = response.status().as_u16();
    // Read only when there is a body to classify: a protected or missing
    // manifest is decided by its status alone.
    let body = match response.bytes().await {
        Ok(raw) => raw.to_vec(),
        Err(_) => Vec::new(),
    };
    Ok(InstanceProbe { state: classify_manifest(status, &body), status })
}

/// What checking one saved login against its instance found.
#[derive(serde::Serialize)]
struct LoginCheck {
    /// `accepted` | `refused` | `not-required` | `unclear` | `unreachable`.
    outcome: &'static str,
    /// The status the credential-carrying request got, or 0 when nothing answered.
    status: u16,
    /// One sentence for the user, written here so the rule has one home.
    detail: String,
}

/// Decide what an instance said about a saved login, from two statuses.
///
/// Pure, because the cases that matter are the ones a real deployment produces and
/// they are otherwise only reachable with a protected server in hand.
///
/// The second request is what makes the first one mean anything. A 200 says the
/// address serves the instance; only a challenge the credential *answered* says the
/// password still works. Without it, "Signs in" would be printed for an instance
/// that had stopped asking for a password at all — which is a thing its operator
/// would want to know, not a thing to paper over.
fn classify_login(authenticated: u16, without: u16) -> LoginCheck {
    let challenged = |status: u16| status == 401 || status == 403;
    if authenticated == 0 {
        return LoginCheck {
            outcome: "unreachable",
            status: 0,
            detail: "Nothing answered at this address.".to_string(),
        };
    }
    if challenged(authenticated) {
        return LoginCheck {
            outcome: "refused",
            status: authenticated,
            detail: format!("The instance refused this login ({}).", authenticated),
        };
    }
    if (200..=299).contains(&authenticated) {
        if challenged(without) {
            return LoginCheck {
                outcome: "accepted",
                status: authenticated,
                detail: "The instance asks for a password, and accepts this login.".to_string(),
            };
        }
        if (200..=299).contains(&without) {
            return LoginCheck {
                outcome: "not-required",
                status: authenticated,
                detail: "This instance answered without a password at all: it no longer asks for one.".to_string(),
            };
        }
        if without == 0 {
            return LoginCheck {
                outcome: "unclear",
                status: authenticated,
                detail: format!(
                    "The instance answered {} with this login, and then nothing at all without it.",
                    authenticated
                ),
            };
        }
    }
    LoginCheck {
        outcome: "unclear",
        status: authenticated,
        detail: format!(
            "The instance answered {} with this login and {} without it, which is not a verdict.",
            authenticated, without
        ),
    }
}

/// The two questions that decide what an instance says about a login, asked in the
/// one place both callers share.
///
/// Extracted so that "is this password right?" and "is this password still right?"
/// cannot drift apart: the offer dialog asks the first about a login typed seconds
/// ago, the manager asks the second about a saved one, and an instance answers both
/// the same way. `/manifest.json` is the request this app already trusts to describe
/// an instance (see `probe_instance`), so it is the same one a login is checked
/// against rather than a path of its own.
async fn ask_instance_about_login(origin: &str, header: &str) -> LoginCheck {
    let Some(client) = http_client() else {
        return classify_login(0, 0);
    };
    let url = format!("{}/manifest.json", origin);
    let timeout = std::time::Duration::from_secs(8);
    let authenticated = match client
        .get(&url)
        .timeout(timeout)
        .header("Authorization", header)
        .send()
        .await
    {
        Ok(response) => response.status().as_u16(),
        // Nothing answered, so there is no second question to ask.
        Err(_) => return classify_login(0, 0),
    };
    // Asked a second time without the credential, and only when the first request
    // got far enough for the answer to be ambiguous. Deliberately no header: this
    // is the request that shows whether the instance still challenges at all.
    let without = if (200..=299).contains(&authenticated) {
        match client.get(&url).timeout(timeout).send().await {
            Ok(response) => response.status().as_u16(),
            Err(_) => 0,
        }
    } else {
        0
    };
    classify_login(authenticated, without)
}

/// Check one saved login against the instance it was saved for.
///
/// The manager's "does this still work?" button, and — with
/// `check_login_for_instance` — one of the two commands that take a credential to
/// the network at all, both of them because the user asked for it. Nothing here runs
/// on a timer.
///
/// The secret is an argument, which is what lets the manager offer this without
/// holding anything open: the password is decrypted inside this call, sent, and gone
/// again by the time it returns. It is never returned to the launcher, not even in
/// an error message.
#[tauri::command]
async fn check_credential(origin: String, secret: String) -> Result<LoginCheck, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could be saved for.".to_string())?;
    // Built and dropped before the await: a response can take seconds, and the
    // decrypted vault has no business outliving the header it was opened to make.
    let header = with_vault(&secret, |vault| {
        vault
            .credential_for(&origin)
            .map(|entry| credentials::basic_header(&entry.user, &entry.password))
            .ok_or_else(|| format!("No saved login for {}.", origin))
    })?;
    Ok(ask_instance_about_login(&origin, &header).await)
}

/// Would this login be accepted, before it is written down anywhere?
///
/// The offer dialog's check, and the reason it exists: the launcher hands the window
/// to an instance and cannot speak on the pages that follow, so a password saved
/// wrong here is only discovered there. Asking first turns that into a sentence in
/// the dialog the user is already looking at.
///
/// The credential goes to the instance's own origin and nowhere else — the very
/// place it is about to be sent to sign in — and it never appears in an error
/// message. No vault state, deliberately: the case that matters is a dialog open
/// when there is no vault yet, where there is nothing saved to read a password from
/// in the first place.
#[tauri::command]
async fn check_login_for_instance(
    origin: String,
    user: String,
    password: String,
) -> Result<LoginCheck, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could be saved for.".to_string())?;
    Ok(ask_instance_about_login(&origin, &credentials::basic_header(&user, &password)).await)
}

/// One instance icon, as bytes for the launcher to cache as a data URL.
#[derive(serde::Serialize)]
struct InstanceIcon {
    content_type: String,
    bytes: Vec<u8>,
}

/// Icons live in localStorage, so refuse anything too large to be one.
const INSTANCE_ICON_MAX_BYTES: usize = 128 * 1024;

/// Fetch the instance's current icon through Rust, for the same reason as the
/// probe: the response is cross-origin, and a deployment that sends no
/// `Access-Control-Allow-Origin` is unreadable to the browser and perfectly
/// readable here. `None` when nothing usable answered.
#[tauri::command]
async fn fetch_instance_icon(url: String, state: tauri::State<'_, VaultState>) -> Result<Option<InstanceIcon>, String> {
    // Same `Result` reason as `probe_instance`; a missing icon is `Ok(None)`.
    let Some(client) = http_client() else {
        return Ok(None);
    };
    let header = credential_header(&url, &state);
    for path in ["/favicon-32x32.png", "/favicon.ico"] {
        let mut request = client
            .get(format!("{url}{path}"))
            .timeout(std::time::Duration::from_secs(6));
        if let Some(header) = header.clone() {
            request = request.header("Authorization", header);
        }
        let Ok(response) = request.send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("image/png")
            .to_string();
        let Ok(raw) = response.bytes().await else { continue };
        if raw.is_empty() || raw.len() > INSTANCE_ICON_MAX_BYTES {
            continue;
        }
        return Ok(Some(InstanceIcon { content_type, bytes: raw.to_vec() }));
    }
    Ok(None)
}

// --- Sync health -------------------------------------------------------------
// The marker check above answers "is this folder wired to a repository". It
// cannot answer "is the backup still working": a revoked token, a repository
// that was deleted or renamed, and a token that can read but not write all
// leave the marker perfectly intact. One authenticated request answers those,
// which is what lets the launcher paint green only when it is telling the truth.

/// What one heartbeat learned about the connection.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Health {
    Ok,
    ReadOnly,
    Auth,
    Missing,
    Throttled,
    Offline,
}

/// Map one `GET /repos/{owner}/{name}` response to a verdict.
///
/// Pure, because the cases that matter are exactly the ones that decide whether
/// a green icon is honest, and they are otherwise only reachable with a real
/// expired token in hand.
///
/// GitHub answers 404 both for a repository that was deleted and for a private
/// one this token cannot see, so `Missing` is reported as "deleted, renamed, or
/// no longer shared" rather than asserting which of the two happened.
fn verdict_for(status: u16, push_allowed: Option<bool>, rate_limited: bool) -> Health {
    match status {
        // 409 is a repository with no commits yet: the repository and the token
        // are fine, the branch simply does not exist until the first push lands.
        200..=299 | 409 => match push_allowed {
            Some(false) => Health::ReadOnly,
            _ => Health::Ok,
        },
        401 => Health::Auth,
        403 if rate_limited => Health::Throttled,
        403 => Health::Auth,
        404 => Health::Missing,
        _ => Health::Offline,
    }
}

/// The launcher's view of a heartbeat: a machine-readable verdict plus the one
/// sentence the icon's tooltip and the sync dialog both show.
#[derive(serde::Serialize)]
struct GitSyncHealth {
    state: &'static str,
    repo: String,
    detail: String,
    /// Why this folder's most recent save did not reach GitHub, if it did not.
    /// Kept separate from `state` because the two answer different questions:
    /// the repository can be perfectly reachable while a push is still failing.
    last_commit_error: Option<String>,
}

impl GitSyncHealth {
    fn unmanaged() -> Self {
        Self {
            state: "unmanaged",
            repo: String::new(),
            detail: "This folder is not synced.".to_string(),
            last_commit_error: None,
        }
    }

    fn malformed() -> Self {
        Self {
            state: "malformed",
            repo: String::new(),
            detail: "This folder's saved remote is unreadable. Reconnect to repair it.".to_string(),
            last_commit_error: None,
        }
    }

    fn offline(repo: String, reason: &str) -> Self {
        // The launcher shows one short line, so the transport error goes to the
        // log where it is useful for diagnosis rather than into the sentence.
        eprintln!("heartbeat offline: {reason}");
        Self {
            state: "offline",
            repo,
            detail: "Cannot reach github.com. Saves stay on this device.".to_string(),
            last_commit_error: None,
        }
    }

    fn with_last_commit_error(mut self, error: Option<String>) -> Self {
        self.last_commit_error = error;
        self
    }

    fn new(health: Health, repo: String, status: u16) -> Self {
        let state = match health {
            Health::Ok => "ok",
            Health::ReadOnly => "readonly",
            Health::Auth => "auth",
            Health::Missing => "missing",
            Health::Throttled => "throttled",
            Health::Offline => "offline",
        };
        let detail = match health {
            // A freshly created repository has no commits until the first push
            // lands, which is a first backup waiting to happen, not a fault.
            Health::Ok if status == 409 => {
                format!("github.com/{} is empty, so the next save starts it.", repo)
            }
            Health::Ok => format!("Backed up to github.com/{}.", repo),
            Health::ReadOnly => format!(
                "This token can only read github.com/{}. Reconnect to allow pushes.",
                repo
            ),
            Health::Auth => "GitHub rejected this token. Reconnect to sign in again.".to_string(),
            Health::Missing => format!(
                "github.com/{} is missing or not shared with this token.",
                repo
            ),
            Health::Throttled => {
                "GitHub is rate-limiting this device. Saves stay local for now.".to_string()
            }
            Health::Offline => "Cannot reach github.com. Saves stay on this device.".to_string(),
        };
        Self {
            state,
            repo,
            detail,
            last_commit_error: None,
        }
    }
}

/// One authenticated GET, reporting the raw status and the two things a verdict
/// needs (the token's push permission, and whether GitHub is rate-limiting us).
///
/// Time-boxed: a heartbeat that can hang would leave the icon reading "checking"
/// forever, which is worse than the wrong colour. Errors here are transport
/// errors — being unreachable is a verdict, not a failed command.
async fn github_api_probe(url: &str, token: &str) -> Result<(u16, bool, Option<bool>), String> {
    let client = http_client().ok_or_else(|| "no HTTP client".to_string())?;
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Lithic-Sync")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let rate_limited = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim() == "0")
        .unwrap_or(false);
    // Read after the headers: consuming the body consumes the response.
    let push_allowed = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|payload| payload.get("permissions")?.get("push")?.as_bool());
    Ok((status, rate_limited, push_allowed))
}

/// Is the sync to GitHub actually working?
///
/// One authenticated request against the repository the folder's own remote
/// names, so the answer covers what the marker check cannot: a revoked token, a
/// repository that was deleted or renamed, and a token that can read but not
/// push. Never returns an error — "cannot reach github.com" is a verdict the
/// launcher renders, not a failed command.
#[tauri::command]
async fn git_sync_heartbeat(path: String) -> Result<GitSyncHealth, String> {
    let folder = sync_dir_of(Path::new(&path));
    // Read first: a save that failed in the engine document leaves its reason
    // here, and that is the only way the launcher ever finds out.
    let last_error = folder
        .as_deref()
        .and_then(|dir| commit_log().last_error(&folder_key(dir)));
    let Some(dir) = folder else {
        return Ok(GitSyncHealth::unmanaged());
    };
    let Some(url) = managed_remote_url(&dir) else {
        return Ok(GitSyncHealth::unmanaged());
    };
    let Some(remote) = parse_managed_remote(&url) else {
        return Ok(GitSyncHealth::malformed().with_last_commit_error(last_error));
    };
    let repo = format!("{}/{}", remote.owner, remote.name);
    let endpoint = format!("https://api.github.com/repos/{}", repo);
    let health = match github_api_probe(&endpoint, &remote.token).await {
        Ok((status, rate_limited, push_allowed)) => {
            GitSyncHealth::new(verdict_for(status, push_allowed, rate_limited), repo, status)
        }
        Err(reason) => GitSyncHealth::offline(repo, &reason),
    };
    Ok(health.with_last_commit_error(last_error))
}

/// Re-point a synced folder at the same repository with a fresh token, and do
/// nothing else.
///
/// The remedy for a token GitHub no longer accepts. Going through the full
/// connect again would re-fetch and re-merge a folder that has already been
/// merged, which is a lot of work and a chance to touch files for no reason.
#[tauri::command]
fn git_sync_reauth(path: String, repo: String, token: String) -> Result<String, String> {
    let dir = sync_dir_of(Path::new(&path))
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?;
    if !dir.join(".git").is_dir() {
        return Err("This folder is not a git repository".to_string());
    }
    // Only a folder Lithic already manages may be re-pointed: the marker is what
    // proves the remote is ours to rewrite.
    if managed_remote_url(&dir).is_none() {
        return Err("This folder is not a Lithic-managed sync folder".to_string());
    }
    let repo = repo.trim().trim_end_matches(".git").trim().to_string();
    if repo.is_empty() || token.trim().is_empty() {
        return Err("Both repository (owner/name) and token are required".to_string());
    }
    let handle = gitcore::open(&dir)?;
    gitcore::set_remote(&handle, "origin", &sync_remote_url(&repo, token.trim()))?;
    Ok(repo)
}

/// Folder the running exe lives in — the root all sidecar-relative paths
/// resolve against (the process CWD is unreliable on Windows).
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|parent| parent.to_path_buf())
}

/// Best-effort relative path from base to target. Empty or `..`-leading
/// results (target outside the bundle, e.g. another drive) return None so
/// the caller keeps the absolute path — relative escapes would silently
/// re-anchor to whatever machine the drive is plugged into.
fn relative_to(target: &std::path::Path, base: &std::path::Path) -> Option<PathBuf> {
    let target_comps: Vec<_> = target.components().collect();
    let base_comps: Vec<_> = base.components().collect();
    let mut shared = 0;
    while shared < target_comps.len()
        && shared < base_comps.len()
        && target_comps[shared] == base_comps[shared]
    {
        shared += 1;
    }
    let mut out = PathBuf::new();
    for _ in shared..base_comps.len() {
        out.push("..");
    }
    for comp in &target_comps[shared..] {
        out.push(comp.as_os_str());
    }
    match out.components().next() {
        Some(std::path::Component::ParentDir) | None => None,
        Some(_) => Some(out),
    }
}

/// Read the portable recents sidecar: recents.txt beside the exe, one path
/// per line, most recent first. Comments (#) and blanks are skipped.
/// Relative lines resolve against the exe's folder (process CWD is not
/// reliable), and paths that no longer exist on this machine are dropped so
/// a moved thumb drive only ever offers files that are actually present.
/// Missing sidecar simply yields an empty list — optional by design.
///
/// The file also carries settings lines (`dismissed=`, `sync-folder=`). Those are not
/// paths and never become rows: the picked folder is read back by `chosen_sync_folder`.
#[tauri::command]
fn read_recents_sidecar() -> Vec<String> {
    let Some(dir) = exe_dir() else { return Vec::new(); };
    read_recents_in(&dir)
}

/// The sidecar's recent paths, resolved for `dir`.
///
/// Split out from the command because the folder a backup acts on rides in the same
/// file: both halves have to agree about which lines are paths, and this is where a
/// path line is decided.
fn read_recents_in(dir: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(dir.join("recents.txt")) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with(SYNC_FOLDER_MARKER))
        .filter_map(|line| {
            let path = PathBuf::from(line);
            let resolved = if path.is_absolute() { path } else { dir.join(path) };
            if resolved.is_file() {
                Some(resolved.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect()
}

/// Write the portable recents sidecar beside the exe. Paths that live under
/// the exe's folder are stored relative (so a thumb-drive bundle keeps its
/// recents across machines); everything else stays absolute and is skipped
/// gracefully on machines where it doesn't resolve.
///
/// A `dismissed=1` line records the install-offer dismissal ("Dismiss" on
/// the Install button): delete recents.txt to restore the offer.
#[tauri::command]
fn write_recents_sidecar(paths: Vec<String>, dismissed: bool) -> Result<(), String> {
    let Some(dir) = exe_dir() else { return Ok(()); };
    write_recents_in(&dir, paths, dismissed)
}

/// Write the sidecar for `dir`.
///
/// Whatever else the file holds is carried across, which is why the picked folder is
/// read back here rather than taken as an argument: the launcher knows the recents and
/// the dismissal and nothing about that folder, and a recents save must not be the
/// thing that forgets the user's own choice.
fn write_recents_in(dir: &Path, paths: Vec<String>, dismissed: bool) -> Result<(), String> {
    let mut lines = vec![RECENTS_HEADER.to_string()];
    if dismissed {
        lines.push("dismissed=1".to_string());
    }
    if let Some(value) = sync_folder_value_in(dir) {
        lines.push(format!("{}{}", SYNC_FOLDER_MARKER, portable_form(Path::new(&value), dir)));
    }
    for path in paths.into_iter().take(20) {
        let target = PathBuf::from(&path);
        if let Some(rel) = relative_to(&target, dir) {
            lines.push(rel.to_string_lossy().into_owned());
        } else {
            lines.push(path);
        }
    }
    fs::write(dir.join("recents.txt"), lines.join("\n") + "\n").map_err(|error| error.to_string())
}

/// The sidecar's opening line, shared by both of its writers so a file created by a
/// folder pick and one created by a recents save say the same thing.
const RECENTS_HEADER: &str = "# Lithic recent files (portable). One path per line, most recent first.";

/// The sidecar's setting line for the folder GitHub Sync acts on.
///
/// In this file deliberately: a portable bundle already travels with `recents.txt` beside
/// it, and where it syncs is part of what makes it portable. A third sidecar would be a
/// third thing to keep beside the exe, and the settings shape is one the file already has
/// (`dismissed=1` was the first).
const SYNC_FOLDER_MARKER: &str = "sync-folder=";

/// A path the way the sidecar spells it: relative to the exe's folder when it lives under
/// it, so a thumb drive names its own folder on whatever machine it is plugged into, and
/// absolute when it does not — there is nothing to be relative to.
fn portable_form(path: &Path, dir: &Path) -> String {
    if !path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    if path == dir {
        // The app's own folder is a legitimate pick ("back up everything here"), and `.`
        // is the one relative spelling that means it on every machine.
        return ".".to_string();
    }
    relative_to(path, dir)
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// The path a sidecar line names, on this machine: a relative one is relative to the exe's
/// folder, because the process CWD is not reliable on Windows.
///
/// No existence check here. The caller asks that question, and keeping it out of the
/// resolution is what stops a rewrite from dropping a line whose folder is simply not
/// mounted at the moment — a thumb drive that is not plugged in is not a folder the user
/// un-picked.
fn resolve_sidecar_path(value: &str, dir: &Path) -> PathBuf {
    if value == "." {
        return dir.to_path_buf();
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        dir.join(path)
    }
}

/// The folder the sidecar's `sync-folder=` line names, spelled the way the file spells it.
fn sync_folder_value_in(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("recents.txt")).ok()?;
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(SYNC_FOLDER_MARKER))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The folder the user picked, resolved here.
///
/// `None` when nothing is recorded, or when the folder is not on this machine any more —
/// a drive that was not plugged in hands the dialog back to the automatic rules rather
/// than naming a path that is not there.
fn chosen_sync_folder() -> Option<PathBuf> {
    chosen_sync_folder_in(&exe_dir()?)
}

/// The picked folder as it resolves for `dir` — the half of the question that does not
/// need a running executable, so it can be tested.
fn chosen_sync_folder_in(dir: &Path) -> Option<PathBuf> {
    let path = resolve_sidecar_path(&sync_folder_value_in(dir)?, dir);
    path.is_dir().then_some(path)
}

/// Record — or clear — the folder the user picked, leaving every other line of the sidecar
/// exactly as it was: the file is also the recents list and the install-offer marker, and
/// a folder choice is not licence to rewrite either.
fn set_sync_folder_in(dir: &Path, picked: Option<&Path>) -> Result<(), String> {
    let mut lines: Vec<String> = match fs::read_to_string(dir.join("recents.txt")) {
        Ok(text) => text
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.starts_with(SYNC_FOLDER_MARKER))
            .collect(),
        Err(_) => vec![RECENTS_HEADER.to_string()],
    };
    if let Some(path) = picked {
        lines.push(format!("{}{}", SYNC_FOLDER_MARKER, portable_form(path, dir)));
    }
    fs::write(dir.join("recents.txt"), lines.join("\n") + "\n").map_err(|error| error.to_string())
}

/// Ask the OS which folder to back up, instead of the one Lithic worked out.
///
/// The dialog's folder line answers "which folder is this about", and it was inferred: the
/// open Lith, else the newest recent row, else a library folder with a repository in it.
/// That is right most of the time and wrong when the liths live somewhere else, which used
/// to leave Disconnect as the only way to move a backup.
///
/// Async, and that is load-bearing: a command runs on the main thread, and Tauri 2's
/// blocking pickers must not be called there. This one parks on a channel while the
/// dialog's own callback (which fires on the main thread) delivers the chosen folder.
#[tauri::command]
async fn pick_sync_folder(app: tauri::AppHandle, current: Option<String>) -> Result<Option<String>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut picker = app.dialog().file();
    // Opens where the dialog already points, so changing the folder is a step from the
    // answer on screen rather than from wherever the OS last happened to be. The page sends
    // the folder it is naming, and the fallbacks are for a caller that sends nothing.
    let start = current
        .as_deref()
        .map(Path::new)
        .filter(|dir| dir.is_dir())
        .map(Path::to_path_buf)
        .or_else(chosen_sync_folder)
        .or_else(exe_dir);
    if let Some(dir) = start {
        picker = picker.set_directory(dir);
    }
    picker.pick_folder(move |folder| {
        let _ = sender.send(folder);
    });
    let Some(folder) = receiver.recv().ok().flatten() else { return Ok(None) };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    if let Some(dir) = exe_dir() {
        set_sync_folder_in(&dir, Some(&path))?;
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Go back to the folder Lithic works out for itself. The recents and the install-offer
/// marker are left alone, and the next read answers with the automatic folder.
#[tauri::command]
fn clear_sync_folder_override() -> Result<(), String> {
    let Some(dir) = exe_dir() else { return Ok(()) };
    set_sync_folder_in(&dir, None)
}

/// Current install-offer state for the launcher: whether an install exists
/// (independent of up-to-dateness) and whether the user dismissed the offer
/// (persisted as a sidecar marker). Delete recents.txt to restore the offer.
#[derive(serde::Serialize)]
struct InstallOfferStatus {
    installed: bool,
    dismissed: bool,
}

/// Read the sidecar's install-offer dismissal marker.
fn sidecar_dismissed(dir: &Path) -> bool {
    fs::read_to_string(dir.join("recents.txt"))
        .map(|text| text.lines().any(|line| line.trim() == "dismissed=1"))
        .unwrap_or(false)
}

#[tauri::command]
fn install_offer_status() -> InstallOfferStatus {
    let installed = install_target().map(|path| path.is_file()).unwrap_or(false);
    let dismissed = exe_dir().map(|dir| sidecar_dismissed(&dir)).unwrap_or(false);
    InstallOfferStatus { installed, dismissed }
}

/// Record or clear the install-offer dismissal in the sidecar. Fire-and-
/// forget friendly: recents (if any) are preserved.
#[tauri::command]
fn set_install_dismissed(dismissed: bool) -> Result<(), String> {
    let Some(dir) = exe_dir() else { return Ok(()); };
    let paths: Vec<String> = if dir.join("recents.txt").is_file() {
        fs::read_to_string(dir.join("recents.txt"))
            .map(|text| {
                text.lines()
                    .map(|line| line.trim())
                    .filter(|line| !line.is_empty() && !line.starts_with('#') && *line != "dismissed=1" && !line.starts_with(SYNC_FOLDER_MARKER))
                    .map(|line| {
                        let path = PathBuf::from(line);
                        if path.is_absolute() {
                            path.to_string_lossy().into_owned()
                        } else {
                            dir.join(path).to_string_lossy().into_owned()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    write_recents_sidecar(paths, dismissed)
}

// --- Credential vault --------------------------------------------------------
// The launcher's side of a self-hosted instance asking for HTTP Basic auth. The
// storage and the cryptography live in `credentials`; what is here is the session
// (locked or unlocked), the commands the launcher drives it with, and the lookup
// the HTTP calls use to answer a challenge without a human.

use credentials::{CredentialSummary, VaultError};

/// What the app holds in memory, and for how long.
///
/// One credential, and only ever one: a [`credentials::Grant`] lent to an instance
/// while it loads, because the webview asks the server's password challenge long
/// after the launcher has left the page. It expires on a clock
/// ([`credentials::GRANT_TTL`]) and is dropped the moment the launcher comes back.
///
/// There is deliberately no wider thing here. The manager used to keep the whole
/// vault open while its dialog was up, which made "managing logins" a *state* the
/// process sat in — and, because [`credential_pair`] answered from whatever was
/// already in memory, a state that answered **any** origin's password challenge for
/// as long as that dialog was on screen. Now every command that needs the vault opens it, does
/// one thing, and drops it, so `with_vault` is the whole of the unlock policy and
/// the key is zeroized on the way out of each call.
///
/// The price is one KDF per management action instead of one per dialog. At the
/// cost this vault is set to ([`credentials::M_COST_KIB`]), and for the three to
/// five logins it is meant to hold, that is the cheap side of the trade.
pub(crate) struct VaultState {
    grant: Mutex<Option<credentials::Grant>>,
}

impl VaultState {
    pub(crate) fn new() -> VaultState {
        VaultState { grant: Mutex::new(None) }
    }
}

#[derive(serde::Serialize)]
struct CredentialStatus {
    /// A vault file exists on disk.
    exists: bool,
    /// An instance load is holding one credential right now. There is no other
    /// kind of open: nothing the launcher can ask for outlives the call that asked.
    granted: bool,
    /// How many logins are stored, answered from the file's origin index, so it is
    /// known while the vault is locked. The count is not one of the things the
    /// secret protects — the launcher says "3 saved" rather than pretending to know
    /// nothing — while the origins, usernames and passwords stay inside it.
    count: usize,
    /// Where the file lives, so the UI can name it.
    path: String,
}

#[derive(serde::Serialize)]
struct SecretCheck {
    ok: bool,
    problem: Option<String>,
    warning: Option<String>,
    /// `weak`, `average` or `strong` — the same word the line is coloured by, so the
    /// colour and the verdict cannot be derived twice and disagree.
    band: Option<String>,
}

/// Where the vault lives: beside the executable for a portable bundle, in app
/// data for an installed copy — the rule `recents.txt` already follows.
fn vault_path() -> PathBuf {
    credentials::vault_path(exe_dir(), dirs::data_dir().map(|dir| dir.join("Lithic")))
}

/// Can this process create a file in `dir`?
///
/// Asked rather than assumed: the executable folder is the right home for a
/// portable bundle's vault and the wrong one for an install under `Program
/// Files`, and trying it is the only honest way to tell the two apart.
pub(crate) fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".lithic-write-probe");
    let written = fs::write(&probe, b"").is_ok();
    let _ = fs::remove_file(&probe);
    written
}

/// Run `work` against the vault, opened for exactly the length of the call.
///
/// This is the whole unlock policy. The derived key exists on this stack frame and
/// nowhere else, and dropping `vault` zeroizes it along with the passwords it
/// decrypted — so every command that needs the vault asks for the secret in the
/// same breath as the thing it is doing, and there is no state for one command to
/// find and none left behind for the next.
///
/// A wrong secret is not a special case: it fails the file's tag, which is what
/// `credentials::unlock` reports, and the sentence the launcher shows is that one.
fn with_vault<T>(secret: &str, work: impl FnOnce(&mut credentials::Unlocked) -> Result<T, String>) -> Result<T, String> {
    let mut vault = credentials::unlock(&vault_path(), secret)?;
    work(&mut vault)
}

/// The same, for the two commands that may be the *first* thing a vault ever sees.
///
/// Saving a login into a vault that does not exist yet creates it under the secret
/// being typed, which is what keeps first use one dialog rather than a separate
/// "create a vault" step — and it means a vault file only ever exists because
/// there is a login in it, so an empty one is not a state the app can reach.
fn with_vault_or_create<T>(
    secret: &str,
    work: impl FnOnce(&mut credentials::Unlocked) -> Result<T, String>,
) -> Result<T, String> {
    let path = vault_path();
    let mut vault = match credentials::unlock(&path, secret) {
        Ok(vault) => vault,
        Err(VaultError::Missing) => credentials::create(&path, secret, std::collections::BTreeMap::new())?,
        Err(error) => return Err(error.into()),
    };
    work(&mut vault)
}

/// The `Authorization` header for a URL's origin, when an instance load is holding
/// a grant that covers it.
///
/// Origin-exact: a saved credential is offered to the host it was saved for and
/// to nothing that merely resembles it. reqwest strips this header again if a
/// redirect leaves the host, which is what keeps it from following a bounce to
/// somewhere else.
fn credential_header(url: &str, state: &VaultState) -> Option<String> {
    let (user, password) = credential_pair(url, state)?;
    Some(credentials::basic_header(&user, &password))
}

/// The saved username and password for a URL's origin, when an instance load is
/// holding a grant that covers it.
///
/// Split out from the header above because the webview hook needs the two parts
/// rather than the joined form: WebView2 takes a username and a password
/// separately and does the encoding itself (`webview_auth`).
///
/// A grant is the *only* thing this can answer from. That is the point of it being
/// the only thing in [`VaultState`]: origin-exact, scoped to one instance load, and
/// expiring, so what the app can answer for is always something the user just asked
/// for by opening that instance — never a mode the app is sitting in. Nothing on
/// this path can unlock anything either, which is what lets `webview_auth` call it on
/// the UI thread: an absent or expired grant is simply no answer, and running the
/// KDF here would freeze the window while it waits.
pub(crate) fn credential_pair(url: &str, state: &VaultState) -> Option<(String, String)> {
    let origin = credentials::normalize_origin(url)?;
    let guard = state.grant.lock().ok()?;
    let grant = guard.as_ref()?;
    grant
        .credential_for(&origin)
        .map(|(user, password)| (user.to_string(), password.to_string()))
}

/// The current state, for the launcher's controls.
///
/// Every field is answerable without the secret, which is what makes it safe to
/// ask on every mount and after every action: the file's existence, whether an
/// instance load is holding a credential, how many logins are stored, and where.
/// The count comes from the file's own origin index, so it is known while nothing
/// is open — which is the difference between "3 saved" and pretending to know
/// nothing, and it is the only thing that index is for.
fn status_of(state: &VaultState) -> CredentialStatus {
    let path = vault_path();
    let granted = state
        .grant
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|grant| grant.is_live()))
        .unwrap_or(false);
    CredentialStatus {
        exists: path.exists(),
        granted,
        count: credentials::stored_count(&path),
        path: path.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
fn credentials_status(state: tauri::State<VaultState>) -> CredentialStatus {
    status_of(&state)
}

/// Which of the addresses the launcher knows about have a saved login.
///
/// Answered from the vault file's origin index, so it works while the vault is
/// locked — which is the point: a bookmark's key control is coloured before
/// anything is unlocked, and asking must not create a vault, run the KDF, or ask
/// for a secret. An address that is not an origin is simply not answered.
#[tauri::command]
fn credential_coverage(origins: Vec<String>) -> Vec<String> {
    let asked: Vec<String> = origins
        .iter()
        .filter_map(|origin| credentials::normalize_origin(origin))
        .collect();
    credentials::coverage(&vault_path(), &asked)
}

/// Validate a candidate secret before anything is written with it, so the rule
/// lives in one place: the launcher shows exactly what the vault enforces, and the
/// verdict carries its own arithmetic.
#[tauri::command]
fn check_credentials_secret(secret: String) -> SecretCheck {
    match credentials::validate_secret(&secret) {
        Ok(()) => {
            let verdict = credentials::secret_verdict(&secret);
            SecretCheck {
                ok: true,
                problem: None,
                warning: verdict.as_ref().map(|answer| answer.detail.clone()),
                band: verdict.map(|answer| answer.band.as_str().to_string()),
            }
        }
        Err(error) => {
            SecretCheck { ok: false, problem: Some(error.to_string()), warning: None, band: None }
        }
    }
}

/// Lend one instance the credential that was just typed for it, without saving it.
///
/// The one grant that is not built from the file: nothing is opened, nothing is
/// written and no secret is needed, because the values came from the boxes. It exists
/// because the page answers its own 401s from the grant (`webview_auth`), and with no
/// grant the webview puts up its own dialog — which is the prompt this replaces. What
/// it leaves behind is the same origin-exact, expiring grant any other open leaves,
/// so "type it once, save nothing" is the whole of the difference.
#[tauri::command]
fn lend_instance_credentials(
    origin: String,
    user: String,
    password: String,
    state: tauri::State<VaultState>,
) -> Result<InstanceGrant, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could be saved for.".to_string())?;
    let grant = credentials::Grant::new(origin, user.clone(), password);
    let answer = InstanceGrant { origin: grant.origin().to_string(), user };
    if let Ok(mut slot) = state.grant.lock() {
        // Assigning over the slot drops any previous grant, which zeroizes it.
        *slot = Some(grant);
    }
    Ok(answer)
}

/// What one instance load gets: confirmation of the origin it may sign in to, and
/// who it will answer as. Never the password — nothing here returns that.
#[derive(serde::Serialize)]
struct InstanceGrant {
    /// The origin the grant covers, normalised the way the vault stores it.
    origin: String,
    /// The username the instance will be signed in as.
    user: String,
}

/// The answer to a bookmark being opened: one unlock, one credential, and no
/// session left open behind it.
///
/// This is the ephemeral model in one command. The secret is entered for a single
/// instance load, and what it buys is a [`credentials::Grant`] that expires and is
/// dropped when the launcher comes back. The unlocked vault in this function is
/// local, so dropping it at the end zeroizes the key and the passwords it held —
/// and the manager, if its dialog happens to be open, is neither read nor closed.
#[tauri::command]
fn unlock_for_instance(
    origin: String,
    secret: String,
    state: tauri::State<VaultState>,
) -> Result<InstanceGrant, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could be saved for.".to_string())?;
    let path = vault_path();
    let vault = match credentials::unlock(&path, &secret) {
        Ok(vault) => vault,
        // Nothing saved yet: there is no credential to lend, and saying so is
        // better than creating an empty vault the user did not ask for.
        Err(VaultError::Missing) => return Err("No saved logins yet.".to_string()),
        Err(error) => return Err(error.into()),
    };
    let Some(entry) = vault.credential_for(&origin) else {
        return Err(format!("No login is saved for {}.", origin));
    };
    let grant = credentials::Grant::new(origin, entry.user.clone(), entry.password.clone());
    let answer = InstanceGrant { origin: grant.origin().to_string(), user: entry.user.clone() };
    if let Ok(mut slot) = state.grant.lock() {
        // Assigning over the slot drops any previous grant, which zeroizes it.
        *slot = Some(grant);
    }
    Ok(answer)
}

/// Save one instance's login and leave a grant for it behind, in one unlock.
///
/// This is the launcher's "add a saved credential?" modal as one call. Saving needs
/// the vault open and opening an instance needs a grant, so doing them as two
/// commands would derive the key from the PIN twice — and, worse, would leave the
/// vault open in between. Here the vault is local to the function: dropping it at
/// the end zeroizes the key and the passwords, and what survives is the same
/// one-origin, expiring grant any other instance open leaves. The manager's own copy
/// is neither read nor closed, because the manager is not what asked.
#[tauri::command]
fn save_login_for_instance(
    origin: String,
    secret: String,
    user: String,
    password: String,
    state: tauri::State<VaultState>,
) -> Result<InstanceGrant, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could be saved for.".to_string())?;
    let path = vault_path();
    // No vault yet means the PIN typed here is the one this vault will have — the same
    // first-use bargain `remember_credentials` makes, one dialog and no separate
    // "create" step.
    let mut vault = match credentials::unlock(&path, &secret) {
        Ok(vault) => vault,
        Err(VaultError::Missing) => credentials::create(&path, &secret, std::collections::BTreeMap::new())?,
        Err(error) => return Err(error.into()),
    };
    vault.remember(origin.clone(), user, password);
    credentials::save(&path, &vault)?;
    let Some(entry) = vault.credential_for(&origin) else {
        return Err(format!("No login is saved for {}.", origin));
    };
    let grant = credentials::Grant::new(origin, entry.user.clone(), entry.password.clone());
    let answer = InstanceGrant { origin: grant.origin().to_string(), user: entry.user.clone() };
    if let Ok(mut slot) = state.grant.lock() {
        // Assigning over the slot drops any previous grant, which zeroizes it.
        *slot = Some(grant);
    }
    Ok(answer)
}

/// What the vault holds, opened for the length of the call.
///
/// The list itself has to be behind the secret, and that is a fact about the file
/// rather than a choice made here: its origin index is salted hashes, so nothing can
/// enumerate what is saved without decrypting it. What the secret does *not* do is
/// leave anything open afterwards — the summaries are the answer, not a session, and
/// they carry no password (see [`CredentialSummary`]).
#[tauri::command]
fn list_credentials(secret: String) -> Result<Vec<CredentialSummary>, String> {
    with_vault(&secret, |vault| Ok(vault.summaries()))
}

/// Drop whatever an instance load is holding, so nothing answers any more.
///
/// This is not a lock control and there is no matching unlock one: there is no open
/// vault to close, and the manager neither holds one nor needs one. It is the
/// launcher saying "the load that credential was for is over" — and it is called on
/// every launcher mount, because the webview hands the window back long after the
/// grant was made and a grant left behind would keep signing that one origin in
/// from memory. Which is the single state this design exists not to keep.
#[tauri::command]
fn lock_credentials(state: tauri::State<VaultState>) -> CredentialStatus {
    drop_grant(&state);
    status_of(&state)
}

fn drop_grant(state: &VaultState) {
    if let Ok(mut slot) = state.grant.lock() {
        *slot = None;
    }
}

/// Add or replace one login, and say what the vault holds afterwards.
///
/// The secret is what opens the vault, and — when there is no vault yet — what
/// becomes the vault's. That is first use: one dialog, no separate "create" step,
/// and no way to end up with a file that holds nothing.
#[tauri::command]
fn remember_credentials(
    origin: String,
    user: String,
    password: String,
    secret: String,
) -> Result<Vec<CredentialSummary>, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials can be saved for.".to_string())?;
    with_vault_or_create(&secret, |vault| {
        vault.remember(origin, user, password);
        credentials::save(&vault_path(), vault)?;
        Ok(vault.summaries())
    })
}

/// Drop one login, and say what the vault holds afterwards.
///
/// The secret is not asked for because of what forgetting would *reveal*: the file's
/// index already answers "is there a login for this address?" without one, because a
/// bookmark's key control has to be grey or green before anything is opened. It is
/// asked for because forgetting is a change — and an unauthenticated change here
/// would be a one-at-a-time destructive probe, where handing it a hostname either
/// deletes a login or says there was none. That is precisely what the index was
/// built as salted hashes to avoid handing out.
///
/// Destroying the whole vault is the deliberate exception, because it is the way back
/// from a forgotten secret rather than a way to lose one quietly.
#[tauri::command]
fn forget_credentials(origin: String, secret: String) -> Result<Vec<CredentialSummary>, String> {
    let origin = credentials::normalize_origin(&origin)
        .ok_or_else(|| "That is not an address credentials could have been saved for.".to_string())?;
    with_vault(&secret, |vault| {
        vault.forget(&origin);
        credentials::save(&vault_path(), vault)?;
        Ok(vault.summaries())
    })
}

/// Start over: delete the file and lock the session. This is the recovery path
/// for a forgotten secret, and it costs the saved passwords rather than the
/// files they open.
#[tauri::command]
fn destroy_credentials(state: tauri::State<VaultState>) -> Result<CredentialStatus, String> {
    credentials::destroy(&vault_path())?;
    // Including any grant: the file is gone, so nothing should still be answering
    // from memory on the strength of it.
    drop_grant(&state);
    Ok(status_of(&state))
}

/// The whole application. Desktop builds call it from `main`; a mobile build
/// enters through the entry point the `mobile_entry_point` macro generates.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    // Nobody passes a file to open on mobile, and there may be no arguments at
    // all: `get(1)` is simply None there, which is already the "nothing to open"
    // state the launcher starts in.
    let startup_file = args.get(1).cloned();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StartupFile(Mutex::new(startup_file)))
        .manage(VaultState::new())
        .setup(|app| {
            // Window configuration is applied before this hook runs, so the
            // launcher's webview exists by now. The handler has to be attached
            // once per window, and it is what keeps the page's own requests to a
            // protected instance from re-prompting on every launch.
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                webview_auth::install(&window, app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            get_cli_args,
            read_lith_path,
            open_lith_file,
            save_lith_file,
            write_text_path,
            copy_lith_to_synced_dir,
            install_monolith,
            install_status,
            install_offer_status,
            set_install_dismissed,
            read_recents_sidecar,
            write_recents_sidecar,
            git_sync_setup,
            git_sync_cancel,
            git_sync_commit,
            github_device_code,
            github_device_poll,
            github_list_repos,
            github_create_repo,
            git_sync_status,
            git_sync_disconnect,
            git_sync_heartbeat,
            git_sync_reauth,
            git_sync_folder,
            pick_sync_folder,
            clear_sync_folder_override,
            git_sync_coverage,
            list_folder_liths,
            probe_instance,
            fetch_instance_icon,
            check_credential,
            check_login_for_instance,
            credentials_status,
            credential_coverage,
            check_credentials_secret,
            unlock_for_instance,
            save_login_for_instance,
            lend_instance_credentials,
            list_credentials,
            lock_credentials,
            remember_credentials,
            forget_credentials,
            destroy_credentials,
            instance_cache_search,
            forget_instance_copy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
mod tests {
    use super::*;

    /// The verdicts a saved login can get, each one a case a real deployment
    /// produces: a password that still works, one that was changed server-side, an
    /// instance that stopped asking, a host that is gone, and an answer that decides
    /// nothing.
    #[test]
    fn classify_login_tells_a_working_login_from_the_rest() {
        let accepted = classify_login(200, 401);
        assert_eq!(accepted.outcome, "accepted");
        assert_eq!(accepted.status, 200);
        assert!(accepted.detail.contains("accepts this login"), "{}", accepted.detail);
        // Every 2xx after a challenge reads the same, whatever the server chose.
        assert_eq!(classify_login(204, 403).outcome, "accepted");

        // A password changed server-side: the instance asks again and refuses what
        // was saved. A different fact from never having had a password at all.
        let refused = classify_login(401, 0);
        assert_eq!(refused.outcome, "refused");
        assert!(refused.detail.contains("401"), "{}", refused.detail);

        // It answers with and without the credential: it no longer asks for one, and
        // calling that "signs in" would be a claim the request never made.
        let open = classify_login(200, 200);
        assert_eq!(open.outcome, "not-required");
        assert!(open.detail.contains("no longer asks"), "{}", open.detail);

        let gone = classify_login(0, 0);
        assert_eq!(gone.outcome, "unreachable");
        assert_eq!(gone.status, 0);
        assert!(gone.detail.contains("Nothing answered"), "{}", gone.detail);

        // Anything else is reported as undecided rather than dressed up as one of the
        // three verdicts above.
        assert_eq!(classify_login(404, 0).outcome, "unclear");
        assert_eq!(classify_login(200, 404).outcome, "unclear");
        assert_eq!(classify_login(200, 0).outcome, "unclear");
        assert_eq!(classify_login(500, 500).outcome, "unclear");
    }

    /// A grant is the only thing that answers a password challenge.
    ///
    /// This is the regression the design exists to prevent, not a detail: while the
    /// manager kept the vault open, `credential_pair` answered **any** origin, so
    /// merely looking at the saved logins authorised browsing as any of them. Nothing
    /// opens the vault for a dialog any more, and what is left is origin-exact.
    #[test]
    fn only_a_grant_answers_a_password_challenge() {
        let state = VaultState::new();
        assert_eq!(credential_pair("https://personal.lithic.uk/", &state), None);

        let grant = credentials::Grant::new(
            "https://personal.lithic.uk".to_string(),
            "keeper".to_string(),
            "s3cret".to_string(),
        );
        *state.grant.lock().expect("the grant slot") = Some(grant);

        let answered = credential_pair("https://personal.lithic.uk/", &state);
        assert_eq!(answered, Some(("keeper".to_string(), "s3cret".to_string())));

        // Origin-exact, in all three directions a near-miss can come from: another
        // host, another scheme on the same host, and another port on it.
        assert_eq!(credential_pair("https://other.example/", &state), None);
        assert_eq!(credential_pair("http://personal.lithic.uk/", &state), None);
        assert_eq!(credential_pair("https://personal.lithic.uk:8443/", &state), None);

        // And dropping the grant is what leaves nothing answering — which is what
        // `lock_credentials` does on every launcher mount.
        drop_grant(&state);
        assert_eq!(credential_pair("https://personal.lithic.uk/", &state), None);
    }

    /// Shell out to real git — for fixtures and assertions only. The sync
    /// itself is in-process libgit2, so building the fixtures with git and
    /// reading the results back with git is a deliberate independent check
    /// that what libgit2 writes is a repository real git understands.
    fn run_git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git must be installed for the sync tests");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// True when `name` is committed in the remote's `main`.
    fn remote_has(remote: &Path, name: &str) -> bool {
        run_git(remote, &["ls-tree", "-r", "--name-only", "main"])
            .lines()
            .any(|line| line == name)
    }

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        run_git(dir, &["init", "-b", "main"]);
        // Pin line endings so the byte assertions below mean what they say.
        run_git(dir, &["config", "core.autocrlf", "false"]);
        run_git(dir, &["config", "user.name", "Lithic Test"]);
        run_git(dir, &["config", "user.email", "test@lithic.local"]);
    }

    /// A clean scratch directory under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lithic-sync-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A bare repo standing in for GitHub, seeded with `files`.
    fn seed_remote(root: &Path, files: &[(&str, &str)]) -> PathBuf {
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        run_git(
            root,
            &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        init_repo(&seed);
        for (name, text) in files {
            write(&seed, name, text);
        }
        run_git(&seed, &["add", "."]);
        run_git(&seed, &["commit", "-m", "seed"]);
        run_git(&seed, &["remote", "add", "origin", remote.to_str().unwrap()]);
        run_git(&seed, &["push", "-u", "origin", "main"]);
        remote
    }

    #[test]
    fn the_save_path_only_commits_in_lithic_managed_repos() {
        let root = scratch("managed");
        let remote = seed_remote(&root, &[("wiki.lith", "remote\n")]);
        let local = root.join("local");
        init_repo(&local);
        write(&local, "wiki.lith", "local\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);

        // A folder with no remote at all is not ours to commit into.
        assert_eq!(managed_remote_url(&local), None);

        // Neither is one pointing at a remote the user configured themselves.
        run_git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);
        assert_eq!(managed_remote_url(&local), None);

        // Lithic's own remote is identified by the token it embeds.
        let managed = "https://oauth2:gho_token@github.com/owner/lithic-sync-ab2d.git";
        run_git(&local, &["remote", "set-url", "origin", managed]);
        assert_eq!(managed_remote_url(&local).as_deref(), Some(managed));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_save_commits_the_changed_file_and_skips_empty_commits() {
        let root = scratch("save");
        let remote = seed_remote(&root, &[("wiki.lith", "start\n")]);
        // Start from the remote's history, so the save's push fast-forwards:
        // cloning is what a user would do to get a synced folder either way.
        let local = root.join("local");
        run_git(
            &root,
            &["clone", remote.to_str().unwrap(), local.to_str().unwrap()],
        );
        for (key, value) in [
            ("core.autocrlf", "false"),
            ("user.name", "Lithic Test"),
            ("user.email", "test@lithic.local"),
        ] {
            run_git(&local, &["config", key, value]);
        }

        let repo = gitcore::open(&local).unwrap();
        write(&local, "wiki.lith", "edited\n");
        gitcore::stage_path(&repo, "wiki.lith").unwrap();
        assert!(gitcore::commit(&repo, "save", false).unwrap().is_some());
        gitcore::push_main(&repo, remote.to_str().unwrap(), false).unwrap();
        assert_eq!(run_git(&remote, &["show", "main:wiki.lith"]), "edited");

        // Saving without changes must not pile up empty commits in the repo.
        assert!(gitcore::commit(&repo, "save", false).unwrap().is_none());
        assert_eq!(
            run_git(&local, &["rev-list", "--count", "main"]),
            "2"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_doc_filter_covers_lithic_documents_only() {
        assert!(is_sync_doc("wiki.lith"));
        assert!(is_sync_doc("Nested/Notebook.IPYNB"));
        assert!(is_sync_doc("notes.md"));
        assert!(!is_sync_doc("diagram.png"));
        assert!(!is_sync_doc("no-extension"));
    }

    #[test]
    fn merge_rescues_remote_only_files_and_keeps_the_local_copy_on_a_clash() {
        let root = scratch("merge");
        let remote = seed_remote(
            &root,
            &[
                ("remote-only.lith", "from github\n"),
                ("clash.lith", "github copy\n"),
                ("same.lith", "identical\n"),
                ("projects/paper.lith", "nested from github\n"),
                ("README.md", "project readme\n"),
                ("notes.png", "github image\n"),
            ],
        );
        let local = root.join("local");
        init_repo(&local);
        write(&local, "clash.lith", "local edits\n");
        write(&local, "same.lith", "identical\n");
        write(&local, "mine.lith", "local only\n");
        write(&local, "notes.png", "local image\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);
        run_git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);

        let merge =
            merge_with_remote_branch(&local, &|_, _| {}).expect("merge should succeed");

        // Every remote-only file comes down, documents and non-documents
        // alike, so the union push cannot delete it from GitHub.
        assert_eq!(
            merge.rescued,
            vec!["README.md", "projects/paper.lith", "remote-only.lith"]
        );
        // The clash is reported, not resolved against the local file.
        assert_eq!(merge.diverged, vec!["clash.lith"]);

        // Local-first: the folder's copy of the clash is untouched...
        assert_eq!(
            fs::read_to_string(local.join("clash.lith")).unwrap(),
            "local edits\n"
        );
        // ...and nothing was written anywhere to preserve it.
        assert!(!local.join(".lithic-backups").exists());
        // Rescued files land, nested ones included.
        assert_eq!(
            fs::read_to_string(local.join("remote-only.lith")).unwrap(),
            "from github\n"
        );
        assert_eq!(
            fs::read_to_string(local.join("projects/paper.lith")).unwrap(),
            "nested from github\n"
        );
        assert_eq!(
            fs::read_to_string(local.join("README.md")).unwrap(),
            "project readme\n"
        );
        // A non-document clash is left alone and is not reported as a document
        // divergence.
        assert_eq!(
            fs::read_to_string(local.join("notes.png")).unwrap(),
            "local image\n"
        );
        // Identical files are neither rescued nor reported.
        assert_eq!(
            fs::read_to_string(local.join("same.lith")).unwrap(),
            "identical\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_is_a_no_op_without_a_remote_branch() {
        let root = scratch("fresh");
        let remote = root.join("remote.git");
        let local = root.join("local");

        run_git(
            &root,
            &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        init_repo(&local);
        write(&local, "mine.lith", "local only\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);
        run_git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);

        // A brand-new (empty) GitHub repo must not break the connect.
        let merge = merge_with_remote_branch(&local, &|_, _| {})
            .expect("empty remote should be tolerated");
        assert_eq!(merge, SyncMerge::default());
        assert_eq!(
            fs::read_to_string(local.join("mine.lith")).unwrap(),
            "local only\n"
        );

        // Nor should an unreachable remote.
        run_git(
            &local,
            &["remote", "set-url", "origin", "https://example.invalid/nope.git"],
        );
        let offline = merge_with_remote_branch(&local, &|_, _| {})
            .expect("offline connect should be tolerated");
        assert_eq!(offline, SyncMerge::default());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn connect_publishes_the_union_without_overwriting_local_work() {
        let root = scratch("connect");
        let remote = seed_remote(
            &root,
            &[
                ("remote-only.lith", "from github\n"),
                ("clash.lith", "github copy\n"),
                ("README.md", "project readme\n"),
            ],
        );

        // What the user has been working on locally: a new wiki and one name
        // that already exists on GitHub with different content.
        let local = root.join("local");
        init_repo(&local);
        write(&local, "mine.lith", "local only\n");
        write(&local, "clash.lith", "local edits\n");
        // Nested folders have to survive the libgit2 staging path too: an
        // empty pathspec means "everything", and a pathspec of `*` would have
        // silently skipped files in subfolders.
        write(&local, "projects/nested.lith", "nested local\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);

        let merge =
            sync_with_remote(&local, remote.to_str().unwrap(), &|_, _| {})
                .expect("connect should succeed");
        assert_eq!(merge.rescued, vec!["README.md", "remote-only.lith"]);
        assert_eq!(merge.diverged, vec!["clash.lith"]);

        // GitHub ends up holding the union: the local wiki went up and the
        // remote-only files came down and stayed.
        assert!(remote_has(&remote, "mine.lith"));
        assert!(remote_has(&remote, "projects/nested.lith"));
        assert!(remote_has(&remote, "remote-only.lith"));
        assert!(remote_has(&remote, "README.md"));
        assert!(remote_has(&remote, "clash.lith"));
        // The clash resolved the local way on both sides: the folder's copy was
        // published over GitHub's.
        assert_eq!(
            run_git(&remote, &["show", "main:clash.lith"]),
            "local edits"
        );
        assert_eq!(
            fs::read_to_string(local.join("clash.lith")).unwrap(),
            "local edits\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// The modal's progress line is fed by these stages; without them a slow
    /// first connect sits on a dead "Syncing…" button and reads as frozen.
    #[test]
    fn connect_reports_each_stage_it_reaches() {
        let root = scratch("progress");
        let remote = seed_remote(&root, &[("remote-only.lith", "from github\n")]);
        let local = root.join("local");
        init_repo(&local);
        write(&local, "mine.lith", "local only\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);

        let stages = std::cell::RefCell::new(Vec::new());
        sync_with_remote(&local, remote.to_str().unwrap(), &|stage, _| {
            stages.borrow_mut().push(stage.to_string());
        })
        .expect("connect should succeed");

        let stages = stages.into_inner();
        for expected in ["fetch", "merge", "pull", "commit", "push"] {
            assert!(
                stages.iter().any(|stage| stage == expected),
                "connect never reported the '{}' stage: {:?}",
                expected,
                stages
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    /// A copy into the covered folder is the answer to "this one is not backed
    /// up", so it must not quietly become a move or an overwrite.
    #[test]
    fn copying_into_a_synced_folder_adds_the_file_and_keeps_the_original() {
        let root = scratch("copy-to-synced");
        let source_dir = root.join("downloads");
        let target_dir = root.join("lithic");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        write(&source_dir, "notes.lith", "downloaded\n");
        let source = source_dir.join("notes.lith").to_string_lossy().into_owned();
        let folder = target_dir.to_string_lossy().into_owned();

        let copied = copy_lith_to_synced_dir(source.clone(), folder.clone()).unwrap();
        assert_eq!(copied.name, "notes.lith");
        assert_eq!(fs::read_to_string(target_dir.join("notes.lith")).unwrap(), "downloaded\n");
        // A copy, not a move: the original is the user's file.
        assert!(source_dir.join("notes.lith").is_file());

        // The destination may already hold a different Lith under that name, so a
        // second copy is refused rather than silently replacing it.
        let again = copy_lith_to_synced_dir(source, folder);
        assert!(again.is_err(), "a name collision must be refused");

        let _ = fs::remove_dir_all(&root);
    }

    /// The folder is the backup unit, so a first connect stages whatever is in
    /// it — but a folder of thousands of unrelated files is the wrong unit, and
    /// the count is only knowable before anything is hashed. The index must come
    /// out untouched, because the caller treats a refusal as "leave no trace".
    #[test]
    fn a_first_connect_declines_a_folder_far_larger_than_a_backup() {
        let dir = scratch("oversized");
        gitcore::init(&dir).expect("the fixture repository should be created");
        for index in 0..35 {
            write(&dir, &format!("note-{}.lith", index), "body\n");
        }
        let repo = gitcore::open(&dir).unwrap();

        let mut totals = Vec::new();
        let report = gitcore::stage_working_tree(
            &repo,
            Some(25),
            || false,
            |done, total| totals.push((done, total)),
        )
        .expect("a refusal is an outcome, not an error");

        assert!(report.over_cap);
        assert!(!report.cancelled);
        // The real count, not the cap: the message names the folder's size.
        assert_eq!(report.files, 35);
        assert_eq!(repo.index().unwrap().len(), 0, "nothing may be staged");
        // Nothing is hashed, so the modal gets a count and no progress ticks.
        assert_eq!(totals, Vec::<(usize, usize)>::new());

        let _ = fs::remove_dir_all(&dir);
    }

    /// The staging walk has to be stoppable, or a first connect to the wrong
    /// folder can only be waited out or killed.
    #[test]
    fn a_cancelled_first_connect_stages_nothing() {
        let dir = scratch("cancelled");
        gitcore::init(&dir).expect("the fixture repository should be created");
        for index in 0..10 {
            write(&dir, &format!("note-{}.lith", index), "body\n");
        }
        let repo = gitcore::open(&dir).unwrap();

        let report = gitcore::stage_working_tree(&repo, None, || true, |_, _| {})
            .expect("a cancellation is an outcome, not an error");

        assert!(report.cancelled);
        assert!(!report.over_cap);
        assert_eq!(report.files, 10, "the count is known before the walk starts");
        assert_eq!(repo.index().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Progress is what separates a slow first connect from a frozen one, and it
    /// has to arrive before the first file is hashed rather than after.
    #[test]
    fn staging_reports_its_total_before_it_starts_and_stages_every_file() {
        let dir = scratch("staging");
        gitcore::init(&dir).expect("the fixture repository should be created");
        for index in 0..12 {
            write(&dir, &format!("note-{}.lith", index), "body\n");
        }
        write(&dir, "ignored.lith", "skip me\n");
        write(&dir, ".gitignore", "ignored.lith\n");
        let repo = gitcore::open(&dir).unwrap();

        let mut seen = Vec::new();
        let report = gitcore::stage_working_tree(&repo, None, || false, |done, total| {
            seen.push((done, total));
        })
        .expect("staging should succeed");

        // 13 = twelve notes plus the .gitignore, and not the ignored file.
        assert_eq!(report.files, 13);
        assert_eq!(seen.first(), Some(&(0, 13)));
        assert_eq!(repo.index().unwrap().len(), 13);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A shortcut has to be a real shell link, not merely a file with a `.lnk`
    /// name: Windows reads the header, and a malformed one shows up as a broken
    /// Start Menu entry. Written into a scratch folder — a test has no business
    /// putting an entry in the developer's real Start Menu.
    #[cfg(windows)]
    #[test]
    fn a_shell_link_is_a_real_link_to_the_installed_exe() {
        let root = scratch("shortcut");
        let exe = root.join("Lithic.exe");
        write(&root, "Lithic.exe", "not really an executable");

        let link = root.join("Lithic.lnk");
        write_shell_link(&link, &exe).expect("the shell link should be written");

        let bytes = fs::read(&link).expect("the shortcut file should exist");
        // A shell link opens with a 76-byte header, little-endian, so a wrong
        // or truncated format fails here rather than in Explorer.
        assert_eq!(&bytes[..4], &[0x4c, 0x00, 0x00, 0x00]);
        // The target's name is stored as UTF-16 inside the link, which is how
        // this shows it points at the exe it was asked for and not merely that
        // some bytes were written.
        let target_name: Vec<u8> = "Lithic.exe"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        assert!(
            bytes.windows(target_name.len()).any(|window| window == target_name),
            "the link should hold the target's name in UTF-16"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// Coverage has to answer from the repository *root*: a wiki in a subfolder
    /// is still published by the repository above it, because staging is
    /// recursive. Marking it un-backed-up would be false and would send the
    /// user to create a repository inside another one.
    ///
    /// Discovery is flat, so this is the only place nesting is reasoned about.
    #[test]
    fn coverage_resolves_each_wiki_up_to_its_repository_root() {
        let root = scratch("coverage");
        let local = root.join("Lithic");
        init_repo(&local);
        write(&local, "top.lith", "top\n");
        write(&local, "projects/deep.lith", "deep\n");

        // Somebody else's repository: present, but not Lithic's to back up.
        let private = root.join("private");
        init_repo(&private);
        write(&private, "notes.lith", "notes\n");
        run_git(
            &private,
            &["remote", "add", "origin", "https://github.com/me/private.git"],
        );

        let top = local.join("top.lith").to_string_lossy().into_owned();
        let nested = local
            .join("projects/deep.lith")
            .to_string_lossy()
            .into_owned();
        let outside = private.join("notes.lith").to_string_lossy().into_owned();

        // Not connected yet: a repository with no Lithic remote covers nothing.
        assert!(git_sync_coverage(vec![top.clone(), nested.clone()]).is_empty());

        run_git(
            &local,
            &[
                "remote",
                "add",
                "origin",
                "https://oauth2:gho_token@github.com/owner/lithic-sync-ab2d.git",
            ],
        );
        let covered = git_sync_coverage(vec![top.clone(), nested.clone(), outside.clone()]);
        let expected_root = local.to_string_lossy().into_owned();
        assert_eq!(covered.get(&top), Some(&expected_root));
        assert_eq!(covered.get(&nested), Some(&expected_root));
        assert_eq!(covered.get(&outside), None);

        let _ = fs::remove_dir_all(&root);
    }

    /// Lithic's remote shape, as the connect path writes it.
    const MANAGED_REMOTE: &str = "https://oauth2:gho_token@github.com/owner/lithic-sync-ab2d.git";

    /// A repository with one commit and no remote: what a previous attachment
    /// leaves on disk once its remote is gone. Measured on the user's own
    /// `Documents\Lithic`, whose commits survive and whose origin does not.
    fn commit_repo(dir: &Path) {
        init_repo(dir);
        write(dir, "seed.lith", "seed\n");
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-m", "Initial sync from Lithic"]);
    }

    /// A folder as a *finished* Lithic attachment: Lithic's marker on origin plus
    /// a commit.
    fn attach(dir: &Path) {
        commit_repo(dir);
        run_git(dir, &["remote", "add", "origin", MANAGED_REMOTE]);
    }

    /// The library folder outranks the folder a recent row implies. Without this,
    /// saving one exported Lith into Downloads made the next connect commit
    /// Downloads — the measured failure this exists to prevent.
    #[test]
    fn an_attached_library_outranks_the_derived_folder() {
        let root = scratch("prefer");
        let library = root.join("Documents/Lithic");
        write(&library, "notes.lith", "notes\n");
        attach(&library);

        let downloads = root.join("Downloads");
        write(&downloads, "tiddlers.lith", "stray\n");

        assert_eq!(
            preferred_sync_folder(Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(library.clone())
        );

        // With nothing attached anywhere the launcher keeps what it derived, so a
        // first connect still works in a folder of the user's own choosing.
        let plain = root.join("plain");
        write(&plain, "one.lith", "one\n");
        assert_eq!(
            preferred_sync_folder(Some(&plain.join("one.lith")), &[plain.clone()]),
            None
        );
        // No derived path at all — a fresh install with empty recents — is still
        // enough to answer.
        assert_eq!(preferred_sync_folder(None, &[library.clone()]), Some(library));

        let _ = fs::remove_dir_all(&root);
    }

    /// A folder the user picked in the dialog outranks both automatic rules: the derived
    /// path and the library folder a previous attachment left behind.
    #[test]
    fn a_picked_folder_outranks_the_automatic_answers() {
        let root = scratch("picked");
        let library = root.join("Documents/Lithic");
        write(&library, "notes.lith", "notes\n");
        attach(&library);

        let downloads = root.join("Downloads");
        write(&downloads, "tiddlers.lith", "stray\n");

        let picked = root.join("Notes");
        fs::create_dir_all(&picked).unwrap();

        assert_eq!(
            resolved_sync_folder(Some(&picked), Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(picked)
        );
        // Picking the folder Lithic would have inferred is not a special case: the choice
        // is the answer either way, which is what keeps the dialog from arguing with a
        // user who picked what was already there.
        assert_eq!(
            resolved_sync_folder(Some(&library), Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(library.clone())
        );
        // A folder that is not on this machine is not an answer — the drive it was on is
        // unplugged, or the bundle was copied without it. The dialog goes back to the
        // folder Lithic works out instead of naming a path that is not there.
        assert_eq!(
            resolved_sync_folder(Some(&root.join("gone")), Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(library.clone())
        );
        // With nothing picked, the automatic answer stands.
        assert_eq!(
            resolved_sync_folder(None, Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(library)
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A fresh download with nothing to go on: no recents, no open Lith and no repository
    /// anywhere. The proposal is the program's own folder, and only where that folder is
    /// evidence rather than an accident of where the program was unzipped to.
    #[test]
    fn a_fresh_download_proposes_the_programs_own_folder_only_as_evidence() {
        let root = scratch("propose");
        let bundle = root.join("Lithic");
        fs::create_dir_all(&bundle).unwrap();
        let install = root.join("Documents/Lithic");
        fs::create_dir_all(&install).unwrap();

        // A bundle that already keeps a Lith beside the program: what a thumb drive is, and
        // the portable answer this rule exists for.
        write(&bundle, "notes.lith", "notes\n");
        assert_eq!(
            proposed_sync_folder(Some(&bundle), Some(&install)),
            Some(bundle.clone())
        );

        // The installed app runs from its own install folder, Lith or no Lith: that folder
        // is where liths are meant to live, so it is evidence whatever is in it — which is
        // the empty `Documents\Lithic` a fresh install starts with.
        assert_eq!(
            proposed_sync_folder(Some(&install), Some(&install)),
            Some(install.clone())
        );

        // Somewhere the program was merely unzipped to. No Lith, not the install folder, so
        // it says nothing about where the liths are and the install folder answers instead.
        let downloads = root.join("Downloads");
        fs::create_dir_all(&downloads).unwrap();
        assert_eq!(
            proposed_sync_folder(Some(&downloads), Some(&install)),
            Some(install.clone())
        );

        // Neither on disk: nothing to propose, and the dialog asks rather than naming a path
        // that is not there.
        assert_eq!(proposed_sync_folder(Some(&downloads), Some(&root.join("gone"))), None);
        assert_eq!(proposed_sync_folder(None, None), None);

        let _ = fs::remove_dir_all(&root);
    }

    /// The proposal fills the case where the launcher had nothing of its own, and no case
    /// where it had something: the derived folder is the one the user is working in, and a
    /// proposal about the program's own folder must not outrank it.
    #[test]
    fn the_proposal_only_fills_the_empty_case() {
        let root = scratch("propose-fill");
        let app = root.join("Lithic");
        fs::create_dir_all(&app).unwrap();
        let downloads = root.join("Downloads");
        write(&downloads, "tiddlers.lith", "stray\n");

        // Nothing derived at all: the proposal is the answer, so a fresh download ends up
        // with a folder on the line instead of an empty one.
        assert_eq!(answer_folder(None, None, &[], Some(&app)), Some(app.clone()));
        // A derived path and no evidence anywhere: the launcher keeps the folder it worked
        // out, exactly as it did before this rule existed.
        assert_eq!(
            answer_folder(None, Some(&downloads.join("tiddlers.lith")), &[], Some(&app)),
            None
        );
        // And a pick outranks the proposal, which is the one thing that must not be true of
        // a folder nobody chose.
        let picked = root.join("Notes");
        fs::create_dir_all(&picked).unwrap();
        assert_eq!(
            answer_folder(Some(&picked), None, &[], Some(&app)),
            Some(picked)
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// The picked folder rides in `recents.txt`, spelled relative to the app's own folder
    /// when it lives under it. That spelling is the whole point: a thumb drive gets a
    /// different letter on the next machine, and a relative line still names the folder
    /// beside the executable, which an absolute one would not.
    #[test]
    fn the_picked_folder_rides_in_the_recents_sidecar() {
        let root = scratch("sidecar-folder");
        let app = root.join("Lithic");
        fs::create_dir_all(app.join("liths")).unwrap();
        let elsewhere = root.join("Notes");
        fs::create_dir_all(&elsewhere).unwrap();

        // Under the app's folder: relative, so the bundle keeps its own folder.
        set_sync_folder_in(&app, Some(&app.join("liths"))).unwrap();
        assert_eq!(sync_folder_value_in(&app).as_deref(), Some("liths"));
        assert_eq!(chosen_sync_folder_in(&app), Some(app.join("liths")));
        // The app's folder itself is `.`, not its absolute path.
        set_sync_folder_in(&app, Some(&app)).unwrap();
        assert_eq!(sync_folder_value_in(&app).as_deref(), Some("."));
        assert_eq!(chosen_sync_folder_in(&app), Some(app.clone()));

        // Outside it there is nothing to be relative to, so it stays absolute — and a
        // machine that does not have that folder gets the automatic answer instead.
        set_sync_folder_in(&app, Some(&elsewhere)).unwrap();
        assert_eq!(sync_folder_value_in(&app).as_deref(), Some(elsewhere.to_string_lossy().as_ref()));

        // A recents save carries the choice across rather than sweeping it away, and the
        // marker never becomes a row.
        fs::write(app.join("one.lith"), "one\n").unwrap();
        write_recents_in(&app, vec![app.join("one.lith").to_string_lossy().into_owned()], true).unwrap();
        let text = fs::read_to_string(app.join("recents.txt")).unwrap();
        assert!(text.contains("sync-folder="), "{text}");
        assert!(text.contains("dismissed=1"), "{text}");
        assert_eq!(read_recents_in(&app).len(), 1, "{text}");

        // Clearing it takes only that line: the recents and the dismissal stay.
        set_sync_folder_in(&app, None).unwrap();
        let text = fs::read_to_string(app.join("recents.txt")).unwrap();
        assert!(!text.contains("sync-folder="), "{text}");
        assert!(text.contains("dismissed=1"), "{text}");
        assert_eq!(read_recents_in(&app).len(), 1, "{text}");
        assert_eq!(chosen_sync_folder_in(&app), None);

        let _ = fs::remove_dir_all(&root);
    }

    /// The marker is deliberately not required of the app's own folder: a remote can
    /// be gone while the attachment is real, and the commits it left are the
    /// evidence. The user's `Documents\Lithic` was measured in exactly this state,
    /// so requiring the marker would have left the launcher aiming at a Downloads row.
    #[test]
    fn a_library_whose_remote_is_gone_is_still_the_backup_folder() {
        let root = scratch("lostremote");
        let library = root.join("Documents/Lithic");
        write(&library, "notes.lith", "notes\n");
        commit_repo(&library);
        // Nothing would be committed here right now, and it is still the folder the
        // launcher should be talking about.
        assert!(!is_managed_dir(&library));

        let downloads = root.join("Downloads");
        write(&downloads, "tiddlers.lith", "stray\n");
        assert_eq!(
            preferred_sync_folder(Some(&downloads.join("tiddlers.lith")), &[library.clone()]),
            Some(library)
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A folder with a `.git` and nothing in it is not an attachment: that is what a
    /// connect killed before its first commit leaves behind — measured on the user's
    /// Downloads folder, which carried Lithic's remote and no branch at all.
    #[test]
    fn an_empty_repository_is_not_an_attachment() {
        let root = scratch("emptyrepo");
        let library = root.join("Lithic");
        fs::create_dir_all(&library).unwrap();
        init_repo(&library);
        run_git(&library, &["remote", "add", "origin", MANAGED_REMOTE]);

        assert!(!is_left_repository(&library));
        assert_eq!(preferred_sync_folder(None, &[library.clone()]), None);

        let _ = fs::remove_dir_all(&root);
    }

    /// Disconnect has to leave a mark. The commits stay on disk either way, so
    /// without one the folder it just detached is preferred straight back and there
    /// is no way to point the backup at another folder — which is also why
    /// re-attaching is what lifts it, and why this drives the real connect path.
    #[test]
    fn a_disconnected_library_is_not_preferred_again_until_it_is_attached() {
        let root = scratch("disconnect");
        let library = root.join("Lithic");
        write(&library, "notes.lith", "notes\n");
        attach(&library);
        assert_eq!(preferred_sync_folder(None, &[library.clone()]), Some(library.clone()));

        git_sync_disconnect(library.to_string_lossy().into_owned())
            .expect("disconnect should succeed");
        assert_eq!(preferred_sync_folder(None, &[library.clone()]), None);

        let remote = seed_remote(&root, &[("notes.lith", "remote\n")]);
        sync_with_remote(&library, remote.to_str().unwrap(), &|_, _| {})
            .expect("re-attaching should succeed");
        assert_eq!(preferred_sync_folder(None, &[library.clone()]), Some(library));

        let _ = fs::remove_dir_all(&root);
    }

    /// The folder the user is looking at wins when it is itself attached, and a
    /// wiki nested inside an attachment resolves to the root that publishes it.
    #[test]
    fn an_attachment_behind_the_open_lith_outranks_the_library() {
        let root = scratch("opened");
        let library = root.join("Documents/Lithic");
        write(&library, "notes.lith", "notes\n");
        attach(&library);

        let work = root.join("work");
        write(&work, "projects/deep.lith", "deep\n");
        attach(&work);

        assert_eq!(
            preferred_sync_folder(Some(&work.join("projects/deep.lith")), &[library]),
            Some(work.clone())
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A connect that dies before its first commit leaves the marker and no
    /// commit. Preferring that is what would keep aiming the backup at the folder
    /// that failed, so the marker alone is not an attachment.
    #[test]
    fn a_marker_without_a_commit_is_not_an_attachment() {
        let root = scratch("halfwritten");
        let half = root.join("Downloads");
        write(&half, "tiddlers.lith", "stray\n");
        init_repo(&half);
        run_git(
            &half,
            &[
                "remote",
                "add",
                "origin",
                "https://oauth2:gho_token@github.com/owner/lithic-sync-ab2d.git",
            ],
        );
        // The marker is there — it is what a save would commit through — but no
        // commit has ever landed, so it is not something to aim at.
        assert!(is_managed_dir(&half));
        assert_eq!(
            preferred_sync_folder(Some(&half.join("tiddlers.lith")), &[half.clone()]),
            None
        );

        let library = root.join("Lithic");
        write(&library, "notes.lith", "notes\n");
        attach(&library);
        assert_eq!(
            preferred_sync_folder(Some(&half.join("tiddlers.lith")), &[library.clone()]),
            Some(library)
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A rebuild hands over whichever path it holds, and the launcher hands over a
    /// folder once it has resolved which folder the backup acts on, so the folder
    /// walk has to work from a file inside the folder as well as from the folder
    /// itself.
    #[test]
    fn list_folder_liths_accepts_a_file_or_a_folder() {
        let root = scratch("folderlist");
        write(&root, "one.lith", "one\n");
        write(&root, "sub/two.lith", "two\n");

        let from_folder = list_folder_liths(root.to_string_lossy().into_owned());
        let from_file = list_folder_liths(root.join("one.lith").to_string_lossy().into_owned());
        // Flat: `sub/two.lith` is a different folder's wiki, not this one's.
        assert_eq!(from_folder.len(), 1);
        assert_eq!(from_file, from_folder);

        // The same resolution the sync commands use, so a resolved folder and a
        // Lith inside it address the same place.
        assert_eq!(sync_dir_of(&root), Some(root.clone()));
        assert_eq!(sync_dir_of(&root.join("one.lith")), Some(root.clone()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_lith_wikis_lists_only_the_folder_itself() {
        let root = scratch("recents");
        let local = root.join("local");
        init_repo(&local);
        write(&local, "top.lith", "top\n");
        write(&local, "other.lith", "other\n");
        write(&local, "notes.md", "not a wiki\n");
        write(&local, "projects/nested.lith", "a different folder's wiki\n");
        write(&local, "node_modules/pkg/vendored.lith", "dependency\n");

        let found = list_lith_wikis(&local, WIKI_LIST_LIMIT);
        // Sorted by mtime, so compare as a set; what matters is what is absent.
        let mut names: Vec<String> = found
            .iter()
            .map(|path| {
                Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();

        // Nothing from a subfolder, however deep — including the repository's own.
        assert_eq!(names, vec!["other.lith".to_string(), "top.lith".to_string()]);

        let _ = fs::remove_dir_all(&root);
    }

    /// The remote URL is written by the connect path and read by the health
    /// check, so the two halves have to agree — a drift here would show up as a
    /// user whose sync is fine but whose heartbeat insists it is malformed.
    #[test]
    fn a_managed_remote_round_trips_through_its_parts() {
        let url = sync_remote_url("owner/lithic-sync-ab2d", "gho_token");
        assert_eq!(
            parse_managed_remote(&url),
            Some(ManagedRemote {
                owner: "owner".to_string(),
                name: "lithic-sync-ab2d".to_string(),
                token: "gho_token".to_string(),
            })
        );

        // Lenient about the path, because these remotes outlive the code that
        // wrote them: no `.git`, or a trailing slash, still addresses the repo.
        let no_suffix = parse_managed_remote("https://oauth2:tok@github.com/owner/name").unwrap();
        assert_eq!(no_suffix.name, "name");
        let trailing = parse_managed_remote("https://oauth2:tok@github.com/owner/name/").unwrap();
        assert_eq!(trailing.name, "name");

        // A remote the user configured themselves is never ours to read.
        assert_eq!(parse_managed_remote("https://github.com/owner/name.git"), None);
        // Nor is the marker without a token to use.
        assert_eq!(parse_managed_remote("https://oauth2:@github.com/owner/name.git"), None);
        // Nor a path that is only half a repository.
        assert_eq!(parse_managed_remote("https://oauth2:tok@github.com/owner"), None);
    }

    /// The mapping that decides whether a green icon is honest. A revoked token,
    /// a deleted repository and a read-only token all leave the marker intact,
    /// so this is the only thing between the user and a silent failure.
    #[test]
    fn a_heartbeat_verdict_says_which_failure_it_is() {
        assert_eq!(verdict_for(200, Some(true), false), Health::Ok);
        // A token that can read but not push would otherwise look healthy right
        // up until a save failed to upload.
        assert_eq!(verdict_for(200, Some(false), false), Health::ReadOnly);
        // Permissions absent (an older API shape) still counts as healthy.
        assert_eq!(verdict_for(200, None, false), Health::Ok);
        assert_eq!(verdict_for(401, None, false), Health::Auth);
        // 403 is GitHub's rate limit *and* its forbidden, told apart by header.
        assert_eq!(verdict_for(403, None, true), Health::Throttled);
        assert_eq!(verdict_for(403, None, false), Health::Auth);
        // GitHub answers 404 for a private repository the token cannot see.
        assert_eq!(verdict_for(404, None, false), Health::Missing);
        // A repository with no commits yet is a first push waiting to happen.
        assert_eq!(verdict_for(409, Some(true), false), Health::Ok);
        assert_eq!(verdict_for(500, None, false), Health::Offline);
    }

    /// A plain save in a folder Lithic does not manage must never look like a
    /// failed backup — that is the whole reason the outcome is reported rather
    /// than thrown.
    #[test]
    fn a_save_outside_a_managed_folder_reports_nothing_to_do() {
        let root = scratch("commitoutcome");
        let local = root.join("local");
        init_repo(&local);
        write(&local, "wiki.lith", "local\n");

        let log = CommitLog::default();
        let outcome = tauri::async_runtime::block_on(git_sync_commit_inner(
            local.join("wiki.lith").to_string_lossy().into_owned(),
            "save".to_string(),
            &log,
        ))
        .expect("a save must never fail because there is nothing to sync");
        assert!(!outcome.managed);
        assert!(!outcome.pushed);
        assert_eq!(outcome.error, None);

        let _ = fs::remove_dir_all(&root);
    }

    /// Reconnecting re-points the credential and nothing else: the folder was
    /// already merged, so a re-auth that re-fetched would be slow and a chance
    /// to touch files for no reason.
    #[test]
    fn a_reauth_repoints_the_credential_without_touching_the_work_tree() {
        let root = scratch("reauth");
        let local = root.join("local");
        init_repo(&local);
        write(&local, "wiki.lith", "keep me\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "local"]);
        run_git(
            &local,
            &["remote", "add", "origin", &sync_remote_url("owner/name", "old_token")],
        );
        let before = run_git(&local, &["rev-parse", "HEAD"]);

        let wiki = local.join("wiki.lith").to_string_lossy().into_owned();
        let repo = git_sync_reauth(wiki.clone(), "owner/name.git".to_string(), "new_token".to_string())
            .expect("a managed folder can be re-pointed");
        assert_eq!(repo, "owner/name");
        assert_eq!(
            managed_remote_url(&local).as_deref(),
            Some(sync_remote_url("owner/name", "new_token").as_str())
        );
        assert_eq!(fs::read_to_string(&wiki).unwrap(), "keep me\n");
        assert_eq!(run_git(&local, &["rev-parse", "HEAD"]), before);

        // A folder Lithic does not manage is not ours to re-point.
        run_git(
            &local,
            &["remote", "set-url", "origin", "https://github.com/owner/name.git"],
        );
        assert!(git_sync_reauth(wiki, "owner/name".to_string(), "tok".to_string()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    /// A rejected push has to come back as a failed backup with its reason,
    /// not as a log line: this is the case the icon turns red about, and a
    /// report that swallowed the message would leave a red cloud with nothing
    /// to say about it.
    #[test]
    fn a_rejected_push_is_reported_as_a_failed_backup() {
        let root = scratch("pushreject");
        let remote = seed_remote(&root, &[("wiki.lith", "theirs\n")]);
        let local = root.join("local");
        // An unrelated history cannot fast-forward, which is how a real remote
        // rejects a real push without needing the network.
        init_repo(&local);
        write(&local, "wiki.lith", "mine\n");
        run_git(&local, &["add", "."]);
        run_git(&local, &["commit", "-m", "unrelated"]);
        run_git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);

        let outcome = commit_saved_file(
            &local,
            &local.join("wiki.lith"),
            &sync_remote_url("owner/name", "tok"),
            "save",
        )
        .expect("a rejected push is not a failed save");
        assert!(outcome.managed);
        assert!(!outcome.pushed);
        assert!(
            outcome.error.is_some(),
            "a rejected push must carry the reason it was rejected"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// The log is how a failed backup reaches the icon at all: the save happens
    /// inside the engine document, so nothing else carries the reason back to
    /// the launcher, and a record that outlived its fix would be a permanent
    /// red cloud.
    #[test]
    fn the_commit_log_remembers_a_failure_until_a_push_lands() {
        let log = CommitLog::default();
        let folder = "/documents/lithic";
        assert_eq!(log.last_error(folder), None);

        log.record(folder, Some("not authorized".to_string()));
        assert_eq!(log.last_error(folder).as_deref(), Some("not authorized"));
        // Another folder's failure is not this folder's problem.
        assert_eq!(log.last_error("/documents/work"), None);

        log.record(folder, None);
        assert_eq!(log.last_error(folder), None);
    }

    /// A backup is "running" only between begin and finish, which is the window
    /// in which the launcher, freshly reloaded from a wiki, asks.
    /// The bookmark probe's whole job is telling "not a Lithic instance" apart
    /// from "there, but asking for credentials", and the second case is exactly
    /// the one a CORS-bound browser fetch cannot see.
    #[test]
    fn a_manifest_response_is_classified_by_status_then_content() {
        let lithic = br#"{"name":"Lithic","short_name":"Lithic"}"#;
        assert_eq!(classify_manifest(200, lithic), "lithic");
        // Either field is enough: the launcher checks both.
        assert_eq!(classify_manifest(200, br#"{"short_name":"Lithic"}"#), "lithic");
        assert_eq!(classify_manifest(200, br#"{"name":"Lithic"}"#), "lithic");

        assert_eq!(classify_manifest(401, b""), "protected");
        assert_eq!(classify_manifest(403, b""), "protected");
        // Answered, but not one of ours.
        assert_eq!(classify_manifest(404, b"not found"), "other");
        assert_eq!(classify_manifest(500, b"boom"), "other");
        assert_eq!(classify_manifest(200, br#"{"name":"Something Else"}"#), "other");
        // A JSON parser error is not a crash: an instance behind an auth proxy
        // can answer 200 with a login page.
        assert_eq!(classify_manifest(200, b"<html>login</html>"), "other");
        assert_eq!(classify_manifest(200, b""), "other");
    }

    #[test]
    fn the_commit_log_tracks_a_backup_while_it_runs() {
        let log = CommitLog::default();
        let folder = "/documents/lithic";
        assert!(!log.in_flight(folder));

        log.begin(folder);
        assert!(log.in_flight(folder));
        // Another folder's backup is not this folder's.
        assert!(!log.in_flight("/documents/work"));

        log.finish(folder);
        assert!(!log.in_flight(folder));
    }

    /// Two in-flight backups of one folder must not clear the mark when the
    /// first finishes, or the icon would go idle while the second is still
    /// pushing.
    #[test]
    fn overlapping_backups_hold_the_mark_until_the_last_one_finishes() {
        let log = CommitLog::default();
        let folder = "/documents/lithic";

        log.begin(folder);
        log.begin(folder);
        log.finish(folder);
        assert!(log.in_flight(folder));

        log.finish(folder);
        assert!(!log.in_flight(folder));
        // A finish without a matching begin is harmless, not a panic.
        log.finish(folder);
        assert!(!log.in_flight(folder));
    }

    /// The engine's saver and the launcher's recent list both report a folder,
    /// and the two do not have to agree on the separator. A key that missed
    /// would drop the only signal that a backup stopped landing.
    #[test]
    fn the_commit_log_key_ignores_separator_style() {
        assert_eq!(
            folder_key(Path::new("C:\\Lithic\\work")),
            folder_key(Path::new("C:/Lithic/work"))
        );
    }
}
