#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::fs;
use std::path::{Path, PathBuf};
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

// ---- Ephemeral tray handoff ------------------------------------------------
// The tauri app triggers the tray's own user flow instead of any CLI/API
// surface: it parks the Markdown document on the clipboard, simulates the
// tray's ctrl+alt+x hotkey (the exact keystroke a user presses), then polls
// the clipboard for the results block the tray writes back. Nothing here
// changes the tray's behavior or binary profile in any way.

#[derive(serde::Serialize)]
struct EphemeralRunResult {
    stdout: String,
    stderr: String,
}

/// Locate a locally installed Ephemeral tray without any probing: only
/// well-known filesystem locations are checked, in priority order —
/// StartupManager's per-user install copies (%LOCALAPPDATA%\<app_key>\,
/// both the distributed and local tray identities), then beside Lithic.exe
/// itself (thumb-drive bundles carrying both exes).
fn ephemeral_exe_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for app_key in ["Ephemeral-Distributed", "Ephemeral"] {
            candidates.push(
                PathBuf::from(&local)
                    .join(app_key)
                    .join(format!("{app_key}.exe")),
            );
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("Ephemeral.exe"));
            candidates.push(dir.join("Ephemeral").join("Ephemeral.exe"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(windows)]
mod ephemeral_tray {
    const VK_CONTROL: u8 = 0x11;
    const VK_MENU: u8 = 0x12; // Alt
    const VK_X: u8 = 0x58;
    const KEYEVENTF_KEYUP: u32 = 0x0002;

    #[link(name = "user32")]
    extern "system" {
        fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
    }

    /// Send the tray's Run Clipboard hotkey (ctrl+alt+x) as real global
    /// keystrokes — indistinguishable from the user pressing it. The tray's
    /// keyboard hook sees the combo regardless of which window has focus.
    pub(super) fn send_run_hotkey() {
        unsafe {
            keybd_event(VK_CONTROL, 0, 0, 0);
            keybd_event(VK_MENU, 0, 0, 0);
            keybd_event(VK_X, 0, 0, 0);
            keybd_event(VK_X, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

/// Run a Markdown document through the locally installed Ephemeral.exe tray
/// using only surfaces the tray already exposes to its own user: the document
/// goes to the clipboard, the tray's ctrl+alt+x hotkey is simulated, and the
/// clipboard is polled (bounded by `timeout_secs`) for the results the tray
/// writes back. Leaving the results on the clipboard is the tray's own
/// designed behavior (its clipboard-history workflow), so contents are not
/// restored — the tauri path inherits that contract unchanged.
/// Returns a descriptive error when no tray is installed or the run produces
/// no results, so the caller falls back to the paper-light swarm.
#[tauri::command]
fn ephemeral_tray_run(
    app: tauri::AppHandle,
    markdown: String,
    timeout_secs: Option<u64>,
) -> Result<EphemeralRunResult, String> {
    #[cfg(windows)]
    {
        use std::time::{Duration, Instant};
        use tauri::ClipboardManager;

        ephemeral_exe_path()
            .ok_or_else(|| "Ephemeral.exe not found (no local tray installed)".to_string())?;

        let mut clipboard = app.clipboard_manager();
        clipboard
            .write_text(markdown.clone())
            .map_err(|error| format!("Clipboard write failed: {}", error))?;
        // Give the clipboard a moment to settle before the keystrokes land.
        std::thread::sleep(Duration::from_millis(400));

        ephemeral_tray::send_run_hotkey();

        let timeout = Duration::from_secs(timeout_secs.unwrap_or(45).clamp(5, 120));
        let deadline = Instant::now() + timeout;
        let mut result_text: Option<String> = None;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(600));
            if let Ok(Some(text)) = clipboard.read_text() {
                if text != markdown {
                    // The tray writes the results in one shot; take a second
                    // read in case it is still finishing the write.
                    std::thread::sleep(Duration::from_millis(250));
                    result_text = Some(match clipboard.read_text() {
                        Ok(Some(settled)) => settled,
                        _ => text,
                    });
                    break;
                }
            }
        }

        match result_text {
            Some(stdout) => Ok(EphemeralRunResult {
                stdout,
                stderr: String::new(),
            }),
            None => Err(
                "Ephemeral tray run produced no results (is the tray running, and did it accept the document?)"
                    .to_string(),
            ),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, &markdown, &timeout_secs);
        Err("The Ephemeral tray handoff is Windows-only".to_string())
    }
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
fn install_monolith() -> Result<String, String> {
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

    // Reveal the installed exe in Explorer so the user sees where it went.
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&target)
        .spawn();

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
/// Async so the initial push runs off the main thread (it can take seconds).
#[tauri::command]
async fn git_sync_setup(path: String, repo: String, token: String) -> Result<String, String> {
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
    let url = git_run(&dir, &["remote", "get-url", "origin"]).ok()?;
    if !url.contains("oauth2:") {
        return None;
    }
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
    let url = git_run(dir, &["remote", "get-url", "origin"]).unwrap_or_default();
    if !url.contains("oauth2:") {
        return Err("This folder is not a Lithic-managed sync folder".to_string());
    }
    git_run(dir, &["remote", "remove", "origin"]).map(|_| ())
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
            ephemeral_tray_run,
            read_recents_sidecar,
            write_recents_sidecar,
            git_sync_setup,
            git_sync_commit,
            github_device_code,
            github_device_poll,
            github_list_repos,
            github_create_repo,
            git_sync_status,
            git_sync_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
