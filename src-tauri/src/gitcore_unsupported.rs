//! The GitHub sync's git half on a platform that has no git in it.
//!
//! `gitcore.rs` beside this file is the desktop answer: libgit2, linked into the
//! binary, so the sync has nothing to install and nothing to spawn. Android gets
//! neither it nor libgit2, because `git2`'s `https` feature asks for OpenSSL on every
//! unix and carrying it would mean cross-compiling OpenSSL once per phone ABI (see the
//! `android` table in `Cargo.toml`). What the sync does has no meaning there anyway: a
//! phone has no `Documents\Lithic` to keep a repository in and no folder picker that
//! reaches one, so the answer is the one the published PWA already gives.
//!
//! This module is that answer as a drop-in. It has the same public surface `gitcore`
//! has, so `lib.rs` compiles unchanged and every question about a folder — a save's
//! commit, the launcher's coverage check, the recents rebuild — is answered by the side
//! that knows. Two rules keep it honest:
//!
//! **The way in refuses.** `open` and `init` are the only two calls that can produce a
//! repository, and both answer `UNAVAILABLE`. Everything else takes a `Repository`, and
//! `Repository` here is an *uninhabited* type, so there is nothing to pass them: no
//! caller can even reach a commit, a push or a staged path on this platform. That is
//! the point rather than a limitation — the refusal is a fact about the build, and the
//! type says it where the compiler can enforce it.
//!
//! **A read says nothing is there.** With no repository, `is_managed_dir` answers false
//! for every folder, no recents row is ever drawn as backed up, and no folder is ever
//! reported as attached. Nothing is offered that cannot be delivered.
//!
//! Compiled for Android and for the test build on every platform, never for a desktop
//! release. That is deliberate and it is the same reasoning as the Linux and macOS
//! answers in `platform`, which are compiled on Windows so the local gate can lint
//! them: a module only Android compiles is a module `cargo check`, `clippy` and
//! `cargo test` on the developer's machine never look at, and the test at the bottom of
//! this file is what makes "compiled for the test build" worth the `cfg`.

// Nothing in here can be constructed on the platform it serves, which is the module's
// whole subject: `StageReport` is named in a signature that always refuses, so rustc
// sees a struct that is never built. Same situation and same answer as the
// `#![cfg_attr(windows, allow(dead_code))]` in `platform/linux.rs`, which is unused on
// one of the platforms it is compiled for by design.
#![allow(dead_code)]

use std::path::Path;

/// What every command that cannot run here answers with.
///
/// A sentence of its own rather than the failure of any folder or network: this is the
/// build not having the feature, and a user told which one it is stops trying.
pub const UNAVAILABLE: &str = "GitHub sync is not built into this version of Lithic";

/// A repository handle on a target that cannot have one.
///
/// Empty, and not a placeholder struct: an uninhabited type cannot be built, so no
/// caller can hold a repository this module did not hand it and nothing later can treat
/// one as real. It is here because `lib.rs` compiles against the signatures that name
/// it, which is the whole of what a drop-in surface has to provide.
#[derive(Debug)]
pub enum Repository {}

/// A commit id on a target that cannot make one. Uninhabited for the same reason.
#[derive(Debug)]
pub enum Oid {}

/// How many files one first connect may stage. Kept because `lib.rs` names it, and the
/// number is a fact about the sync rather than about the platform that cannot run it.
pub const FIRST_SYNC_FILE_CAP: usize = 2000;

/// The branch the sync publishes, on both sides.
pub const MAIN: &str = "refs/heads/main";
/// The remote-tracking ref a first connect's merge reads.
pub const REMOTE_MAIN: &str = "refs/remotes/origin/main";

/// What one staging pass did. Never built here, and named because `lib.rs` reads its
/// fields back from a call that refuses.
pub struct StageReport {
    pub files: usize,
    pub over_cap: bool,
    pub cancelled: bool,
}

// --- Cancellation -----------------------------------------------------------
// The real flag belongs to a running sync, and nothing runs here, so the answers are
// the empty ones. `cancelled` returning false is not a stub: it is true.

/// There is nothing running to stop.
pub fn cancel() {}

/// Nothing was ever asked to stop, so there is nothing to clear.
pub fn clear_cancel() {}

/// Nothing is running, so nothing is cancelled.
pub fn cancelled() -> bool {
    false
}

// --- The way in -------------------------------------------------------------
// The two doors, and the whole of what a caller on this platform can reach.

/// Refused: there is no git here.
pub fn open(_dir: &Path) -> Result<Repository, String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused for the same reason, rather than creating a repository this build could not
/// then commit into.
pub fn init(_dir: &Path) -> Result<Repository, String> {
    Err(UNAVAILABLE.to_string())
}

// --- Everything a repository would be needed for ----------------------------
// Unreachable by construction, because `Repository` is uninhabited. Kept so the surface
// matches `gitcore`'s exactly and nobody has to know which platform they are reading.

/// A no-op, and unreachable.
pub fn ensure_identity(_repo: &Repository) {}

/// A no-op, and unreachable.
pub fn mark_detached(_repo: &Repository) {}

/// A no-op, and unreachable.
pub fn clear_detached(_repo: &Repository) {}

/// Nothing is detached here, because nothing is attached.
pub fn is_detached(_repo: &Repository) -> bool {
    false
}

/// No folder has a remote, because no folder has a repository.
pub fn remote_url(_repo: &Repository, _name: &str) -> Option<String> {
    None
}

/// Refused.
pub fn set_remote(_repo: &Repository, _name: &str, _url: &str) -> Result<(), String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused.
pub fn remove_remote(_repo: &Repository, _name: &str) -> Result<(), String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused, and it is the honest answer rather than an empty one: "nothing to merge" is
/// what the desktop returns for a remote that is not there, and this target cannot tell
/// the difference.
pub fn fetch_main(_repo: &Repository, _url: &str) -> Result<bool, String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused.
pub fn files_at(_repo: &Repository, _rev: &str) -> Result<Vec<String>, String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused.
pub fn bytes_at(_repo: &Repository, _rev: &str, _path: &str) -> Result<Vec<u8>, String> {
    Err(UNAVAILABLE.to_string())
}

/// No branch, because no repository.
pub fn head_exists(_repo: &Repository) -> bool {
    false
}

/// Refused, keeping `gitcore`'s generics so a caller's closure types still infer.
pub fn stage_working_tree<F, C>(
    _repo: &Repository,
    _cap: Option<usize>,
    _stopped: C,
    _progress: F,
) -> Result<StageReport, String>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    Err(UNAVAILABLE.to_string())
}

/// Refused: a staged path is the first half of a commit this build cannot make.
pub fn stage_path(_repo: &Repository, _path: &str) -> Result<(), String> {
    Err(UNAVAILABLE.to_string())
}

/// Refused. Nothing here reports a backup it did not make.
pub fn commit(_repo: &Repository, _message: &str, _allow_empty: bool) -> Result<Option<Oid>, String> {
    Err(UNAVAILABLE.to_string())
}

/// A no-op, and unreachable.
pub fn set_upstream(_repo: &Repository, _name: &str, _branch: &str) {}

/// Refused.
pub fn push_main(_repo: &Repository, _url: &str, _force: bool) -> Result<(), String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only two calls this platform can reach, and what they say.
    ///
    /// Everything else here takes a `Repository`, which is uninhabited, so no test can
    /// call one and no caller on this platform can either: this is the whole of the
    /// reachable surface, which is the property worth pinning.
    #[test]
    fn the_way_in_refuses_with_the_sentence_the_launcher_shows() {
        let dir = std::env::temp_dir();
        assert_eq!(open(&dir).unwrap_err(), UNAVAILABLE);
        assert_eq!(init(&dir).unwrap_err(), UNAVAILABLE);
    }

    /// Nothing is running, so a cancel is a no-op rather than a flag left set. A
    /// cancellation that outlived the thing it was aimed at would go on to abort the
    /// next sync, which is the failure the desktop's own `clear_cancel` exists for.
    #[test]
    fn a_cancel_leaves_nothing_set() {
        cancel();
        assert!(!cancelled(), "a cancel with nothing to stop must not stay set");
        clear_cancel();
        assert!(!cancelled());
    }
}
