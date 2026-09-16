#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::api::dialog::blocking::FileDialogBuilder;

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

#[tauri::command]
async fn open_lith_file() -> Result<Option<LithFile>, String> {
    let selected = FileDialogBuilder::new()
        .add_filter("Lithic files", &["lith"])
        .add_filter("Text & data files", &["md", "txt", "tid", "json", "html", "htm"])
        .add_filter("All files", &["*"])
        .pick_file();

    let Some(path) = selected else { return Ok(None); };
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    Ok(Some(LithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        text,
    }))
}

#[tauri::command]
async fn save_lith_file(
    text: String,
    suggested_name: String,
    path: Option<String>,
) -> Result<SavedLithFile, String> {
    let selected = path.map(PathBuf::from).or_else(|| {
        FileDialogBuilder::new()
            .set_file_name(&suggested_name)
            .add_filter("Lithic files", &["lith"])
            .save_file()
    });

    let Some(path) = selected else { return Err("Save cancelled".to_string()); };
    fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(SavedLithFile {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Write arbitrary text to an absolute path (fancy-editor in-place saves for
/// the scratch file types: .md/.txt/.tid/.json). Only existing paths may be
/// overwritten — new files go through save_lith_file's dialog.
#[tauri::command]
fn write_text_path(path: String, text: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err(format!("Refusing to overwrite non-file path: {}", path.display()));
    }
    fs::write(&path, text).map_err(|error| error.to_string())
}

/// Copy the running executable to a stable per-user location so file
/// associations ("Open with Lithic") survive updates and app moves, and
/// register per-user Windows "Open with" entries for the editor file types.
/// Registration is deliberately non-destructive: it adds Lithic to each
/// extension's Open With list without stealing any default association.
#[tauri::command]
fn install_monolith() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;

    // %LOCALAPPDATA%\Programs\Lithic\lithic.exe (per-user, no elevation);
    // falls back to ~/Lithic when LOCALAPPDATA is unavailable.
    let target_dir = dirs::data_local_dir()
        .map(|local| local.join("Programs").join("Lithic"))
        .or_else(|| dirs::home_dir().map(|home| home.join("Lithic")))
        .ok_or_else(|| "Could not resolve a user program directory".to_string())?;

    let file_name = exe
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "lithic.exe".to_string());
    let target = target_dir.join(&file_name);

    // Copy only when different to keep timestamps stable across re-installs.
    let needs_copy = match fs::read(&exe) {
        Ok(current) => fs::read(&target).map(|existing| existing != current).unwrap_or(true),
        Err(_) => true,
    };
    if needs_copy {
        fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
        fs::copy(&exe, &target).map_err(|error| error.to_string())?;
    }

    // Associations point at the *copied* exe so they stay valid even if the
    // original install location changes.
    #[cfg(windows)]
    if let Err(error) = register_open_with(&target.to_string_lossy()) {
        // Best-effort: the copy already succeeded; surface for debugging.
        eprintln!("Open With registration failed: {}", error);
    }

    Ok(target.to_string_lossy().into_owned())
}

/// Extensions the desktop app opens, with their Open With descriptions.
#[cfg(windows)]
const ASSOCIATION_TYPES: &[(&str, &str)] = &[
    ("lith", "Lithic Wiki"),
    ("md", "Lithic Markdown"),
    ("txt", "Lithic Text"),
    ("tid", "Lithic Tiddler"),
    ("json", "Lithic JSON"),
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
            .create_subkey(&format!(".{}", ext))
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
        .create_subkey(&format!(r"Applications\{}", installed_name))
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
            .set_value(&format!(".{}", ext), &String::new())
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// Run `git` in `dir`, returning trimmed combined output. Stderr is merged
/// so git's human-readable failures surface directly in command errors.
fn git_run(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|error| format!("git unavailable: {}", error))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    let text = text.trim().to_string();
    if output.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            text
        })
    }
}

/// Like git_run but tolerates "nothing to commit"-style no-ops.
fn git_run_lenient(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    match git_run(dir, args) {
        Ok(text) => Ok(text),
        Err(error) => {
            let lower = error.to_lowercase();
            if lower.contains("nothing to commit") || lower.contains("no changes added") {
                Ok(String::new())
            } else {
                Err(error)
            }
        }
    }
}

/// Ensure the repo has an identity so commits never fail on fresh machines.
fn ensure_git_identity(dir: &std::path::Path) {
    let has_name = git_run(dir, &["config", "user.name"]).map(|v| !v.is_empty()).unwrap_or(false);
    if !has_name {
        let _ = git_run(dir, &["config", "user.name", "Lithic"]);
        let _ = git_run(dir, &["config", "user.email", "lithic@local"]);
    }
}

/// Set up the directory containing `path` as a git repo synced to a GitHub
/// remote — the desktop analog of the self-host github-sync workflow: init
/// (if needed), point origin at the repo with the token embedded (same as
/// self-host's oauth2 URL), then force-push the current state to main.
#[tauri::command]
fn git_sync_setup(path: String, repo: String, token: String) -> Result<String, String> {
    let file = PathBuf::from(&path);
    let dir = file
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| format!("Cannot resolve a folder for {}", path))?;
    let repo = repo.trim().trim_end_matches(".git").trim();
    if repo.is_empty() || token.trim().is_empty() {
        return Err("Both repository (owner/name) and token are required".to_string());
    }

    if !dir.join(".git").is_dir() {
        match git_run(dir, &["init", "-b", "main"]) {
            Ok(_) => {}
            Err(_) => {
                // Older git without `init -b`: init then re-point HEAD.
                git_run(dir, &["init"])?;
                let _ = git_run(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
            }
        }
    }
    ensure_git_identity(dir);

    let url = format!("https://oauth2:{}@github.com/{}.git", token.trim(), repo);
    let _ = git_run(dir, &["remote", "remove", "origin"]);
    git_run(dir, &["remote", "add", "origin", &url])?;

    git_run(dir, &["add", "."])?;
    git_run_lenient(dir, &["commit", "-m", "Initial sync from Lithic"])?;
    git_run(dir, &["push", "-fu", "origin", "main"])?;

    Ok(format!("Syncing {} to github.com/{}", dir.display(), repo))
}

/// Best-effort auto-commit of one saved file: stage it, commit with the
/// given message, and push when the folder is a git repo with an origin.
/// Skips silently for non-synced folders so plain saves never error.
#[tauri::command]
fn git_sync_commit(path: String, message: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let dir = match file.parent().filter(|parent| parent.is_dir()) {
        Some(dir) => dir,
        None => return Ok(()),
    };
    if !dir.join(".git").is_dir() {
        return Ok(());
    }
    let has_origin = git_run(dir, &["remote"])
        .map(|remotes| remotes.lines().any(|line| line.trim() == "origin"))
        .unwrap_or(false);
    if !has_origin {
        return Ok(());
    }
    // Only auto-commit in repos Lithic configured itself (its remotes embed
    // the oauth2 token, mirroring self-host). Random git folders the user
    // opened files from are never touched by saves.
    let managed = git_run(dir, &["remote", "get-url", "origin"])
        .map(|url| url.contains("oauth2:"))
        .unwrap_or(false);
    if !managed {
        return Ok(());
    }
    ensure_git_identity(dir);

    let file_name = match file.file_name().and_then(|name| name.to_str()) {
        Some(name) => name.to_string(),
        None => return Ok(()),
    };
    git_run(dir, &["add", "--", &file_name])?;
    git_run_lenient(dir, &["commit", "-m", &message])?;
    // Push best-effort: offline saves must still succeed locally.
    if let Err(error) = git_run(dir, &["push", "-u", "origin", "main"]) {
        eprintln!("git push skipped: {}", error);
    }
    Ok(())
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
            git_sync_setup,
            git_sync_commit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
