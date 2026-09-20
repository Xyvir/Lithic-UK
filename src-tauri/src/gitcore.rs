//! In-process git for the GitHub sync, via the `git2` crate (libgit2).
//!
//! The sync used to shell out to the system `git` binary, which made the
//! desktop app depend on git being installed *and* on the PATH — a requirement
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

use std::path::Path;
use std::sync::{Arc, Mutex};

use git2::{
    Cred, FetchOptions, IndexAddOption, ObjectType, Oid, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, RepositoryOpenFlags, Signature, TreeWalkMode, TreeWalkResult,
};

/// The branch the sync publishes, on both sides.
pub const MAIN: &str = "refs/heads/main";
/// The remote-tracking ref the first-connect merge reads.
pub const REMOTE_MAIN: &str = "refs/remotes/origin/main";
/// The fetch refspec `git remote add` writes, kept so a user running git by
/// hand in the folder gets the same remote-tracking refs they'd expect.
const ORIGIN_FETCH_SPEC: &str = "+refs/heads/*:refs/remotes/origin/*";

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

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("Lithic", "lithic@local"))
        .map_err(fail)
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
        repo.remote_add_fetch(name, ORIGIN_FETCH_SPEC).map_err(fail)?;
    }
    Ok(())
}

/// Remove a remote from the configuration. Fails when it doesn't exist, which
/// the callers treat as "nothing to remove".
pub fn remove_remote(repo: &Repository, name: &str) -> Result<(), String> {
    repo.remote_delete(name).map_err(fail)
}

/// Credentials embedded in the remote URL. Lithic stores the token there (the
/// same `https://oauth2:<token>@github.com/...` shape the self-host CGI uses),
/// so libgit2 normally has them already; these are the fallback for when it
/// asks a callback instead of reading the URL.
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
        // libgit2 reports a per-ref rejection here rather than as an error, so
        // without this a refused push (protected branch, stale token) would
        // look like success and the user would believe a save had been backed up.
        callbacks.push_update_reference(move |refname, status| {
            if let Some(status) = status {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(format!("{} was rejected: {}", refname, status));
                }
            }
            Ok(())
        });
    }
    callbacks
}

/// Fetch `main` into `refs/remotes/origin/main`. Returns `false` when there is
/// nothing to merge — a repository with no `main` yet, or a remote that can't
/// be reached. Both are normal on a first connect, and the push that follows
/// surfaces a genuinely broken remote with a real error.
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

/// Every file path in `rev`, in tree order — the same order
/// `git ls-tree -r --name-only` prints, so the report the modal shows is
/// unchanged from the shelled-out version.
pub fn files_at(repo: &Repository, rev: &str) -> Result<Vec<String>, String> {
    let tree = repo
        .find_reference(rev)
        .and_then(|reference| reference.peel_to_commit())
        .and_then(|commit| commit.tree())
        .map_err(fail)?;
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

/// Stage every change in the working tree, honouring `.gitignore` — the
/// equivalent of `git add .` from the repository root.
pub fn stage_all(repo: &Repository) -> Result<(), String> {
    let mut index = repo.index().map_err(fail)?;
    index
        .add_all(std::iter::empty::<&str>(), IndexAddOption::DEFAULT, None)
        .map_err(fail)?;
    index.write().map_err(fail)
}

/// Stage one path, for the save that commits a single file.
pub fn stage_path(repo: &Repository, path: &str) -> Result<(), String> {
    let mut index = repo.index().map_err(fail)?;
    index.add_path(Path::new(path)).map_err(fail)?;
    index.write().map_err(fail)
}

/// Commit the staged tree to `main`, returning the new id, or `None` when the
/// tree is identical to the parent's and `allow_empty` is false. That `None` is
/// the in-process equivalent of git's "nothing to commit", which the sync has
/// always treated as a no-op — saves that change nothing must not pile up empty
/// commits in the user's repository.
pub fn commit(repo: &Repository, message: &str, allow_empty: bool) -> Result<Option<Oid>, String> {
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

/// Record the upstream the way `git push -u` does, so the folder behaves for a
/// user who runs git by hand in it afterwards.
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
    remote.push(&[refspec.as_str()], Some(&mut options)).map_err(fail)?;
    if let Some(message) = rejected.lock().ok().and_then(|slot| slot.clone()) {
        return Err(message);
    }
    if let Ok(oid) = repo.refname_to_id(MAIN) {
        let _ = repo.reference(REMOTE_MAIN, oid, true, "lithic: synced");
    }
    Ok(())
}
