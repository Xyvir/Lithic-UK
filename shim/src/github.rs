//! The GitHub half of the sync: the device flow, and the two REST calls the setup needs.
//!
//! Why this lives in the shim at all. A page cannot run the device flow itself, and not
//! because of anything about this page: `https://github.com/login/device/code` answers with no
//! `Access-Control-Allow-Origin` at all, so a browser refuses the request before it leaves.
//! That is the same reason self-host proxies these calls through its CGI handler
//! (`deploy/github-sync.sh`) and the desktop app makes them from Rust, and it is the reason a
//! shim serving the launcher has to make them too rather than leaving the page to it.
//! `api.github.com` does allow cross-origin reads, so the two REST calls could have been made
//! from the page, but doing all four here means one token path and one place the credential is
//! handled, which is worth more than the two calls it saves.
//!
//! The four commands are `github-device-code`, `github-device-poll`, `github-list-repos` and
//! `github-create-repo`, and each one mirrors the desktop app's own command of the same name
//! down to the shape of the answer, because the launcher's decoding (`github-device.ts`) is
//! shared between the two and must not have to care which backend answered.
//!
//! The transport is `ureq`, blocking, with `native-tls`: the shim is one thread per
//! connection, so a blocking client is the shape that fits, and on Linux `native-tls` is the
//! same `openssl-sys` that libgit2's transport uses, which is what keeps one TLS stack in the
//! artifact instead of two (see the round log under `docs/rounds/`). On Windows and macOS it is the platform stack,
//! which needs no OpenSSL at all. **The feature alone does not choose it**: ureq's provider
//! defaults to rustls whatever the features are, so [`agent`] names `native-tls` and the
//! platform trust store explicitly. Left at the defaults, an `https` request panics instead of
//! failing, and a panic in a connection thread takes the whole shim with it.
//!
//! What is deliberately not here: no token is held between commands. The launcher keeps the
//! token for the length of a setup and hands it back on each call, exactly as it does with the
//! desktop app, and where it comes to rest afterwards is git's own credential helper rather
//! than a file this process writes. See the credential entry in the round log (`docs/rounds/`).

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

use crate::command::{bad_args, failed_with, ok, path_arg};
use crate::git::{managed_remote_url, parse_managed_remote, sync_dir_of};
use crate::Response;

/// The Lithic Sync GitHub App, the same client id self-host's `GITHUB_CLIENT_ID` carries.
/// Overridable at runtime for a local test, exactly as the desktop app's is.
const DEFAULT_CLIENT_ID: &str = "Iv23lippjEJMp4KLlLKI";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_REPOS_URL: &str = "https://api.github.com/user/repos?type=owner&sort=updated&per_page=100";
const CREATE_REPO_URL: &str = "https://api.github.com/user/repos";

/// The scope the device flow asks for. `repo` is what a private sync repository needs, and it
/// is the same single scope self-host asks for.
const SCOPE: &str = "repo";

/// The credential the device flow grants, in the shape `github-device.ts` reads it.
const TOKEN_FIELD: &str = "access_token";

/// The error code a failed GitHub call answers with, so the launcher can tell a refusal that
/// came from GitHub from one that came from the wire. The message rides beside it in `detail`
/// rather than replacing it, because GitHub's own text is what the user is shown either way.
const FAILED: &str = "github";

/// `github-device-code`
///
/// Step one of the flow: ask GitHub for a user code to show the person. The answer is passed
/// through as GitHub wrote it (`device_code`, `user_code`, `verification_uri`, `expires_in`,
/// `interval`), because the launcher's decoder is the one place that shape is understood.
pub(crate) fn device_code() -> Response {
    match post_form(DEVICE_CODE_URL, &device_code_form(&client_id())) {
        Ok(data) => match device_code_answer(&data) {
            Ok(answer) => ok(answer),
            Err(detail) => failed_with(FAILED, detail),
        },
        Err(detail) => failed_with(FAILED, detail),
    }
}

/// `github-device-poll { deviceCode }`
///
/// Step two: poll while the person authorizes. `pending` is the ordinary answer for the whole
/// time they are still typing, so it is a success rather than a failure, and `slow_down` rides
/// with it because GitHub asks the poller to wait longer rather than to stop.
pub(crate) fn device_poll(args: &Value) -> Response {
    let Some(device_code) = args.get("deviceCode").and_then(Value::as_str) else {
        return bad_args();
    };
    if device_code.trim().is_empty() {
        return bad_args();
    }
    let form = device_poll_form(&client_id(), device_code);
    match post_form(ACCESS_TOKEN_URL, &form) {
        Ok(data) => match device_poll_answer(&data) {
            Ok(answer) => ok(answer),
            Err(detail) => failed_with(FAILED, detail),
        },
        Err(detail) => failed_with(FAILED, detail),
    }
}

/// `github-list-repos { token }`
///
/// The repositories the account owns, newest-updated first, as `{ full_name }` rows. Owning
/// them is the filter: what the dialog offers is the caller's own repositories, and the
/// `owner` type is what says so.
pub(crate) fn list_repos(args: &Value) -> Response {
    let Some(token) = args.get("token").and_then(Value::as_str) else {
        return bad_args();
    };
    match api_get(USER_REPOS_URL, token.trim()) {
        Ok(data) => match repo_rows(&data) {
            Ok(rows) => ok(json!(rows)),
            Err(detail) => failed_with(FAILED, detail),
        },
        Err(detail) => failed_with(FAILED, detail),
    }
}

/// `github-create-repo { token, name }`
///
/// Creates the private repository a first connect backs up into. Private and described, and
/// never public: the whole point of the feature is a backup, and a public repository of
/// somebody's notes is not a default anybody asked for.
pub(crate) fn create_repo(args: &Value) -> Response {
    let Some(token) = args.get("token").and_then(Value::as_str) else {
        return bad_args();
    };
    let Some(name) = args.get("name").and_then(Value::as_str) else {
        return bad_args();
    };
    let name = name.trim();
    if name.is_empty() {
        return bad_args();
    }
    let body = json!({
        "name": name,
        "private": true,
        "description": "Lithic Automated Sync",
    });
    match api_post(CREATE_REPO_URL, token.trim(), &body) {
        Ok(data) => match created_repo(&data) {
            Ok(full_name) => ok(json!({ "full_name": full_name })),
            Err(detail) => failed_with(FAILED, detail),
        },
        Err(detail) => failed_with(FAILED, detail),
    }
}

/// `git-heartbeat { path }`
///
/// Is the sync to GitHub actually working? One authenticated request against the repository
/// the folder's own remote names, which is what covers what the marker check cannot: a revoked
/// token, a repository that was deleted or renamed, and a token that can read but not push.
///
/// It is a REST call and not a git one, and that is not a shortcut: the desktop app's
/// heartbeat is exactly this, and libgit2 has no cheap "can I push" probe. It never answers a
/// failure, because "cannot reach github.com" is a verdict the launcher renders rather than a
/// command that went wrong, and "this folder is not synced" is an ordinary state.
pub(crate) fn git_heartbeat(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(dir) = sync_dir_of(&path) else { return ok(unmanaged()) };
    let Some(url) = managed_remote_url(&dir) else { return ok(unmanaged()) };
    let Some((repo, token)) = parse_managed_remote(&url) else { return ok(malformed()) };
    let endpoint = format!("https://api.github.com/repos/{repo}");
    match api_probe(&endpoint, &token) {
        Ok((status, rate_limited, push_allowed)) => ok(verdict(status, push_allowed, rate_limited, &repo)),
        // The transport error goes to the log where it is useful for diagnosis rather than
        // into the one sentence the launcher shows.
        Err(reason) => {
            eprintln!("shim: heartbeat offline: {reason}");
            ok(offline(&repo))
        }
    }
}

/// No repository Lithic manages contains the path.
fn unmanaged() -> Value {
    json!({ "state": "unmanaged", "repo": "", "detail": "This folder is not synced.", "last_commit_error": Value::Null })
}

/// The marker is there but cannot be read: reconnect is the repair.
fn malformed() -> Value {
    json!({
        "state": "malformed",
        "repo": "",
        "detail": "This folder's saved remote is unreadable. Reconnect to repair it.",
        "last_commit_error": Value::Null,
    })
}

/// The repository could not be reached at all.
fn offline(repo: &str) -> Value {
    json!({
        "state": "offline",
        "repo": repo,
        "detail": "Cannot reach github.com. Saves stay on this device.",
        "last_commit_error": Value::Null,
    })
}

/// The status, the token's push permission and a rate limit turned into the launcher's own
/// verdict plus the one sentence its tooltip and dialog show.
fn verdict(status: u16, push_allowed: Option<bool>, rate_limited: bool, repo: &str) -> Value {
    let state = match status {
        // 409 is a repository with no commits yet: the repository and the token are fine, and
        // the branch simply does not exist until the first push lands.
        200..=299 | 409 => match push_allowed {
            Some(false) => "readonly",
            _ => "ok",
        },
        401 => "auth",
        403 if rate_limited => "throttled",
        403 => "auth",
        404 => "missing",
        _ => "offline",
    };
    let detail = match state {
        // A freshly created repository has no commits until the first push, which is a first
        // backup waiting to happen rather than a fault.
        "ok" if status == 409 => format!("github.com/{repo} is empty, so the next save starts it."),
        "ok" => format!("Backed up to github.com/{repo}."),
        "readonly" => format!("This token can only read github.com/{repo}. Reconnect to allow pushes."),
        "auth" => "GitHub rejected this token. Reconnect to sign in again.".to_string(),
        "missing" => format!("github.com/{repo} is missing or not shared with this token."),
        "throttled" => "GitHub is rate-limiting this device. Saves stay local for now.".to_string(),
        _ => "Cannot reach github.com. Saves stay on this device.".to_string(),
    };
    json!({ "state": state, "repo": repo, "detail": detail, "last_commit_error": Value::Null })
}

// ---------------------------------------------------------------------------
// What each answer means
//
// These are pure, and they carry the whole of what the commands decide: the transport below
// only moves bytes. That is why the tests can walk every GitHub answer that matters (a token,
// a pending poll, a back-off, a refusal, a repository list, a created repository) without a
// network and without a TLS stack.
// ---------------------------------------------------------------------------

/// The client id this process will present.
fn client_id() -> String {
    std::env::var("GITHUB_CLIENT_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// The form the device-code request carries.
fn device_code_form(client_id: &str) -> String {
    format!("client_id={client_id}&scope={SCOPE}")
}

/// The form the token poll carries. The grant type is the RFC 8628 one, spelled out because
/// GitHub requires it and a device code alone is not a grant.
fn device_poll_form(client_id: &str, device_code: &str) -> String {
    format!(
        "client_id={client_id}&device_code={device_code}\
         &grant_type=urn:ietf:params:oauth:grant-type:device_code"
    )
}

/// The device-code answer, which is either the code to show or GitHub's own error.
fn device_code_answer(data: &Value) -> Result<Value, String> {
    if let Some(error) = text(data, "error") {
        return Err(text(data, "error_description").unwrap_or(error));
    }
    Ok(data.clone())
}

/// The poll's answer, normalized to the three states the poller knows: a token, still waiting,
/// or a failure worth showing.
fn device_poll_answer(data: &Value) -> Result<Value, String> {
    if let Some(token) = text(data, TOKEN_FIELD) {
        return Ok(json!({ TOKEN_FIELD: token }));
    }
    match text(data, "error").as_deref() {
        // Expected for the whole time the person is authorizing, so it is not a failure.
        Some("authorization_pending") => Ok(json!({ "pending": true })),
        // GitHub asking the poller to slow down, carried beside `pending` so the launcher can
        // lengthen its interval rather than stop.
        Some("slow_down") => Ok(json!({ "pending": true, "slow_down": true })),
        Some(error) => Err(text(data, "error_description").unwrap_or_else(|| error.to_string())),
        None => Err("GitHub did not return a token".to_string()),
    }
}

/// The repository rows out of the list answer.
fn repo_rows(data: &Value) -> Result<Vec<Value>, String> {
    let Some(array) = data.as_array() else {
        return Err("Unexpected response from GitHub".to_string());
    };
    Ok(array
        .iter()
        .filter_map(|repo| text(repo, "full_name"))
        .map(|full_name| json!({ "full_name": full_name }))
        .collect())
}

/// The created repository's full name.
fn created_repo(data: &Value) -> Result<String, String> {
    text(data, "full_name").ok_or_else(|| "GitHub did not return the new repository".to_string())
}

/// A string field, or nothing when it is absent or not a string.
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/// The one outbound client, built once. It owns the connection pool, which matters because the
/// poll runs every few seconds and a fresh client would re-handshake each time.
///
/// Two settings are load bearing. `http_status_as_error(false)` is what lets a 4xx body be
/// read: GitHub reports an expired device code and a rate limit as a 4xx whose body says
/// which, and the poller has to see that rather than a bare status. And the 30 second cap is
/// the shim's own patience: a request that outlives it would outlive the connection thread
/// that is waiting on it, since the write timeout there is the same 30 seconds.
///
/// The two TLS settings are the third and fourth, and they are named for the "load bearing"
/// sentence above rather than for taste, because **both of them are a panic at ureq's defaults
/// on this build rather than a wrong answer**, and a panic in a connection thread is not a
/// failed command: `panic = "abort"` is set for the release profile, so it ends the process
/// (measured: exit code 134 on the first `github-device-code`, and the page's fetch then fails
/// with no answer at all, which the launcher renders as `unreachable`).
///
///   * `provider(TlsProvider::NativeTls)`: ureq's default provider is Rustls *whatever the
///     features are*, and `default-features = false` dropped rustls, so an `https` URI reaches
///     the transport with a provider this binary does not have. ureq panics with "uri scheme is
///     https, provider is Rustls but feature is not enabled: rustls". Enabling the `native-tls`
///     feature is not the same thing as selecting it; the crate's own documentation says the
///     setting "is never picked up automatically".
///   * `root_certs(RootCerts::PlatformVerifier)`: the default is `RootCerts::WebPki`, whose
///     native-tls arm calls `disable_built_in_roots(true)` and verifies against a *bundled*
///     copy of the Mozilla root program instead of the machine's trust store. That is the
///     opposite of the decision recorded for this crate (the TLS is the system's), and it is
///     also the one thing a person behind a corporate proxy would hit. On the rustls path the
///     same default is a panic without `native-tls-webpki-roots`, which this build does have;
///     naming the platform verifier makes the answer the machine's roots on both paths rather
///     than an accident of which feature pulled which blob.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent()
    })
}

/// A form-encoded POST, answered as JSON. The `Accept` header is what makes GitHub answer JSON
/// at all: without it the device endpoints reply form-encoded, which nothing here reads.
fn post_form(url: &str, form: &str) -> Result<Value, String> {
    let response = agent()
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(form)
        .map_err(|error| error.to_string())?;
    read_json(response)
}

/// One authenticated GET that reports the raw status and the two things a verdict needs: the
/// token's push permission, and whether GitHub is rate-limiting this device.
///
/// The status is read before the body, and a 4xx is an answer here rather than an error, which
/// is what the shared agent's `http_status_as_error(false)` buys.
fn api_probe(url: &str, token: &str) -> Result<(u16, bool, Option<bool>), String> {
    let response = agent()
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Lithic-Sync")
        .call()
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let rate_limited = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim() == "0")
        .unwrap_or(false);
    let data = read_json(response)?;
    let push_allowed = data
        .get("permissions")
        .and_then(|permissions| permissions.get("push"))
        .and_then(Value::as_bool);
    Ok((status, rate_limited, push_allowed))
}

/// A GET against the REST API. An empty token is the public API, and the header is left off
/// entirely rather than sent empty, because GitHub rejects a bare `Bearer`.
fn api_get(url: &str, token: &str) -> Result<Value, String> {
    let mut request = agent()
        .get(url)
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Lithic-Sync");
    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    // `call` rather than `send`: ureq types a request with no body apart from one that has
    // one, so the bodyless builder is the one that answers it.
    let response = request.call().map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let data = read_json(response)?;
    if status >= 400 {
        return Err(api_error(status, &data));
    }
    Ok(data)
}

/// A JSON POST against the REST API, with the status checked after the body is read so the
/// message GitHub sent is what the user sees.
fn api_post(url: &str, token: &str, body: &Value) -> Result<Value, String> {
    let response = agent()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "Lithic-Sync")
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let data = read_json(response)?;
    if status >= 400 {
        return Err(api_error(status, &data));
    }
    Ok(data)
}

/// GitHub's own sentence about a failed call, or the status when the body does not carry one.
/// A non-JSON error page still has to surface as the status rather than as a decode failure.
fn api_error(status: u16, data: &Value) -> String {
    match text(data, "message") {
        Some(message) => format!("GitHub API error ({status}): {message}"),
        None => format!("GitHub API returned {status}"),
    }
}

/// A response body parsed as JSON.
fn read_json(response: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let text = response.into_body().read_to_string().map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|_| "GitHub did not answer with JSON".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_code_form_asks_for_the_scope_the_sync_needs() {
        assert_eq!(device_code_form("abc"), "client_id=abc&scope=repo");
    }

    #[test]
    fn the_poll_form_names_the_grant_type_github_requires() {
        let form = device_poll_form("abc", "code-1");
        assert!(form.contains("client_id=abc"));
        assert!(form.contains("device_code=code-1"));
        assert!(form.contains("grant_type=urn:ietf:params:oauth:grant-type:device_code"));
    }

    #[test]
    fn a_device_code_answer_is_passed_through_as_github_wrote_it() {
        let answer = json!({
            "device_code": "d",
            "user_code": "WXYZ-2345",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5,
        });
        assert_eq!(device_code_answer(&answer).expect("an answer"), answer);
    }

    #[test]
    fn a_refused_device_code_names_githubs_reason() {
        let refused = json!({ "error": "unauthorized_client", "error_description": "bad id" });
        assert_eq!(device_code_answer(&refused).expect_err("refused"), "bad id");
        let bare = json!({ "error": "unauthorized_client" });
        assert_eq!(device_code_answer(&bare).expect_err("refused"), "unauthorized_client");
    }

    #[test]
    fn a_poll_answers_a_token_waiting_or_a_backoff_never_a_failure_while_waiting() {
        assert_eq!(
            device_poll_answer(&json!({ "access_token": "ghp_x" })).expect("token"),
            json!({ "access_token": "ghp_x" })
        );
        assert_eq!(
            device_poll_answer(&json!({ "error": "authorization_pending" })).expect("waiting"),
            json!({ "pending": true })
        );
        assert_eq!(
            device_poll_answer(&json!({ "error": "slow_down" })).expect("backoff"),
            json!({ "pending": true, "slow_down": true })
        );
    }

    #[test]
    fn a_poll_that_really_failed_says_why() {
        let expired = json!({ "error": "expired_token", "error_description": "the code expired" });
        assert_eq!(device_poll_answer(&expired).expect_err("expired"), "the code expired");
        let bare = json!({ "error": "incorrect_device_code" });
        assert_eq!(device_poll_answer(&bare).expect_err("wrong"), "incorrect_device_code");
        assert!(device_poll_answer(&json!({ "ok": true })).is_err());
    }

    #[test]
    fn repository_rows_keep_only_the_names_and_a_missing_one_is_not_a_row() {
        let data = json!([
            { "full_name": "owner/one", "private": true },
            { "name": "no-full-name" },
            { "full_name": "owner/two" },
        ]);
        assert_eq!(repo_rows(&data).expect("rows"), vec![json!({ "full_name": "owner/one" }), json!({ "full_name": "owner/two" })]);
        assert!(repo_rows(&json!({ "message": "Not Found" })).is_err());
    }

    #[test]
    fn a_created_repository_answers_its_full_name_and_nothing_else_does() {
        assert_eq!(created_repo(&json!({ "full_name": "owner/new" })).expect("created"), "owner/new");
        assert!(created_repo(&json!({ "message": "already exists" })).is_err());
    }

    #[test]
    fn a_failed_api_call_carries_githubs_own_sentence() {
        assert_eq!(
            api_error(401, &json!({ "message": "Bad credentials" })),
            "GitHub API error (401): Bad credentials"
        );
        // A non-JSON error page still reports as the status rather than as a decode failure.
        assert_eq!(api_error(502, &Value::Null), "GitHub API returned 502");
    }

    #[test]
    fn a_heartbeat_verdict_reads_the_status_and_the_tokens_permission_together() {
        assert_eq!(verdict(200, Some(true), false, "o/n")["state"], json!("ok"));
        assert_eq!(
            verdict(200, Some(true), false, "o/n")["detail"],
            json!("Backed up to github.com/o/n.")
        );
        // A repository with no commits yet is a first backup waiting to happen, not a fault.
        let empty = verdict(409, Some(true), false, "o/n");
        assert_eq!(empty["state"], json!("ok"));
        assert_eq!(empty["detail"], json!("github.com/o/n is empty, so the next save starts it."));
        // A token that can read but not push is its own verdict, because the repository is
        // perfectly reachable and the backup is still not happening.
        assert_eq!(verdict(200, Some(false), false, "o/n")["state"], json!("readonly"));
        assert_eq!(verdict(401, None, false, "o/n")["state"], json!("auth"));
        // A 403 is auth unless GitHub said it was a rate limit, which is why the header is read.
        assert_eq!(verdict(403, None, false, "o/n")["state"], json!("auth"));
        assert_eq!(verdict(403, None, true, "o/n")["state"], json!("throttled"));
        assert_eq!(verdict(404, None, false, "o/n")["state"], json!("missing"));
        assert_eq!(verdict(500, None, false, "o/n")["state"], json!("offline"));
    }

    #[test]
    fn the_two_ordinary_states_name_themselves_and_carry_no_repository() {
        assert_eq!(unmanaged()["state"], json!("unmanaged"));
        assert_eq!(unmanaged()["repo"], json!(""));
        assert_eq!(malformed()["state"], json!("malformed"));
        assert_eq!(offline("o/n")["repo"], json!("o/n"));
    }

    #[test]
    fn the_outbound_agent_names_the_platform_tls_stack_and_the_platform_trust_store() {
        // Both values are a panic at ureq's defaults on this build rather than a wrong
        // answer, and a panic here ends the process rather than failing one command, so they
        // are pinned rather than assumed. First measured against the released
        // `Lithic_10.01.26-2129.AppImage`: `github-device-code` aborted the shim with
        // "uri scheme is https, provider is Rustls but feature is not enabled: rustls", and
        // the launcher's own result was a fetch that answered nothing.
        let tls = agent().config().tls_config();
        assert!(matches!(tls.provider(), TlsProvider::NativeTls));
        assert!(matches!(tls.root_certs(), RootCerts::PlatformVerifier));
        // And the one thing that is never allowed to move, whatever else is configured here.
        assert!(!tls.disable_verification());
    }

    #[test]
    fn the_client_id_can_be_overridden_the_way_the_desktop_apps_can() {
        // Read through the same function the commands use, so the default and the override
        // cannot drift apart. The env var is not set in this test process, which is the point.
        assert_eq!(client_id(), DEFAULT_CLIENT_ID);
    }
}
