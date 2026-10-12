//! Git and filesystem operations shared by the desktop app and the shim.
//!
//! The callers deliberately keep their own orchestration: progress, cancellation, first-connect
//! policy, error presentation, and wire responses differ. The local operations below do not, so
//! each crate includes this source module rather than carrying a hand-maintained second copy.

use std::fs;
use std::path::Path;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

use crate::git_sync_contract;

pub const IGNORE_FILE_NAME: &str = ".gitignore";
#[cfg(not(target_os = "android"))]
use git2::build::CheckoutBuilder;
#[cfg(not(target_os = "android"))]
use git2::{ErrorCode, Oid, Repository, Signature, StatusOptions};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedRemote {
    pub owner: String,
    pub name: String,
    pub token: String,
}

impl ManagedRemote {
    pub fn repo(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

#[cfg(not(target_os = "android"))]
#[derive(Clone, Debug, serde::Serialize)]
pub struct CommitRow {
    pub hash: String,
    pub short: String,
    pub summary: String,
    pub time: i64,
}

#[cfg(not(target_os = "android"))]
#[derive(Clone, Debug, serde::Serialize)]
pub struct RevertReport {
    pub short: String,
    pub target: String,
    pub changes: usize,
}

/// Build the managed remote shape used by the app, shim, and self-host CGI.
pub fn managed_url(repo: &str, token: &str) -> String {
    format!(
        "https://{}{}@github.com/{}.git",
        git_sync_contract::MANAGED_MARKER,
        token.trim(),
        repo.trim()
    )
}

/// Parse the managed remote shape, accepting the legacy missing-suffix and trailing-slash forms.
pub fn parse_managed_remote(url: &str) -> Option<ManagedRemote> {
    let (userinfo, host_and_path) = url.split_once("://")?.1.split_once('@')?;
    let token = userinfo
        .strip_prefix(git_sync_contract::MANAGED_MARKER)?
        .trim();
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

/// The subject every prong uses for the commit that restores an earlier tree.
pub fn revert_message(short: &str) -> String {
    format!("{}{}", git_sync_contract::REVERT_MESSAGE_PREFIX, short)
}

/// The seven characters git itself prints for an object id.
#[cfg(not(target_os = "android"))]
pub fn short_of(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// The newest commits on HEAD, in the one JSON shape both prongs expose.
#[cfg(not(target_os = "android"))]
pub fn log(repo: &Repository, limit: usize) -> Result<Vec<CommitRow>, String> {
    if repo.head().ok().and_then(|head| head.target()).is_none() {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk().map_err(fail)?;
    walk.set_sorting(git2::Sort::TIME).map_err(fail)?;
    walk.push_head().map_err(fail)?;
    let mut rows = Vec::new();
    for oid in walk {
        if rows.len() >= limit {
            break;
        }
        let oid = oid.map_err(fail)?;
        let commit = repo.find_commit(oid).map_err(fail)?;
        rows.push(CommitRow {
            hash: oid.to_string(),
            short: short_of(oid),
            summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(rows)
}

/// Stage tracked modifications and deletions, leaving untracked and ignored files alone.
#[cfg(not(target_os = "android"))]
pub fn stage_tracked_changes(repo: &Repository) -> Result<usize, String> {
    let mut options = StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(fail)?;
    let mut work: Vec<(PathBuf, bool)> = Vec::new();
    for entry in statuses.iter() {
        let Ok(path) = entry.path() else { continue };
        work.push((PathBuf::from(path), entry.status().is_wt_deleted()));
    }
    let mut index = repo.index().map_err(fail)?;
    for (path, removed) in &work {
        let staged = if *removed {
            match index.remove_path(path) {
                Err(error) if error.code() == ErrorCode::NotFound => Ok(()),
                outcome => outcome,
            }
        } else {
            index.add_path(path)
        };
        staged.map_err(fail)?;
    }
    index.write().map_err(fail)?;
    Ok(work.len())
}

/// Restore the target tree as a new commit, preserving intervening history and untracked files.
#[cfg(not(target_os = "android"))]
pub fn revert_to(repo: &Repository, target: &str) -> Result<RevertReport, String> {
    let target_oid = repo
        .revparse_single(target)
        .and_then(|object| object.peel_to_commit())
        .map_err(fail)?
        .id();
    let target_commit = repo.find_commit(target_oid).map_err(fail)?;
    let head = repo.head().map_err(fail)?.peel_to_commit().map_err(fail)?;
    let tree = target_commit.tree().map_err(fail)?;
    let changes = head
        .tree()
        .ok()
        .and_then(|from| repo.diff_tree_to_tree(Some(&from), Some(&tree), None).ok())
        .map(|diff| diff.deltas().len())
        .unwrap_or(0);

    let mut index = repo.index().map_err(fail)?;
    index.read_tree(&tree).map_err(fail)?;
    index.write().map_err(fail)?;
    let mut checkout = CheckoutBuilder::new();
    checkout.force().remove_untracked(false);
    repo.checkout_index(Some(&mut index), Some(&mut checkout))
        .map_err(fail)?;

    let signature = signature(repo)?;
    let short_target = short_of(target_oid);
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            &revert_message(&short_target),
            &tree,
            &[&head],
        )
        .map_err(fail)?;
    Ok(RevertReport {
        short: short_of(oid),
        target: short_target,
        changes,
    })
}

/// Add the installed executable's bare name to the destination's .gitignore, best-effort.
pub fn ignore_installed_copy(dir: &Path, name: &str) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(IGNORE_FILE_NAME);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == name) {
        return;
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(name);
    text.push('\n');
    let _ = fs::write(&path, text);
}

#[cfg(not(target_os = "android"))]
pub fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("Lithic", "lithic@local"))
        .map_err(fail)
}

#[cfg(not(target_os = "android"))]
fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "lithic-shared-sync-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create scratch directory");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn commit_index(repo: &Repository, message: &str) {
        let mut index = repo.index().expect("index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let signature = signature(repo).expect("signature");
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )
        .expect("commit staged tree");
    }

    fn commit_file(repo: &Repository, path: &str, text: &str, message: &str) -> Oid {
        fs::write(repo.workdir().expect("workdir").join(path), text).expect("write tracked file");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new(path)).expect("stage file");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let signature = signature(repo).expect("signature");
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .expect("commit")
    }

    #[test]
    fn managed_remote_build_and_parse_share_one_shape() {
        let url = managed_url(" owner/name ", " token ");
        assert_eq!(url, "https://oauth2:token@github.com/owner/name.git");
        let parsed = parse_managed_remote(&url).expect("managed URL");
        assert_eq!(parsed.repo(), "owner/name");
        assert_eq!(parsed.token, "token");
        assert_eq!(
            parse_managed_remote("https://github.com/owner/name.git"),
            None
        );
        assert_eq!(
            parse_managed_remote("https://oauth2:@github.com/owner/name.git"),
            None
        );
        assert_eq!(
            parse_managed_remote("https://oauth2:token@github.com/owner/name/deeper.git"),
            None
        );
    }

    #[test]
    fn installed_copy_ignore_is_idempotent_and_preserves_existing_text() {
        let scratch = Scratch::new("ignore");
        let ignore = scratch.0.join(".gitignore");
        fs::write(&ignore, "# keep this").expect("seed ignore");
        ignore_installed_copy(&scratch.0, "Lithic.exe");
        ignore_installed_copy(&scratch.0, "Lithic.exe");
        let text = fs::read_to_string(ignore).expect("read ignore");
        assert_eq!(text, "# keep this\nLithic.exe\n");
        assert_eq!(text.lines().filter(|line| *line == "Lithic.exe").count(), 1);
    }

    #[test]
    fn history_staging_and_revert_share_the_same_git_behavior() {
        let scratch = Scratch::new("history");
        let repo = Repository::init(&scratch.0).expect("init repository");
        commit_file(&repo, "one.lith", "first", "first");
        let target = commit_file(&repo, "two.lith", "second", "second");

        fs::write(scratch.0.join("one.lith"), "changed").expect("modify tracked file");
        fs::remove_file(scratch.0.join("two.lith")).expect("delete tracked file");
        fs::write(scratch.0.join("untracked.txt"), "keep").expect("write untracked file");
        assert_eq!(
            stage_tracked_changes(&repo).expect("stage tracked changes"),
            2
        );
        commit_index(&repo, "pending tracked work");

        let report = revert_to(&repo, &target.to_string()).expect("revert to earlier commit");
        assert_eq!(report.target, short_of(target));
        assert_eq!(report.changes, 2);
        assert_eq!(
            fs::read_to_string(scratch.0.join("one.lith")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(scratch.0.join("two.lith")).unwrap(),
            "second"
        );
        assert_eq!(
            fs::read_to_string(scratch.0.join("untracked.txt")).unwrap(),
            "keep"
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let expected_message = revert_message(&short_of(target));
        assert_eq!(head.message().ok(), Some(expected_message.as_str()));
        let rows = log(&repo, 10).expect("history");
        assert!(rows.iter().any(|row| row.hash == head.id().to_string()));
        assert!(rows.iter().any(|row| row.hash == target.to_string()));
    }
}

#[cfg(test)]
mod remote_parse_tests {
    use super::*;

    #[test]
    fn accepts_legacy_remote_suffix_forms() {
        for url in [
            "https://oauth2:token@github.com/owner/name",
            "https://oauth2:token@github.com/owner/name/",
            "https://oauth2:token@github.com/owner/name.git/",
        ] {
            let remote = parse_managed_remote(url).expect("legacy URL parses");
            assert_eq!(remote.repo(), "owner/name");
            assert_eq!(remote.token, "token");
        }
    }
}
