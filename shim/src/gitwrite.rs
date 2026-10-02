//! The git sync writes: libgit2 for the repository, and a job for anything slow.
//!
//! Why libgit2 rather than the system `git`. The desktop app made the same call for the same
//! reason (`src-tauri/src/gitcore.rs`): shelling out makes the app depend on git being
//! installed *and* on `PATH`, a requirement that stays invisible until it fails, that a "Git
//! from Git Bash only" Windows install silently breaks, and that pops a console window for
//! every spawn. Here it would be worse, because a shim is a download somebody runs on a
//! machine nobody has vetted for it. libgit2 is compiled into this binary, so there is nothing
//! to install and nothing to spawn.
//!
//! Why a job rather than one request and one answer. The shim serves one thread per
//! connection, with a thirty second write timeout on each (`shim/src/lib.rs`), and a first
//! clone or a large push runs past that. So the two commands that can take a while answer at
//! once with `{ job: id }`, the work runs on a thread of its own, and the page polls `git-job`
//! for the state and can `git-cancel` it. The reads (`git.rs`) and the two commands that only
//! touch a config file (`git-reauth`, `git-disconnect`) stay synchronous, because a job for
//! something that finishes in a millisecond is a round trip for nothing.
//!
//! Cancellation is **per job**, not one flag for the process as the desktop app has it. That
//! is a deliberate difference and it is a fix: the desktop app's flag once let a cancelled
//! connect abort the *next* save's push, because the two share it. A job here carries its own
//! flag, so cancelling one cannot reach another.
//!
//! The on-disk format is git's own, so a folder synced by this module keeps working with real
//! git and the other way round.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use git2::build::RepoBuilder;
use git2::{
    Cred, ErrorCode, FetchOptions, PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions,
    RepositoryOpenFlags, Signature, StatusOptions,
};
use serde_json::{json, Value};

use crate::command::{bad_args, failed_with, ok, path_arg, path_text};
use crate::git::{liths_in, managed_remote_url, sync_dir_of};
use crate::syncfolder::{connect_dir, proposed};
use crate::Response;

/// The error code every one of these answers with, with the reason in `detail`.
const FAILED: &str = "git";

/// How many files one first connect may stage before the folder is refused.
///
/// The same backstop the desktop app has, and for the same reason: the sync target is derived
/// from a recent file, so a Lith saved into `Downloads` aims the connect at the whole folder.
/// Thousands of unrelated files, hours of hashing, and a repository nobody asked for becomes
/// one sentence instead.
///
/// Applied **before the fetch**, which is where the desktop app applies it, and that placement
/// was a bug here until it was measured: a connect aimed at a personal `~/Documents` spent
/// minutes downloading the repository it was pointed at, wrote the remote's files into that
/// folder, and only then counted the folder and refused it (see [`undo_first_connect`]).
const FIRST_SYNC_FILE_CAP: usize = 2000;

/// The branch the sync publishes, on both sides.
const MAIN: &str = "refs/heads/main";
/// The remote-tracking ref the first connect reads.
const REMOTE_MAIN: &str = "refs/remotes/origin/main";
/// The fetch refspec `git remote add` writes, so a user running git by hand in the folder
/// afterwards gets the remote-tracking refs they expect.
const ORIGIN_FETCH_SPEC: &str = "+refs/heads/*:refs/remotes/origin/*";

/// The key that records a folder the user took out of sync by hand. In the repository's own
/// config rather than beside the app, because it is a fact about this folder.
const DETACHED_KEY: &str = "lithic.detached";

/// How many finished jobs are kept before the oldest is dropped. The page polls a job until it
/// reaches a terminal state and stops, so this only bounds the memory of a long-lived shim.
const JOB_HISTORY: usize = 32;

/// The reason a cancelled job reports, mapped to its own state rather than to an error.
const CANCELLED: &str = "cancelled";

fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// ---------------------------------------------------------------------------
// The job registry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Running,
    Done,
    Failed,
    Cancelled,
}

impl State {
    fn text(self) -> &'static str {
        match self {
            State::Running => "running",
            State::Done => "done",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
        }
    }
}

struct Job {
    state: State,
    /// The line the page shows under the spinner, set as the work moves.
    stage: String,
    error: Option<String>,
    result: Option<Value>,
    cancel: Arc<AtomicBool>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// A running job's own handle, which is how the work reports progress and notices a cancel.
#[derive(Clone)]
pub(crate) struct Progress {
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl Progress {
    /// Say what the job is doing now, for the line under the spinner.
    pub(crate) fn say(&self, stage: &str) {
        if let Ok(mut jobs) = jobs().lock() {
            if let Some(job) = jobs.get_mut(&self.id) {
                job.stage = stage.to_string();
            }
        }
    }

    /// Whether the page asked this job to stop.
    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// The flag itself, for the transfers that take it directly rather than through this
    /// handle: libgit2's callbacks are `'static` and cannot borrow.
    fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }
}

/// Start a job and answer its id at once. The work runs on its own thread.
fn start<F>(first_stage: &str, work: F) -> u64
where
    F: FnOnce(Progress) -> Result<Value, String> + Send + 'static,
{
    let id = NEXT_JOB.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut jobs) = jobs().lock() {
        jobs.insert(
            id,
            Job {
                state: State::Running,
                stage: first_stage.to_string(),
                error: None,
                result: None,
                cancel: Arc::clone(&cancel),
            },
        );
        // Drop the oldest finished jobs once there are too many to care about. A running job
        // is never dropped, however tight the bound.
        while jobs.len() > JOB_HISTORY {
            let oldest = jobs
                .iter()
                .filter(|(_, job)| job.state != State::Running)
                .map(|(id, _)| *id)
                .min();
            match oldest {
                Some(id) => {
                    jobs.remove(&id);
                }
                None => break,
            }
        }
    }
    std::thread::spawn(move || {
        let progress = Progress {
            id,
            cancel: Arc::clone(&cancel),
        };
        let outcome = work(progress);
        if let Ok(mut jobs) = jobs().lock() {
            if let Some(job) = jobs.get_mut(&id) {
                match outcome {
                    Ok(result) => {
                        job.state = State::Done;
                        job.result = Some(result);
                    }
                    Err(error) if error == CANCELLED => {
                        job.state = State::Cancelled;
                    }
                    Err(error) => {
                        job.state = State::Failed;
                        job.error = Some(error);
                    }
                }
                job.stage.clear();
            }
        }
    });
    id
}

/// `git-job { id }`
///
/// The poll. `state` is the whole answer a caller needs: `done` means `result` is there,
/// `failed` means `error` is, and `cancelled` is neither, because a job the user stopped is
/// not a fault to report.
pub(crate) fn job(args: &Value) -> Response {
    let Some(id) = args.get("id").and_then(Value::as_u64) else { return bad_args() };
    let Ok(jobs) = jobs().lock() else {
        return failed_with(FAILED, "the job list is unavailable".to_string());
    };
    let Some(job) = jobs.get(&id) else {
        // An id nobody knows is a job that finished and was forgotten, or one from a previous
        // launch of the shim. Either way it is answered rather than refused, so a poll that
        // arrives late is not an error the page has to render.
        return ok(json!({ "state": "unknown" }));
    };
    ok(json!({
        "state": job.state.text(),
        "stage": job.stage,
        "error": job.error,
        "result": job.result,
    }))
}

/// `git-cancel { id }`
///
/// A request rather than a fact: the work stops at its next checkpoint, which the staging walk
/// reaches per file and a transfer reaches on every progress callback.
pub(crate) fn cancel(args: &Value) -> Response {
    let Some(id) = args.get("id").and_then(Value::as_u64) else { return bad_args() };
    let Ok(jobs) = jobs().lock() else { return ok(json!({ "stopped": false })) };
    let Some(job) = jobs.get(&id) else { return ok(json!({ "stopped": false })) };
    if job.state != State::Running {
        return ok(json!({ "stopped": false }));
    }
    job.cancel.store(true, Ordering::SeqCst);
    ok(json!({ "stopped": true }))
}

// ---------------------------------------------------------------------------
// libgit2, the way the desktop app uses it
// ---------------------------------------------------------------------------

/// Open the repository at `dir` without searching parent folders: the sync only ever acts on
/// the folder the user's file lives in, never on some enclosing repository it happens to sit
/// inside.
fn open(dir: &Path) -> Result<Repository, String> {
    Repository::open_ext(dir, RepositoryOpenFlags::NO_SEARCH, std::iter::empty::<&Path>()).map_err(fail)
}

/// Create a repository whose initial branch is `main`, with line endings pinned off.
///
/// The pin matters on Windows: the whole point of the sync is that a Lith's bytes survive the
/// round trip, and `core.autocrlf` would rewrite them on the way into the object database.
/// Repositories the user created themselves are never touched.
fn init(dir: &Path) -> Result<Repository, String> {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(dir, &options).map_err(fail)?;
    if let Ok(mut config) = repo.config() {
        let _ = config.set_bool("core.autocrlf", false);
    }
    Ok(repo)
}

/// Give the repository an identity to commit with, so a machine with no global git config can
/// still sync. Existing configuration always wins.
fn ensure_identity(repo: &Repository) {
    let Ok(mut config) = repo.config() else { return };
    let has_name = config
        .get_string("user.name")
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        let _ = config.set_str("user.name", "Lithic");
        let _ = config.set_str("user.email", "lithic@local");
    }
}

fn mark_detached(repo: &Repository) {
    if let Ok(mut config) = repo.config() {
        let _ = config.set_bool(DETACHED_KEY, true);
    }
}

fn clear_detached(repo: &Repository) {
    if let Ok(mut config) = repo.config() {
        let _ = config.remove(DETACHED_KEY);
    }
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("Lithic", "lithic@local"))
        .map_err(fail)
}

/// The URL Lithic writes for a repository it manages. One function, so the connect path and
/// the reconnect path cannot drift apart.
fn managed_url(repo: &str, token: &str) -> String {
    format!("https://oauth2:{}@github.com/{}.git", token.trim(), repo.trim())
}

/// Credentials embedded in the remote URL. Lithic stores the token there, so libgit2 normally
/// has them already; this is the fallback for when it asks a callback instead.
fn url_credentials(url: &str) -> Option<(String, String)> {
    let rest = url.split_once("://")?.1;
    let (userinfo, _) = rest.split_once('@')?;
    let (user, password) = userinfo.split_once(':')?;
    Some((user.to_string(), password.to_string()))
}

fn callbacks(
    url: &str,
    rejected: Option<Arc<Mutex<Option<String>>>>,
    cancel: Arc<AtomicBool>,
) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let credentials = url_credentials(url);
    callbacks.credentials(move |_url, _username, _allowed| match &credentials {
        Some((user, password)) => Cred::userpass_plaintext(user, password),
        None => Cred::default(),
    });
    if let Some(slot) = rejected {
        // libgit2 reports a per-ref rejection here rather than as an error, so without this a
        // refused push (protected branch, stale token, a remote that moved on) would look like
        // success and the user would believe a save had been backed up.
        callbacks.push_update_reference(move |refname, status| {
            if let Some(status) = status {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(format!("{refname} was rejected: {status}"));
                }
            }
            Ok(())
        });
    }
    // Cancelling between stages is not enough: a big first connect spends most of its life
    // inside these transfers, and returning false here is the only exit libgit2 offers once
    // one has started.
    callbacks.transfer_progress(move |_progress| !cancel.load(Ordering::SeqCst));
    callbacks
}

/// Fetch `main` into the remote-tracking ref. `false` means there was nothing to read: a
/// repository with no `main` yet, or a remote that cannot be reached. Both are ordinary on a
/// first connect, and the push that follows surfaces a genuinely broken remote with a real
/// error rather than a silent one.
fn fetch_main(repo: &Repository, url: &str, cancel: &Arc<AtomicBool>) -> bool {
    let Ok(mut remote) = repo.find_remote("origin") else { return false };
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(url, None, Arc::clone(cancel)));
    let refspec = format!("+{MAIN}:{REMOTE_MAIN}");
    remote.fetch(&[refspec.as_str()], Some(&mut options), None).is_ok()
}

/// Every file path one ref holds, in tree order.
fn files_at(repo: &Repository, rev: &str) -> Vec<String> {
    let Ok(tree) = repo
        .find_reference(rev)
        .and_then(|reference| reference.peel_to_commit())
        .and_then(|commit| commit.tree())
    else {
        return Vec::new();
    };
    let mut files = Vec::new();
    let _ = tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Ok(name) = entry.name() {
                files.push(format!("{root}{name}"));
            }
        }
        git2::TreeWalkResult::Ok
    });
    files
}

/// The bytes of `path` as `rev` stores them, with no checkout filters applied.
fn bytes_at(repo: &Repository, rev: &str, path: &str) -> Option<Vec<u8>> {
    let tree = repo
        .find_reference(rev)
        .and_then(|reference| reference.peel_to_commit())
        .and_then(|commit| commit.tree())
        .ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(blob.content().to_vec())
}

/// Write the remote's files that this folder does not already have, and nothing else.
///
/// This is the rescue a first connect needs when both sides hold something. It only ever
/// *adds*: a path the folder already has is left exactly as it is, because the folder is what
/// the user is working in and the remote's copy stays in git's history either way. Returns how
/// many files were written.
fn rescue_missing(repo: &Repository, dir: &Path, progress: &Progress) -> usize {
    let mut written = 0;
    for path in files_at(repo, REMOTE_MAIN) {
        if progress.cancelled() {
            break;
        }
        let target = dir.join(&path);
        if target.exists() {
            continue;
        }
        let Some(bytes) = bytes_at(repo, REMOTE_MAIN, &path) else { continue };
        if let Some(parent) = target.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(&target, bytes).is_ok() {
            written += 1;
        }
    }
    written
}

/// What one staging pass did.
struct StageReport {
    files: usize,
    over_cap: bool,
    cancelled: bool,
}

/// Stage the working tree while reporting progress, refusing a folder over `cap` files and
/// stopping when the job is cancelled.
///
/// Not `add_all` with its own callback, which is where the desktop app started and which
/// segfaults: libgit2 hands that callback a NULL matched-pathspec whenever the walk has no
/// pathspec (always, here) and git2 0.21's trampoline turns it into `CStr::from_ptr(null)`.
/// Measured there as an access violation, not as anything a compiler reports.
///
/// Enumerating the status list instead costs one walk either way, and buys everything the
/// callback was wanted for: an exact count *before* anything is hashed, so an oversized folder
/// is refused in milliseconds with the index untouched, and a cancel that lands per file.
fn stage_working_tree(repo: &Repository, progress: &Progress) -> Result<StageReport, String> {
    let work = pending_paths(repo)?;
    let total = work.len();
    if total > FIRST_SYNC_FILE_CAP {
        return Ok(StageReport { files: total, over_cap: true, cancelled: false });
    }
    let mut index = repo.index().map_err(fail)?;
    for (path, removed) in work {
        if progress.cancelled() {
            return Ok(StageReport { files: total, over_cap: false, cancelled: true });
        }
        let staged = if removed {
            // Gone from disk, so it leaves the index too, which is what `git add .` does.
            // Absent from the index already is not a failure.
            match index.remove_path(&path) {
                Err(error) if error.code() == ErrorCode::NotFound => Ok(()),
                outcome => outcome,
            }
        } else {
            index.add_path(&path)
        };
        staged.map_err(fail)?;
    }
    index.write().map_err(fail)?;
    Ok(StageReport { files: total, over_cap: false, cancelled: false })
}

/// How many files a first connect would have to stage, counted and nothing more.
///
/// The same walk as [`stage_working_tree`] with none of its effects: nothing hashed, no index
/// written, no commit. It exists so the cap can be answered before the fetch, which is the
/// difference between declining a folder in one walk and declining it after minutes of
/// transfer, with the remote's files already written into somebody's home folder.
fn count_working_tree(repo: &Repository) -> Result<usize, String> {
    Ok(pending_paths(repo)?.len())
}

/// The paths a walk of the working tree would stage, each with whether it is gone from disk.
///
/// Owned rather than borrowed from the status list, because the callers need the index, which
/// is not shareable with the list the entries borrow.
fn pending_paths(repo: &Repository) -> Result<Vec<(PathBuf, bool)>, String> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(fail)?;
    let mut work: Vec<(PathBuf, bool)> = Vec::new();
    for entry in statuses.iter() {
        // A non-UTF-8 path cannot be addressed by the index API here; skipping it is the same
        // thing `add_all` does with one.
        let Ok(path) = entry.path() else { continue };
        // A trailing separator is libgit2's own mark for a directory it did not descend into,
        // and the one that puts itself there is a nested repository: a checkout of something
        // else sitting inside the folder being backed up. The walk reports it as a single
        // entry, `GitHub/Lithic-UK/`, because recursing into it would mean treating somebody
        // else's history as this folder's content. `index.add_path` refuses that entry
        // outright, and it was measured doing it: `invalid path: 'GitHub/Lithic-UK/';
        // class=Index (10)`, which reached the dialog as the whole of what went wrong with a
        // first connect. Recording it as a gitlink instead would be worse than refusing it,
        // because the commit a gitlink names lives in a repository Lithic has no objects for,
        // so the backup would carry a pointer nobody could resolve. Skipping is also what a
        // person means by backing up a folder rather than everything that happens to sit in
        // it, and it is what makes the count above and the staging below agree about the same
        // set.
        if path.ends_with('/') {
            continue;
        }
        work.push((PathBuf::from(path), entry.status().is_wt_deleted()));
    }
    Ok(work)
}

/// Leave a folder as it was found when a first connect is declined or cancelled.
///
/// The desktop app's rule, and it is about the same folder: `git_sync_setup` there removes the
/// origin Lithic added and deletes a repository Lithic created, because "a declined or
/// cancelled first connect must not leave a `.git` sitting in somebody's Downloads folder".
/// The shim did neither, so a connect aimed at the wrong folder left a `.git` and a whole pack
/// behind it, in a folder whose owner had just been told nothing was backed up. Takes the
/// repository by value because the directory cannot be removed while it is open on Windows.
fn undo_first_connect(repo: Repository, dir: &Path, existed: bool) {
    let _ = repo.remote_delete("origin");
    drop(repo);
    if !existed {
        let _ = std::fs::remove_dir_all(dir.join(".git"));
    }
}

/// Commit the staged tree, returning the new id, or `None` when the tree is identical to the
/// parent's and `allow_empty` is false. That `None` is git's "nothing to commit", which the
/// sync has always treated as a no-op: a save that changes nothing must not pile up empty
/// commits in the user's repository.
fn commit_staged(repo: &Repository, message: &str, allow_empty: bool) -> Result<Option<git2::Oid>, String> {
    let mut index = repo.index().map_err(fail)?;
    let tree_id = index.write_tree().map_err(fail)?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if !allow_empty {
        if let Some(parent) = &parent {
            if parent.tree_id() == tree_id {
                return Ok(None);
            }
        }
    }
    let tree = repo.find_tree(tree_id).map_err(fail)?;
    let signature = signature(repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)
        .map_err(fail)?;
    Ok(Some(oid))
}

/// Publish `main`. `force` rewrites the remote branch, and is used only by the first connect,
/// whose local history by construction does not descend from what the remote had: the remote's
/// files were rescued onto disk first, so nothing it held is lost.
fn push_main(repo: &Repository, url: &str, force: bool, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    let mut remote = repo.find_remote("origin").map_err(fail)?;
    let rejected = Arc::new(Mutex::new(None));
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks(url, Some(Arc::clone(&rejected)), Arc::clone(cancel)));
    let refspec = if force {
        format!("+{MAIN}:{MAIN}")
    } else {
        format!("{MAIN}:{MAIN}")
    };
    remote.push(&[refspec.as_str()], Some(&mut options)).map_err(fail)?;
    if let Some(message) = rejected.lock().ok().and_then(|slot| slot.clone()) {
        return Err(message);
    }
    // Refresh the remote-tracking ref, which is what `git push` does and what the next read of
    // "the remote's main" depends on.
    if let Ok(oid) = repo.refname_to_id(MAIN) {
        let _ = repo.reference(REMOTE_MAIN, oid, true, "lithic: synced");
    }
    Ok(())
}

/// Create or re-point `origin`, adding the standard fetch refspec so a fetch populates
/// `refs/remotes/origin/*` exactly like `git remote add` does.
fn set_remote(repo: &Repository, url: &str) -> Result<(), String> {
    match repo.find_remote("origin") {
        Ok(_) => repo.remote_set_url("origin", url).map_err(fail)?,
        Err(_) => {
            repo.remote("origin", url).map_err(fail)?;
        }
    }
    let has_spec = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.fetch_refspecs().ok())
        .map(|specs| specs.iter().any(|spec| spec.ok().flatten() == Some(ORIGIN_FETCH_SPEC)))
        .unwrap_or(false);
    if !has_spec {
        repo.remote_add_fetch("origin", ORIGIN_FETCH_SPEC).map_err(fail)?;
    }
    Ok(())
}

/// Whether a folder holds anything at all. A clone into a folder that is not empty fails, so
/// the connect path asks before choosing.
fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).map(|mut entries| entries.next().is_none()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// `git-setup { path, repo, token }`
///
/// The connect, and the one command that takes long enough to be worth a job. What it does
/// depends on what is already on disk:
///
///   * an empty folder is cloned, which is the "this repository is my backup" case;
///   * a folder with files and no repository is initialised, the remote's files that are
///     missing here are rescued onto disk, everything is committed and the result is pushed,
///     rewinding the remote branch when it had one (nothing it held is lost, because the
///     rescue ran first);
///   * a folder that already is a repository is re-pointed at the remote, committed and
///     pushed without force, so a remote that has moved on is refused rather than overwritten.
///
/// One of those folders may not be there at all: the folder the shim proposes
/// (`Documents/Lithic`, `syncfolder::proposed`) is what a machine that has never synced is
/// offered, and this is the command that makes it. That is what lets a new device connect to
/// an existing backup in one press, because a folder made here is empty and the clone above is
/// what then runs.
pub(crate) fn setup(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(repo) = args.get("repo").and_then(Value::as_str).map(str::to_string) else {
        return bad_args();
    };
    let Some(token) = args.get("token").and_then(Value::as_str).map(str::to_string) else {
        return bad_args();
    };
    if repo.trim().is_empty() || token.trim().is_empty() {
        return bad_args();
    }
    // The folder the dialog named, made when it is the one the shim itself proposed: a machine
    // that has never synced has no `Documents/Lithic`, and the first connect is what creates it.
    let Some(dir) = connect_dir(&path, proposed().as_deref()) else {
        return failed_with(FAILED, format!("Cannot resolve a folder for {}", path_text(&path)));
    };
    let url = managed_url(&repo, &token);
    let id = start("Reading the folder", move |progress| connect(&dir, &url, &repo, &progress));
    ok(json!({ "job": id }))
}

/// The connect itself, on the job's own thread.
fn connect(dir: &Path, url: &str, repo: &str, progress: &Progress) -> Result<Value, String> {
    let cancel = progress.flag();
    let already = dir.join(".git").is_dir();
    let mut rescued = 0usize;
    let mut files = 0usize;

    if !already && is_empty_dir(dir) {
        progress.say("Cloning the repository");
        clone_into(url, dir, &cancel)?;
    } else {
        let opened = if already { open(dir)? } else { init(dir)? };
        ensure_identity(&opened);
        set_remote(&opened, url)?;
        clear_detached(&opened);
        // The cap is a fact about the folder, so it is answered before the folder is used for
        // anything: no fetch, no rescue, no write. The desktop app reaches the same place by
        // staging and committing the folder first and merging with the remote second, and
        // measured the other way round this was minutes of download followed by the same
        // refusal, with the remote's files already written into the folder.
        if !already || opened.head().is_err() {
            let would_stage = count_working_tree(&opened)?;
            if would_stage > FIRST_SYNC_FILE_CAP {
                let message = format!(
                    "This folder holds {would_stage} files. Back up the folder your liths live in."
                );
                undo_first_connect(opened, dir, already);
                return Err(message);
            }
        }
        if progress.cancelled() {
            undo_first_connect(opened, dir, already);
            return Err(CANCELLED.to_string());
        }
        progress.say("Reading the repository");
        let had_main = fetch_main(&opened, url, &cancel);
        if had_main {
            progress.say("Adding the repository's files");
            rescued = rescue_missing(&opened, dir, progress);
        }
        if progress.cancelled() {
            undo_first_connect(opened, dir, already);
            return Err(CANCELLED.to_string());
        }
        progress.say("Committing the folder's files");
        let staged = stage_working_tree(&opened, progress)?;
        if staged.cancelled {
            undo_first_connect(opened, dir, already);
            return Err(CANCELLED.to_string());
        }
        if staged.over_cap {
            let message = format!(
                "This folder holds {} files. Back up the folder your liths live in.",
                staged.files
            );
            undo_first_connect(opened, dir, already);
            return Err(message);
        }
        files = staged.files;
        commit_staged(&opened, "Lithic backup", true)?;
        progress.say("Pushing to GitHub");
        push_main(&opened, url, had_main, &cancel)?;
    }

    let mut summary = format!("Backed up to github.com/{}", repo);
    if rescued > 0 {
        summary.push_str(&format!(", pulled {rescued} files from GitHub"));
    }
    if files > 0 && rescued == 0 {
        summary.push_str(&format!(", {files} files"));
    }
    Ok(json!({ "summary": summary, "recents": liths_in(dir) }))
}

/// `git-commit { path, message }`
///
/// One save. Refreshes the remote (which is what carries a rotated token), stages the file
/// that was saved, commits it and pushes. A folder Lithic does not manage answers
/// `{ managed: false }` rather than an error, exactly as the desktop app does: the save itself
/// succeeded, and there was simply nothing for the backup to do.
pub(crate) fn commit(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Lithic save")
        .to_string();
    let Some(dir) = sync_dir_of(&path).filter(|dir| dir.is_dir()) else {
        return ok(json!({ "managed": false, "pushed": false, "error": null }));
    };
    let Some(url) = managed_remote_url(&dir) else {
        return ok(json!({ "managed": false, "pushed": false, "error": null }));
    };
    let file = if path.is_file() { path_text(&path) } else { String::new() };
    let id = start("Backing up", move |progress| save(&dir, &url, &file, &message, &progress));
    ok(json!({ "job": id }))
}

/// One save, on the job's own thread.
fn save(dir: &Path, url: &str, file: &str, message: &str, progress: &Progress) -> Result<Value, String> {
    let cancel = progress.flag();
    let repo = open(dir)?;
    // Re-point first: a reconnected folder's token lives in the URL, and a save is the one
    // thing that is always on the user's critical path.
    set_remote(&repo, url)?;
    ensure_identity(&repo);
    if !file.is_empty() {
        let mut index = repo.index().map_err(fail)?;
        index.add_path(Path::new(file)).map_err(fail)?;
        index.write().map_err(fail)?;
    }
    progress.say("Committing");
    commit_staged(&repo, message, false)?;
    if progress.cancelled() {
        return Err(CANCELLED.to_string());
    }
    progress.say("Pushing to GitHub");
    match push_main(&repo, url, false, &cancel) {
        Ok(()) => Ok(json!({ "managed": true, "pushed": true, "error": null })),
        // A failed push is reported rather than returned as a failure: the save itself
        // succeeded, and the folder is now ahead of GitHub. An offline save must still work.
        Err(error) => Ok(json!({ "managed": true, "pushed": false, "error": error })),
    }
}

/// `git-reauth { path, repo, token }`
///
/// Re-point a synced folder at the same repository with a fresh token, and do nothing else.
/// The remedy for a token GitHub no longer accepts: going through the full connect again would
/// re-fetch and re-merge a folder that has already been merged, which is a lot of work and a
/// chance to touch files for no reason.
pub(crate) fn reauth(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(repo_name) = args.get("repo").and_then(Value::as_str) else { return bad_args() };
    let Some(token) = args.get("token").and_then(Value::as_str) else { return bad_args() };
    let Some(dir) = sync_dir_of(&path).filter(|dir| dir.is_dir()) else {
        return failed_with(FAILED, format!("Cannot resolve a folder for {}", path_text(&path)));
    };
    if !dir.join(".git").is_dir() {
        return failed_with(FAILED, "This folder is not a git repository".to_string());
    }
    let repo = match open(&dir) {
        Ok(repo) => repo,
        Err(error) => return failed_with(FAILED, error),
    };
    if managed_remote_url(&dir).is_none() {
        return failed_with(FAILED, "This folder is not a Lithic-managed sync folder".to_string());
    }
    if let Err(error) = set_remote(&repo, &managed_url(repo_name, token)) {
        return failed_with(FAILED, error);
    }
    clear_detached(&repo);
    ok(json!({ "repo": repo_name.trim() }))
}

/// `git-disconnect { path }`
///
/// Drop the managed origin and record the folder as detached, which is what stops the launcher
/// preferring a folder the user has deliberately stopped backing up. Refuses to touch a
/// repository Lithic did not configure: its origin is not ours to remove.
pub(crate) fn disconnect(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(dir) = sync_dir_of(&path).filter(|dir| dir.is_dir()) else {
        return failed_with(FAILED, format!("Cannot resolve a folder for {}", path_text(&path)));
    };
    let repo = match open(&dir) {
        Ok(repo) => repo,
        Err(error) => return failed_with(FAILED, error),
    };
    match managed_remote_url(&dir) {
        Some(_) => {}
        None => {
            return failed_with(FAILED, "This folder is not a Lithic-managed sync folder".to_string())
        }
    }
    if let Err(error) = repo.remote_delete("origin") {
        return failed_with(FAILED, error.to_string());
    }
    // Recorded because the commits stay behind: without it the launcher would keep preferring
    // this folder and there would be no way to back up another one.
    mark_detached(&repo);
    // And the recorded folder pick goes with it, for the desktop app's reason: the pick was
    // made for the backup that just ended, and the dialog offers the picker only while setting
    // one up, so a folder recorded for a gone backup is a choice nobody can see or undo.
    // Best-effort, because the disconnect is what the user asked for.
    let _ = crate::syncfolder::clear_pick();
    ok(json!({ "disconnected": true }))
}

/// Clone a remote into an empty folder, with the same callbacks the other transfers use.
fn clone_into(url: &str, dir: &Path, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    let mut builder = RepoBuilder::new();
    let mut fetch = FetchOptions::new();
    fetch.remote_callbacks(callbacks(url, None, Arc::clone(cancel)));
    builder.fetch_options(fetch);
    let repo = builder.clone(url, dir).map_err(fail)?;
    ensure_identity(&repo);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    /// A directory of its own under the temp directory, removed when the test ends.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!("lithic-gitwrite-{label}-{}-{unique}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("scratch directory");
            Scratch { root }
        }

        fn dir(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            std::fs::create_dir_all(&path).expect("scratch folder");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A Progress that belongs to no job, for calling the work functions directly.
    fn detached_progress() -> Progress {
        Progress { id: 0, cancel: Arc::new(AtomicBool::new(false)) }
    }

    /// Wait for a job to stop running, or give up. The work is on its own thread, so a test
    /// has to wait for it, and a bounded wait is what keeps a hang a failure rather than a
    /// stall.
    fn settle(id: u64) -> Value {
        for _ in 0..600 {
            let answer = job(&json!({ "id": id }));
            let payload: Value = serde_json::from_slice(&answer.body).expect("a JSON answer");
            if payload["result"]["state"] != json!("running") {
                return payload["result"].clone();
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("job {id} never settled");
    }

    #[test]
    fn a_job_answers_running_then_done_with_its_result() {
        let id = start("Thinking", |progress| {
            progress.say("Halfway");
            Ok(json!({ "answer": 42 }))
        });
        let settled = settle(id);
        assert_eq!(settled["state"], json!("done"));
        assert_eq!(settled["result"]["answer"], json!(42));
    }

    #[test]
    fn a_job_that_fails_carries_its_reason_and_no_result() {
        let id = start("Trying", |_| Err("the remote refused".to_string()));
        let settled = settle(id);
        assert_eq!(settled["state"], json!("failed"));
        assert_eq!(settled["error"], json!("the remote refused"));
        assert_eq!(settled["result"], json!(null));
    }

    #[test]
    fn a_cancelled_job_is_neither_a_success_nor_a_fault() {
        let id = start("Working", |progress| {
            while !progress.cancelled() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(CANCELLED.to_string())
        });
        let stopped = cancel(&json!({ "id": id }));
        let body: Value = serde_json::from_slice(&stopped.body).expect("a JSON answer");
        assert_eq!(body["result"]["stopped"], json!(true));
        let settled = settle(id);
        assert_eq!(settled["state"], json!("cancelled"));
        assert_eq!(settled["error"], json!(null));
    }

    #[test]
    fn an_unknown_job_is_an_answer_rather_than_an_error() {
        let answer = job(&json!({ "id": 999_999 }));
        let body: Value = serde_json::from_slice(&answer.body).expect("a JSON answer");
        assert_eq!(body["result"]["state"], json!("unknown"));
        let missing_id = job(&json!({}));
        let body: Value = serde_json::from_slice(&missing_id.body).expect("a JSON answer");
        assert_eq!(body["error"], json!("bad-args"));
    }

    #[test]
    fn the_managed_url_is_the_shape_self_host_and_the_app_both_write() {
        assert_eq!(managed_url("owner/name", " tok "), "https://oauth2:tok@github.com/owner/name.git");
        assert_eq!(
            url_credentials("https://oauth2:tok@github.com/owner/name.git"),
            Some(("oauth2".to_string(), "tok".to_string()))
        );
        assert_eq!(url_credentials("https://github.com/owner/name.git"), None);
    }

    #[test]
    fn a_folder_is_staged_committed_and_pushed_to_a_local_remote() {
        // The whole write path against a real repository, with no network: a bare repository
        // stands in for GitHub and a plain filesystem path is a git URL.
        let scratch = Scratch::new("round-trip");
        let bare = scratch.root.join("remote.git");
        Repository::init_bare(&bare).expect("bare remote");
        let work = scratch.dir("work");
        std::fs::write(work.join("notes.lith"), "hello, lith").expect("a Lith");

        let repo = init(&work).expect("init");
        ensure_identity(&repo);
        set_remote(&repo, bare.to_string_lossy().as_ref()).expect("remote");
        let progress = detached_progress();
        let staged = stage_working_tree(&repo, &progress).expect("stage");
        assert_eq!(staged.files, 1, "the one Lith was staged");
        assert!(!staged.over_cap && !staged.cancelled);
        assert!(commit_staged(&repo, "Lithic backup", true).expect("commit").is_some());
        push_main(&repo, bare.to_string_lossy().as_ref(), false, &progress.flag()).expect("push");

        // The remote really holds it, which is the only proof that matters: a push that
        // reported success without landing would be worse than one that failed.
        let landed = Repository::open(&bare).expect("open bare");
        let head = landed.find_reference("refs/heads/main").expect("main landed").peel_to_commit().expect("commit");
        let tree = head.tree().expect("tree");
        assert!(tree.get_path(Path::new("notes.lith")).is_ok(), "the Lith is in the remote's tree");
    }

    #[test]
    fn a_folder_over_the_cap_is_refused_with_its_number_and_nothing_staged() {
        let scratch = Scratch::new("cap");
        let work = scratch.dir("big");
        for index in 0..(FIRST_SYNC_FILE_CAP + 1) {
            std::fs::write(work.join(format!("file-{index}.txt")), "x").expect("a file");
        }
        let repo = init(&work).expect("init");
        let report = stage_working_tree(&repo, &detached_progress()).expect("stage");
        assert!(report.over_cap, "the cap was applied");
        assert_eq!(report.files, FIRST_SYNC_FILE_CAP + 1);
        // Nothing was hashed into the index, which is the point of counting first.
        assert!(repo.index().expect("index").is_empty());
    }

    #[test]
    fn a_nested_repository_is_skipped_rather_than_refused_by_the_index() {
        let scratch = Scratch::new("nested");
        let work = scratch.dir("home");
        std::fs::write(work.join("notes.lith"), "text").expect("a Lith");
        // A checkout of something else, which is what a real backup folder has in it: the
        // reported first connect was aimed at a `~/Documents` holding a clone of this very
        // project. libgit2 reports it as one entry with a trailing separator, and that entry
        // is the one `index.add_path` answers with `invalid path ... class=Index (10)`.
        let nested = work.join("GitHub").join("Lithic-UK");
        std::fs::create_dir_all(&nested).expect("nested folder");
        init(&nested).expect("nested repository");
        std::fs::write(nested.join("README.md"), "not this repository's business").expect("a file");

        let repo = init(&work).expect("init");
        let report = stage_working_tree(&repo, &detached_progress()).expect("the nested repository is not an error");
        assert_eq!(report.files, 1, "only the Lith is this folder's own content");
        assert!(!report.over_cap && !report.cancelled);
        let staged = repo.index().expect("index");
        assert!(staged.get_path(Path::new("notes.lith"), 0).is_some(), "the Lith was staged");
        assert_eq!(staged.len(), 1, "the nested repository was not staged, as a gitlink or otherwise");
    }

    #[test]
    fn a_folder_over_the_cap_is_refused_before_the_network_and_leaves_no_repository() {
        let scratch = Scratch::new("connect-cap");
        let folder = scratch.dir("home");
        for index in 0..(FIRST_SYNC_FILE_CAP + 1) {
            std::fs::write(folder.join(format!("file-{index}.txt")), "x").expect("a file");
        }
        // The remote is unreachable on purpose. A connect that reached the network first would
        // answer with a git error from the fetch or the push, so the cap's own sentence is the
        // proof that the folder was judged before anything was downloaded, written or pushed.
        let error = connect(
            &folder,
            "https://oauth2:token@example.invalid/owner/name.git",
            "owner/name",
            &detached_progress(),
        )
        .expect_err("refused");
        assert!(error.contains("Back up the folder your liths live in"), "{error}");
        assert!(error.contains(&(FIRST_SYNC_FILE_CAP + 1).to_string()), "{error}");
        // And the folder is left as it was found, which is the desktop app's rule: nothing
        // staged, nothing committed, and the repository this connect created removed again.
        assert!(!folder.join(".git").exists(), "a declined connect left a .git behind");
    }

    #[test]
    fn a_deleted_file_leaves_the_index_rather_than_persisting() {
        let scratch = Scratch::new("deleted");
        let work = scratch.dir("work");
        let file = work.join("gone.lith");
        std::fs::write(&file, "text").expect("a Lith");
        let repo = init(&work).expect("init");
        ensure_identity(&repo);
        stage_working_tree(&repo, &detached_progress()).expect("first stage");
        commit_staged(&repo, "one", true).expect("first commit");
        std::fs::remove_file(&file).expect("remove");
        let report = stage_working_tree(&repo, &detached_progress()).expect("second stage");
        assert_eq!(report.files, 1);
        let staged = repo.index().expect("index");
        assert!(staged.get_path(Path::new("gone.lith"), 0).is_none(), "the deletion was staged");
    }

    #[test]
    fn a_commit_that_changes_nothing_is_a_no_op() {
        let scratch = Scratch::new("empty");
        let work = scratch.dir("work");
        std::fs::write(work.join("notes.lith"), "text").expect("a Lith");
        let repo = init(&work).expect("init");
        ensure_identity(&repo);
        stage_working_tree(&repo, &detached_progress()).expect("stage");
        assert!(commit_staged(&repo, "one", true).expect("first").is_some());
        // The same tree again: nothing to commit, so nothing is committed.
        assert!(commit_staged(&repo, "two", false).expect("second").is_none());
    }

    #[test]
    fn a_disconnect_takes_the_managed_remote_and_records_the_folder_as_detached() {
        let scratch = Scratch::new("disconnect");
        let work = scratch.dir("work");
        let repo = init(&work).expect("init");
        set_remote(&repo, "https://oauth2:tok@github.com/owner/name.git").expect("remote");
        assert!(managed_remote_url(&work).is_some());

        let answer = disconnect(&json!({ "path": path_text(&work) }));
        let body: Value = serde_json::from_slice(&answer.body).expect("a JSON answer");
        assert_eq!(body["result"]["disconnected"], json!(true));
        assert!(managed_remote_url(&work).is_none(), "the marker is gone");
        let reopened = open(&work).expect("reopen");
        assert!(
            reopened.config().expect("config").get_bool(DETACHED_KEY).unwrap_or(false),
            "the folder is recorded as detached"
        );
    }

    #[test]
    fn a_disconnect_refuses_a_repository_lithic_did_not_configure() {
        let scratch = Scratch::new("disconnect-foreign");
        let work = scratch.dir("work");
        let repo = init(&work).expect("init");
        set_remote(&repo, "https://github.com/somebody/theirs.git").expect("remote");
        let answer = disconnect(&json!({ "path": path_text(&work) }));
        let body: Value = serde_json::from_slice(&answer.body).expect("a JSON answer");
        assert_eq!(body["error"], json!("git"));
        assert!(body["detail"].as_str().unwrap_or("").contains("not a Lithic-managed"));
        // And it left the person's own remote alone, which is the whole point.
        assert_eq!(
            open(&work).expect("reopen").find_remote("origin").expect("origin").url().expect("url"),
            "https://github.com/somebody/theirs.git"
        );
    }

    #[test]
    fn a_save_in_a_folder_lithic_does_not_manage_has_nothing_to_do() {
        let scratch = Scratch::new("unmanaged");
        let work = scratch.dir("work");
        std::fs::write(work.join("notes.lith"), "text").expect("a Lith");
        let answer = commit(&json!({ "path": path_text(&work.join("notes.lith")), "message": "x" }));
        let body: Value = serde_json::from_slice(&answer.body).expect("a JSON answer");
        assert_eq!(body["result"], json!({ "managed": false, "pushed": false, "error": null }));
    }

    #[test]
    fn setup_and_commit_refuse_arguments_that_name_nothing() {
        assert_eq!(body_error(setup(&json!({}))), json!("bad-args"));
        assert_eq!(body_error(setup(&json!({ "path": "/tmp/x", "repo": "  ", "token": "t" }))), json!("bad-args"));
        assert_eq!(body_error(setup(&json!({ "path": "/tmp/x", "repo": "o/n", "token": "  " }))), json!("bad-args"));
        assert_eq!(body_error(commit(&json!({}))), json!("bad-args"));
        assert_eq!(body_error(reauth(&json!({ "path": "/tmp/x" }))), json!("bad-args"));
        assert_eq!(body_error(disconnect(&json!({}))), json!("bad-args"));
    }

    fn body_error(response: Response) -> Value {
        let body: Value = serde_json::from_slice(&response.body).expect("a JSON answer");
        body["error"].clone()
    }
}
