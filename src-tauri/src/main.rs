#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::api::dialog::blocking::FileDialogBuilder;

mod gitcore;

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

// Dialog commands are sync (not async): tauri v1 runs sync commands on the
// main thread where the native dialog is modal-safe; async commands run on
// the async runtime and the modal can misbehave.
#[tauri::command]
fn open_lith_file() -> Result<Option<LithFile>, String> {
    let mut dialog = FileDialogBuilder::new()
        .add_filter("Lithic files", &["lith"])
        .add_filter("Text & data files", &["md", "txt", "tid", "json", "ipynb", "html", "htm"])
        .add_filter("All files", &["*"]);
    if let Some(dir) = dialog_start_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(path) = dialog.pick_file() else { return Ok(None); };
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(Some(LithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        text,
    }))
}

#[tauri::command]
fn save_lith_file(
    text: String,
    suggested_name: String,
    path: Option<String>,
) -> Result<SavedLithFile, String> {
    let selected = path.map(PathBuf::from).or_else(|| {
        let mut dialog = FileDialogBuilder::new()
            .set_file_name(&suggested_name)
            .add_filter("Lithic files", &["lith"]);
        if let Some(dir) = dialog_start_dir() {
            dialog = dialog.set_directory(dir);
        }
        dialog.save_file()
    });

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

/// Best-effort progress emit: a closed window just means nobody is watching.
fn report(window: &tauri::Window, stage: &str, detail: &str) {
    let _ = window.emit(
        "git-sync-progress",
        SyncProgress {
            stage: stage.to_string(),
            detail: detail.to_string(),
        },
    );
}

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
    let repo = if dir.join(".git").is_dir() {
        gitcore::open(dir)?
    } else {
        gitcore::init(dir)?
    };
    gitcore::ensure_identity(&repo);
    let _ = gitcore::remove_remote(&repo, "origin");
    gitcore::set_remote(&repo, "origin", remote_url)?;

    // A commit must exist before the merge can compare against the remote and
    // before a branch can be pushed.
    if !gitcore::head_exists(&repo) {
        progress("commit", "Committing the folder's files…");
        gitcore::stage_all(&repo)?;
        gitcore::commit(&repo, "Initial sync from Lithic", true)?;
    }

    // Everything only GitHub has comes down, the folder keeps its own version of
    // anything that exists on both sides, and then the union goes up.
    let merge = merge_with_remote_branch(dir, progress)?;

    gitcore::stage_all(&repo)?;
    progress("commit", "Recording the merged state…");
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
    window: tauri::Window,
) -> Result<GitSyncSetup, String> {
    let file = PathBuf::from(&path);
    let dir = file
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?
        .to_path_buf();
    let repo = repo.trim().trim_end_matches(".git").trim().to_string();
    if repo.is_empty() || token.trim().is_empty() {
        return Err("Both repository (owner/name) and token are required".to_string());
    }

    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<GitSyncSetup, String> {
        let url = format!("https://oauth2:{}@github.com/{}.git", token.trim(), repo);
        let merge = sync_with_remote(&dir, &url, &|stage, detail| report(&window, stage, detail))?;

        let mut summary = format!("Backed up to github.com/{}", repo);
        if !merge.rescued.is_empty() {
            summary.push_str(&format!(" · pulled {} from GitHub", merge.rescued.len()));
        }
        if !merge.diverged.is_empty() {
            summary.push_str(&format!(" · kept {} local", merge.diverged.len()));
        }
        Ok(GitSyncSetup {
            summary,
            recents: list_lith_wikis(&dir, WIKI_LIST_LIMIT),
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    outcome
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
        let mut current = PathBuf::from(&path).parent().map(|parent| parent.to_path_buf());
        while let Some(dir) = current {
            if dir.join(".git").is_dir() && managed_remote_url(&dir).is_some() {
                backed.insert(path.clone(), dir.to_string_lossy().into_owned());
                break;
            }
            current = dir.parent().map(|parent| parent.to_path_buf());
        }
    }
    backed
}

/// Every `.lith` under a folder, for the launcher's re-index.
///
/// Accepts a folder or any file inside it, so the caller can hand over the same
/// path it uses as its sync target without knowing which it holds.
#[tauri::command]
fn list_folder_liths(path: String) -> Vec<String> {
    let given = PathBuf::from(&path);
    let dir = if given.is_dir() {
        given
    } else {
        match given.parent() {
            Some(parent) => parent.to_path_buf(),
            None => return Vec::new(),
        }
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

/// Best-effort auto-commit of one saved file: stage it, commit with the
/// given message, and push when the folder is a git repo with an origin.
/// Skips silently for non-synced folders so plain saves never error.
/// Async so network pushes never block the window's main thread.
#[tauri::command]
async fn git_sync_commit(path: String, message: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let dir = match file.parent().filter(|parent| parent.is_dir()) {
        Some(dir) => dir,
        None => return Ok(()),
    };
    if !dir.join(".git").is_dir() {
        return Ok(());
    }
    // Only auto-commit in repos Lithic configured itself: its remotes embed
    // the oauth2 token, mirroring self-host, so a git folder the user opened a
    // file from is never touched by saves.
    let Some(url) = managed_remote_url(dir) else {
        return Ok(());
    };
    let repo = gitcore::open(dir)?;
    gitcore::ensure_identity(&repo);

    let file_name = match file.file_name().and_then(|name| name.to_str()) {
        Some(name) => name.to_string(),
        None => return Ok(()),
    };
    gitcore::stage_path(&repo, &file_name)?;
    gitcore::commit(&repo, &message, false)?;
    // Push best-effort: offline saves must still succeed locally.
    if let Err(error) = gitcore::push_main(&repo, &url, false) {
        eprintln!("git push skipped: {}", error);
    }
    Ok(())
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

async fn github_post_form(url: &str, form: &str) -> Result<serde_json::Value, String> {
    let client = tauri::api::http::ClientBuilder::new()
        .max_redirections(3)
        .build()
        .map_err(|error| error.to_string())?;
    let request = tauri::api::http::HttpRequestBuilder::new("POST", url)
        .map_err(|error| error.to_string())?
        .header("Accept", "application/json")
        .map_err(|error| error.to_string())?
        .header("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|error| error.to_string())?
        .body(tauri::api::http::Body::Text(form.to_string()));
    let response = client.send(request).await.map_err(|error| error.to_string())?;
    let data = response.read().await.map_err(|error| error.to_string())?;
    Ok(data.data)
}

async fn github_api_get(url: &str, token: &str) -> Result<serde_json::Value, String> {
    let client = tauri::api::http::ClientBuilder::new()
        .max_redirections(3)
        .build()
        .map_err(|error| error.to_string())?;
    let request = tauri::api::http::HttpRequestBuilder::new("GET", url)
        .map_err(|error| error.to_string())?
        .header("Authorization", format!("Bearer {}", token))
        .map_err(|error| error.to_string())?
        .header("Accept", "application/vnd.github.v3+json")
        .map_err(|error| error.to_string())?
        .header("User-Agent", "Lithic-Sync")
        .map_err(|error| error.to_string())?;
    let response = client.send(request).await.map_err(|error| error.to_string())?;
    let data = response.read().await.map_err(|error| error.to_string())?;
    if data.status >= 400 {
        return Err(format!("GitHub API returned {}", data.status));
    }
    Ok(data.data)
}

async fn github_api_post(url: &str, token: &str, json: &serde_json::Value) -> Result<serde_json::Value, String> {
    let client = tauri::api::http::ClientBuilder::new()
        .max_redirections(3)
        .build()
        .map_err(|error| error.to_string())?;
    let request = tauri::api::http::HttpRequestBuilder::new("POST", url)
        .map_err(|error| error.to_string())?
        .header("Authorization", format!("Bearer {}", token))
        .map_err(|error| error.to_string())?
        .header("Accept", "application/vnd.github.v3+json")
        .map_err(|error| error.to_string())?
        .header("User-Agent", "Lithic-Sync")
        .map_err(|error| error.to_string())?
        .header("Content-Type", "application/json")
        .map_err(|error| error.to_string())?
        .body(tauri::api::http::Body::Json(json.clone()));
    let response = client.send(request).await.map_err(|error| error.to_string())?;
    let data = response.read().await.map_err(|error| error.to_string())?;
    if data.status >= 400 {
        let message = data
            .data
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("request failed");
        return Err(format!("GitHub API error ({}): {}", data.status, message));
    }
    Ok(data.data)
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
}

/// Status for the reactive sync icon: connected only when the file's folder
/// is a git repo whose origin was configured by Lithic (oauth2 remote, same
/// marker git_sync_commit uses).
#[tauri::command]
fn git_sync_status(path: String) -> Option<GitSyncStatus> {
    let dir = PathBuf::from(&path).parent()?.to_path_buf();
    if !dir.join(".git").is_dir() {
        return None;
    }
    let url = managed_remote_url(&dir)?;
    let repo = url
        .split("github.com/")
        .nth(1)
        .map(|tail| tail.trim_end_matches(".git").trim().to_string())
        .unwrap_or_else(|| "github repository".to_string());
    Some(GitSyncStatus { connected: true, repo })
}

/// Disconnect: drop the managed origin remote. Refuses to touch repos the
/// user configured themselves (no oauth2 marker) — those aren't ours.
#[tauri::command]
fn git_sync_disconnect(path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let dir = file
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?;
    let repo = gitcore::open(dir)?;
    let url = gitcore::remote_url(&repo, "origin").unwrap_or_default();
    if !url.contains("oauth2:") {
        return Err("This folder is not a Lithic-managed sync folder".to_string());
    }
    gitcore::remove_remote(&repo, "origin")
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
#[tauri::command]
fn read_recents_sidecar() -> Vec<String> {
    let Some(dir) = exe_dir() else { return Vec::new(); };
    let Ok(text) = fs::read_to_string(dir.join("recents.txt")) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
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
    let mut lines = vec![
        "# Lithic recent files (portable). One path per line, most recent first.".to_string(),
    ];
    if dismissed {
        lines.push("dismissed=1".to_string());
    }
    for path in paths.into_iter().take(20) {
        let target = PathBuf::from(&path);
        if let Some(rel) = relative_to(&target, &dir) {
            lines.push(rel.to_string_lossy().into_owned());
        } else {
            lines.push(path);
        }
    }
    fs::write(dir.join("recents.txt"), lines.join("\n") + "\n").map_err(|error| error.to_string())
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
                    .filter(|line| !line.is_empty() && !line.starts_with('#') && *line != "dismissed=1")
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let startup_file = args.get(1).cloned();

    tauri::Builder::default()
        .manage(StartupFile(Mutex::new(startup_file)))
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            get_cli_args,
            read_lith_path,
            open_lith_file,
            save_lith_file,
            write_text_path,
            install_monolith,
            install_status,
            install_offer_status,
            set_install_dismissed,
            read_recents_sidecar,
            write_recents_sidecar,
            git_sync_setup,
            git_sync_commit,
            github_device_code,
            github_device_poll,
            github_list_repos,
            github_create_repo,
            git_sync_status,
            git_sync_disconnect,
            git_sync_coverage,
            list_folder_liths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
mod tests {
    use super::*;

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

    /// A rebuild hands over whichever path it holds, so the folder walk has to
    /// work from a file inside the folder as well as from the folder itself.
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
}
