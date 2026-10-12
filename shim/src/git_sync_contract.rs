//! The GitHub-sync contract generated from `launcher-ui/src/git-sync-contract.ts`.
//! Do not edit by hand; `npm run contract` writes this file and `check:push` checks it.

pub const TRAIL_LIMIT: usize = 10;
pub const TRAIL_LIMIT_MAX: usize = 50;
pub const FIRST_SYNC_FILE_CAP: usize = 2000;
pub const MAIN: &str = "refs/heads/main";
pub const REMOTE_MAIN: &str = "refs/remotes/origin/main";
pub const ORIGIN_FETCH_SPEC: &str = "+refs/heads/*:refs/remotes/origin/*";
pub const PRE_REVERT_MESSAGE: &str = "Save before revert";
pub const REVERT_MESSAGE_PREFIX: &str = "Revert to ";
pub const MANAGED_MARKER: &str = "oauth2:";

/// Classify one GitHub repository response using the ordered rules in the sync contract.
pub fn classify(status: u16, push_allowed: Option<bool>, rate_limited: bool) -> &'static str {
    match status {
        200..=299 | 409 => if push_allowed == Some(false) { "readonly" } else { "ok" },
        401 => "auth",
        403 => if rate_limited { "throttled" } else { "auth" },
        404 => "missing",
        _ => "offline",
    }
}

/// The backend sentence for a verdict, replacing `{repo}` with `owner/name`.
pub fn detail(state: &str, repo: &str, empty: bool) -> String {
    let template = if state == "ok" && empty {
        "github.com/{repo} is empty, so the next save starts it."
    } else {
        match state {
            "ok" => "Backed up to github.com/{repo}.",
            "readonly" => "This token can only read github.com/{repo}. Reconnect to allow pushes.",
            "auth" => "GitHub rejected this token. Reconnect to sign in again.",
            "missing" => "github.com/{repo} is missing or not shared with this token.",
            "throttled" => "GitHub is rate-limiting this device. Saves stay local for now.",
            "malformed" => "This folder's saved remote is unreadable. Reconnect to repair it.",
            "unmanaged" => "This folder is not synced.",
            _ => "Cannot reach github.com. Saves stay on this device.",
        }
    };
    template.replace("{repo}", repo)
}
