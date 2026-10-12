//! In-process git for the GitHub sync, via the `git2` crate (libgit2).
//!
//! The sync used to shell out to the system `git` binary, which made the
//! desktop app depend on git being installed *and* on the PATH, a requirement
//! that stays invisible until it fails, that a "Git from Git Bash only" install
//! on Windows silently breaks, and that on Windows popped a console window for
//! every spawn (the status poll spawns git every ten seconds). libgit2 is
//! compiled into the binary instead, so there is nothing to install and nothing
//! to spawn.
//!
//! The on-disk format is unchanged, so a folder synced by real git keeps
//! working and stays readable by real git. Nothing here runs checkout filters
//! either: the caller writes rescued file bytes directly, so what the remote
//! holds is what lands on disk, byte for byte.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git2::{
    Cred, ErrorCode, FetchOptions, ObjectType, Oid, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, RepositoryOpenFlags, StatusOptions, TreeWalkMode, TreeWalkResult,
};

pub use crate::git_sync_contract::{
    FIRST_SYNC_FILE_CAP, MAIN, ORIGIN_FETCH_SPEC, PRE_REVERT_MESSAGE, REMOTE_MAIN,
};
use crate::shared_sync_core::{
    log as shared_log, revert_to as shared_revert_to, signature as shared_signature,
    stage_tracked_changes as shared_stage_tracked_changes,
};
pub use crate::shared_sync_core::{CommitRow, RevertReport};
use git2::Signature;

// --- Cancellation ----------------------------------------------------------
// One flag for the process, because only one first connect runs at a time (the
// modal drives it) and every stage has a different way to notice: the staging
// walk returns nonzero from its callback, and a fetch or push stops when its
// transfer callback returns false. Both are the only exits libgit2 offers mid
// operation, and without them a large folder cannot be called off at all.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Ask the running sync to stop at its next checkpoint.
pub fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

/// Clear the request, at the start of a new sync. A stale flag would cancel the
/// next connect before it began.
pub fn clear_cancel() {
    CANCELLED.store(false, Ordering::SeqCst);
}

pub fn cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst)
}

/// What one staging pass did. `files` is how many paths the walk reached, which
/// is the number the user needs to see when a folder turns out to be enormous.
pub struct StageReport {
    pub files: usize,
    /// The walk stopped because this folder holds more than the cap allows.
    pub over_cap: bool,
    /// The walk stopped because the user asked it to.
    pub cancelled: bool,
}

fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Open the repository at `dir`, without searching parent folders: the sync
/// only ever acts on the folder the user's file lives in, never on some
/// enclosing repository it happens to sit inside.
pub fn open(dir: &Path) -> Result<Repository, String> {
    Repository::open_ext(
        dir,
        RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .map_err(fail)
}

/// Create a repository whose initial branch is `main`.
///
/// Line endings are pinned off for repositories Lithic creates: the whole
/// point of this sync is that the bytes of a wiki document survive the round
/// trip, and `core.autocrlf` would rewrite them on the way into the object
/// database on Windows. Repositories the user created are never touched.
pub fn init(dir: &Path) -> Result<Repository, String> {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(dir, &options).map_err(fail)?;
    if let Ok(mut config) = repo.config() {
        let _ = config.set_bool("core.autocrlf", false);
    }
    Ok(repo)
}

/// Give the repository an identity to commit with, so a machine with no global
/// git configuration can still sync. Existing configuration always wins.
pub fn ensure_identity(repo: &Repository) {
    let Ok(mut config) = repo.config() else {
        return;
    };
    let has_name = config
        .get_string("user.name")
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        let _ = config.set_str("user.name", "Lithic");
        let _ = config.set_str("user.email", "lithic@local");
    }
}

/// The key that records a folder the user took out of sync by hand.
const DETACHED_KEY: &str = "lithic.detached";

/// Record that the user disconnected this folder.
pub fn mark_detached(repo: &Repository) {
    if let Ok(mut config) = repo.config() {
        let _ = config.set_bool(DETACHED_KEY, true);
    }
}

/// Clear it: a folder that has just been attached is not a detached one.
pub fn clear_detached(repo: &Repository) {
    if let Ok(mut config) = repo.config() {
        let _ = config.remove(DETACHED_KEY);
    }
}

/// Whether the user disconnected this folder, and has not re-attached it since.
pub fn is_detached(repo: &Repository) -> bool {
    repo.config()
        .ok()
        .and_then(|config| config.get_bool(DETACHED_KEY).ok())
        .unwrap_or(false)
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    shared_signature(repo)
}

/// URL configured for `name`, if that remote exists.
pub fn remote_url(repo: &Repository, name: &str) -> Option<String> {
    repo.find_remote(name)
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string))
}

/// Create or re-point `name`, adding the standard fetch refspec so a fetch
/// populates `refs/remotes/<name>/*` exactly like `git remote add` does.
pub fn set_remote(repo: &Repository, name: &str, url: &str) -> Result<(), String> {
    match repo.find_remote(name) {
        Ok(_) => repo.remote_set_url(name, url).map_err(fail)?,
        Err(_) => {
            repo.remote(name, url).map_err(fail)?;
        }
    }
    let has_spec = repo
        .find_remote(name)
        .ok()
        .and_then(|remote| remote.fetch_refspecs().ok())
        .map(|specs| {
            specs
                .iter()
                .any(|spec| spec.ok().flatten() == Some(ORIGIN_FETCH_SPEC))
        })
        .unwrap_or(false);
    if !has_spec {
        repo.remote_add_fetch(name, ORIGIN_FETCH_SPEC)
            .map_err(fail)?;
    }
    Ok(())
}

/// Remove a remote from the configuration.
pub fn remove_remote(repo: &Repository, name: &str) -> Result<(), String> {
    repo.remote_delete(name).map_err(fail)
}

fn url_credentials(url: &str) -> Option<(String, String)> {
    let rest = url.split_once("://")?.1;
    let (userinfo, _) = rest.split_once('@')?;
    let (user, password) = userinfo.split_once(':')?;
    Some((user.to_string(), password.to_string()))
}

fn callbacks(url: &str, rejected: Option<Arc<Mutex<Option<String>>>>) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let credentials = url_credentials(url);
    callbacks.credentials(move |_url, _username, _allowed| match &credentials {
        Some((user, password)) => Cred::userpass_plaintext(user, password),
        None => Cred::default(),
    });
    if let Some(slot) = rejected {
        callbacks.push_update_reference(move |refname, status| {
            if let Some(status) = status {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(format!("{} was rejected: {}", refname, status));
                }
            }
            Ok(())
        });
    }
    callbacks.transfer_progress(|_| !cancelled());
    callbacks
}

/// Fetch `main` into `refs/remotes/origin/main`. Returns `false` when there is
/// nothing to merge: a missing remote branch or an unreachable remote. Both
/// are normal during first connect, and the push that follows reports failures.
pub fn fetch_main(repo: &Repository, url: &str) -> Result<bool, String> {
    let mut remote = repo.find_remote("origin").map_err(fail)?;
    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(url, None));
    let refspec = format!("+{}:{}", MAIN, REMOTE_MAIN);
    match remote.fetch(&[refspec.as_str()], Some(&mut options), None) {
        Ok(()) => Ok(true),
        Err(error) => {
            eprintln!("git fetch skipped: {}", error);
            Ok(false)
        }
    }
}

/// Every blob path stored by `rev`, in traversal order.
pub fn files_at(repo: &Repository, rev: &str) -> Result<Vec<String>, String> {
    let commit = repo
        .find_reference(rev)
        .and_then(|reference| reference.peel_to_commit())
        .map_err(fail)?;
    let tree = commit.tree().map_err(fail)?;
    let mut files = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(ObjectType::Blob) {
            if let Ok(name) = entry.name() {
                files.push(format!("{}{}", root, name));
            }
        }
        TreeWalkResult::Ok
    })
    .map_err(fail)?;
    Ok(files)
}

/// The bytes of `path` as `rev` stores them, with no checkout filters applied.
pub fn bytes_at(repo: &Repository, rev: &str, path: &str) -> Result<Vec<u8>, String> {
    let tree = repo
        .find_reference(rev)
        .and_then(|reference| reference.peel_to_commit())
        .and_then(|commit| commit.tree())
        .map_err(fail)?;
    let entry = tree.get_path(Path::new(path)).map_err(fail)?;
    let blob = repo.find_blob(entry.id()).map_err(fail)?;
    Ok(blob.content().to_vec())
}

/// Whether the branch has a commit yet.
pub fn head_exists(repo: &Repository) -> bool {
    repo.head().ok().and_then(|head| head.target()).is_some()
}

/// Stage the working tree while reporting progress, refusing a folder over
/// `cap` files and stopping when the user asks.
pub fn stage_working_tree<F, C>(
    repo: &Repository,
    cap: Option<usize>,
    stopped: C,
    mut progress: F,
) -> Result<StageReport, String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(fail)?;
    let mut work: Vec<(PathBuf, bool)> = Vec::new();
    for entry in statuses.iter() {
        let Ok(path) = entry.path() else { continue };
        work.push((PathBuf::from(path), entry.status().is_wt_deleted()));
    }

    let total = work.len();
    if cap.is_some_and(|cap| total > cap) {
        return Ok(StageReport {
            files: total,
            over_cap: true,
            cancelled: false,
        });
    }

    let mut index = repo.index().map_err(fail)?;
    progress(0, total);
    let mut last_report = Instant::now();
    let mut done = 0usize;
    for (path, removed) in work {
        if stopped() {
            return Ok(StageReport {
                files: total,
                over_cap: false,
                cancelled: true,
            });
        }
        let staged = if removed {
            match index.remove_path(&path) {
                Err(error) if error.code() == ErrorCode::NotFound => Ok(()),
                outcome => outcome,
            }
        } else {
            index.add_path(&path)
        };
        staged.map_err(fail)?;
        done += 1;
        if last_report.elapsed() >= Duration::from_millis(400) {
            last_report = Instant::now();
            progress(done, total);
        }
    }
    index.write().map_err(fail)?;
    Ok(StageReport {
        files: total,
        over_cap: false,
        cancelled: false,
    })
}

/// Stage one path, for the save that commits a single file.
pub fn stage_path(repo: &Repository, path: &str) -> Result<(), String> {
    let mut index = repo.index().map_err(fail)?;
    index.add_path(Path::new(path)).map_err(fail)?;
    index.write().map_err(fail)
}

/// Commit the staged tree, returning `None` when it is unchanged.
pub fn commit(repo: &Repository, message: &str, allow_empty: bool) -> Result<Option<Oid>, String> {
    let mut index = repo.index().map_err(fail)?;
    let tree_id = index.write_tree().map_err(fail)?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if !allow_empty
        && parent
            .as_ref()
            .is_some_and(|commit| commit.tree_id() == tree_id)
    {
        return Ok(None);
    }
    let tree = repo.find_tree(tree_id).map_err(fail)?;
    let signature = signature(repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(fail)?;
    Ok(Some(oid))
}

/// Record the upstream the way `git push -u` does.
pub fn set_upstream(repo: &Repository, name: &str, branch: &str) {
    if let Ok(mut config) = repo.config() {
        let _ = config.set_str(&format!("branch.{}.remote", branch), name);
        let _ = config.set_str(
            &format!("branch.{}.merge", branch),
            &format!("refs/heads/{}", branch),
        );
    }
}

/// Publish `main`, force-rewriting the remote branch when asked: the folder is
/// the source of truth, so the union push is expected to replace what GitHub
/// has. Also refreshes the remote-tracking ref, which is what `git push` does
/// and what the next merge reads.
pub fn push_main(repo: &Repository, url: &str, force: bool) -> Result<(), String> {
    let mut remote = repo.find_remote("origin").map_err(fail)?;
    let rejected = Arc::new(Mutex::new(None));
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks(url, Some(Arc::clone(&rejected))));
    let refspec = if force {
        format!("+{}:{}", MAIN, MAIN)
    } else {
        format!("{}:{}", MAIN, MAIN)
    };
    remote
        .push(&[refspec.as_str()], Some(&mut options))
        .map_err(fail)?;
    if let Some(message) = rejected.lock().ok().and_then(|slot| slot.clone()) {
        return Err(message);
    }
    if let Ok(oid) = repo.refname_to_id(MAIN) {
        let _ = repo.reference(REMOTE_MAIN, oid, true, "lithic: synced");
    }
    Ok(())
}

/// Shared history reader; orchestration and wire serialization remain local.
pub fn log(repo: &Repository, limit: usize) -> Result<Vec<CommitRow>, String> {
    shared_log(repo, limit)
}

/// Shared tracked staging, kept behind this crate's gitcore surface.
pub fn stage_tracked_changes(repo: &Repository) -> Result<usize, String> {
    shared_stage_tracked_changes(repo)
}

/// Shared tree restoration, kept behind this crate's gitcore surface.
pub fn revert_to(repo: &Repository, target: &str) -> Result<RevertReport, String> {
    shared_revert_to(repo, target)
}
