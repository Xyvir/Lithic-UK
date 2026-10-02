//! The folder a backup acts on, and where the person's own pick at it is remembered.
//!
//! The desktop app keeps this in `recents.txt` beside its executable: a `sync-folder=` line in
//! the same sidecar that holds the recents and the install-offer marker, spelled relative to the
//! bundle where it can be. A shim has no sidecar and no bundle to spell against, so the
//! equivalent is one line in a file of its own under the shim's data directory
//! (`app_data_dir()`), and the path is stored exactly as the person picked it. The file is
//! deliberately *only* the pick: the shim has no recents list or install offer to carry along,
//! so there is nothing a rewrite could disturb.
//!
//! Why the pick has to be recorded at all rather than passed with every connect. The question
//! `git-folder` answers is asked before anything is connected, and the answer is what the dialog
//! shows on every launch after the first. The desktop app learned this the expensive way: a
//! folder Lithic worked out for itself is right until it is not, and until now moving a backup
//! meant disconnecting first. A recorded pick is that answer, and no `derived` path can outrank
//! it.
//!
//! The resolution order is the desktop app's:
//!
//!   1. the recorded pick, when it is still a directory on this machine;
//!   2. the folder behind the `derived` path, when a repository Lithic manages already covers
//!      it (the Lith the person is looking at is the one they mean);
//!   3. the folder the `derived` path names, which is where the open Lith lives and therefore
//!      the one a first connect should act on;
//!   4. `Documents/Lithic`, when the launcher named nothing that is on this machine.
//!
//! Rule four is the desktop app's proposal (`proposed_sync_folder`), and it is the same folder
//! for the same reason: `Documents/Lithic` is where this program puts itself (`install.rs`) and
//! where its liths are meant to live, so a machine that has never synced is told where its
//! backup is about to land instead of being asked to invent a folder. It is a proposal and not
//! a promise, which is why the folder usually does not exist yet and why `connect_dir` makes it
//! at the connect rather than the dialog doing it for being opened: nothing is written until
//! the person asks for a repository. It also answers for a derived path that is not here at
//! all - a recents row naming a Lith that has since been deleted, or one on a drive that is not
//! plugged in - because rules two and three read a filesystem that has nothing there, and a row
//! is not a subject: naming the derived folder would put something the person cannot act on in
//! front of them, which is the state rule four exists to end.
//!
//! What is missing on purpose: the desktop app's *library folders*, the folders a previous
//! attachment left a repository in. A shim has no recents list beside an executable and no
//! installation whose neighbours it can read, so the derived path is the only evidence of where
//! the person works and rule four is the only thing the shim can add to it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::command::{choose_folder, failed, ok, path_text};
use crate::git::{managed_root_for, sync_dir_of};
use crate::install::install_dir;
use crate::{app_data_dir, Response};

/// The file, under the shim's data directory, whose single line is the picked folder.
const PICK_FILE: &str = "sync-folder";

/// Where the pick is recorded, or nothing when the platform gives the shim no data home.
fn pick_file() -> Option<PathBuf> {
    Some(app_data_dir()?.join(PICK_FILE))
}

/// The picked folder, when it is still a directory on this machine.
///
/// The existence check is the whole point: a pick on a drive that is not plugged in hands the
/// dialog back to the automatic rules rather than naming a path that is not there, which is the
/// same rule the desktop app's `chosen_sync_folder_in` applies.
pub(crate) fn recorded() -> Option<PathBuf> {
    let text = fs::read_to_string(pick_file()?).ok()?;
    let value = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let dir = PathBuf::from(value);
    dir.is_dir().then_some(dir)
}

/// Forget the recorded pick, for a disconnect.
///
/// The pick was made for the backup that just ended, and the dialog offers the picker only
/// while setting one up, so a folder recorded for a backup that is gone is a choice nobody can
/// see or undo. Best-effort at the call site, because failing to rewrite a preference must not
/// read as a failed disconnect (the desktop app's own rule for the same line).
pub(crate) fn clear_pick() -> Result<(), String> {
    record(None)
}

/// Record or clear the pick. Clearing a pick that was never recorded is a success.
fn record(picked: Option<&Path>) -> Result<(), String> {
    let Some(file) = pick_file() else {
        return Err("the shim has no data directory".to_string());
    };
    match picked {
        Some(dir) => {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&file, format!("{}\n", path_text(dir))).map_err(|error| error.to_string())
        }
        None => match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

/// The folder the shim proposes when the launcher has nothing of its own: `Documents/Lithic`,
/// the same folder the app installs itself into (see the module note).
///
/// `None` on a machine with no Documents folder, no data home and no home directory to join,
/// which is the only case where the dialog asks rather than proposing. The desktop app's
/// `proposed_sync_folder` answers the same way and for the same reason.
pub(crate) fn proposed() -> Option<PathBuf> {
    install_dir()
}

/// The folder a connect acts on: the path the launcher named, made first when it is the
/// folder the shim proposed and it is not on disk yet.
///
/// `sync_dir_of` must not be asked about that folder, which is the whole reason this function
/// exists: it answers the folder *holding* a path that is not a directory, so a
/// `Documents/Lithic` this machine has never made would resolve to `Documents` and a first
/// connect would commit the person's entire documents folder. The desktop app's `connect_dir`
/// is the same function for the same reason. Nothing is made for any other missing path: a
/// recents row naming a folder that is gone must not turn that name into a new folder.
pub(crate) fn connect_dir(given: &Path, proposal: Option<&Path>) -> Option<PathBuf> {
    if given.is_dir() {
        return Some(given.to_path_buf());
    }
    if proposal.is_some_and(|dir| dir == given) {
        return fs::create_dir_all(given).ok().map(|()| given.to_path_buf());
    }
    sync_dir_of(given).filter(|dir| dir.is_dir())
}

/// `git-folder { derived? }`
///
/// The folder the backup acts on, and whether that folder is the person's own pick. Two fields
/// rather than one for the desktop app's reason: the dialog names the folder it is about to act
/// on, and it also has to know whether offering to go back to the automatic one makes sense, and
/// the only case where it does is a recorded pick.
///
/// The proposal is drawn where the launcher had nothing of its own: no `derived` at all, or one
/// naming a path that is not on this machine. A Lith the person is actually working in still
/// decides the folder on its own, which is the point of the condition, and it is the same rule
/// the desktop app makes in `answer_folder`.
///
/// The existence test is what separates a subject from a row. A `derived` path is the open Lith
/// or the newest recents row, and only the first of those is guaranteed to be here; a row
/// outlives the file it names, and a folder is not evidence that the Lith inside it still is.
/// Answering with such a path would leave the dialog naming a folder nothing can act on and the
/// connect failing on `sync_dir_of` after the fact, so the proposal answers instead.
pub(crate) fn folder(args: &Value) -> Response {
    let derived = derived_arg(args);
    let chosen = recorded();
    let folder = match &chosen {
        Some(dir) => Some(dir.clone()),
        None => match derived.as_deref().filter(|path| path.exists()) {
            Some(derived) => cover_or_folder(derived).or_else(proposed),
            None => proposed(),
        },
    };
    ok(json!({
        "folder": folder.map(|dir| path_text(&dir)),
        "overridden": chosen.is_some(),
    }))
}

/// `pick-folder { current? }`
///
/// Ask the desktop's own chooser for a folder, record what it answers and hand it back. Asking
/// where the dialog already points, so changing the folder is a step from the answer on screen
/// rather than from wherever the desktop last happened to be; the fallbacks are for a caller
/// that names nothing.
///
/// A cancelled pick is `{ folder: null }` rather than a failure, because the person pressing
/// Escape is an ordinary answer. `no-picker` is the machine having no chooser at all, which the
/// launcher shows as a line under the folder rather than retrying.
pub(crate) fn pick(args: &Value) -> Response {
    let current = args
        .get("current")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let start = current
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(recorded);
    match choose_folder(start.as_deref().map(path_text).as_deref()) {
        Ok(Some(picked)) => {
            let dir = PathBuf::from(&picked);
            if !dir.is_dir() {
                return failed("not-a-directory");
            }
            if record(Some(&dir)).is_err() {
                return failed("io");
            }
            ok(json!({ "folder": picked }))
        }
        Ok(None) => ok(json!({ "folder": null })),
        Err(code) => failed(code),
    }
}

/// `clear-folder-pick`
///
/// Go back to the folder the shim works out for itself. Nothing else rides in the file, so this
/// is a delete rather than a rewrite, and the next `git-folder` answers with the automatic one.
pub(crate) fn clear() -> Response {
    match record(None) {
        Ok(()) => ok(json!({})),
        Err(_) => failed("io"),
    }
}

/// The `derived` argument, trimmed and refused when empty. An empty string is a launcher with
/// nothing to name, not a folder called nothing.
fn derived_arg(args: &Value) -> Option<PathBuf> {
    let raw = args.get("derived").and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

/// Rule two and three of the resolution: the managed repository above the derived path when one
/// covers it, else the folder the derived path names.
///
/// A folder that is not there is not a folder to name, so the walk and the fallback both check
/// the filesystem. This is the divergence the desktop app allows itself (its library-folder rule
/// can name a folder the launcher never mentioned) and the shim cannot: with no installation to
/// ask, the derived path is the only evidence there is.
fn cover_or_folder(derived: &Path) -> Option<PathBuf> {
    let dir = sync_dir_of(derived)?;
    if let Some(root) = managed_root_for(&dir) {
        return Some(root);
    }
    dir.is_dir().then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::handle;
    use crate::{parse_request, COMMAND_PATH, DEFAULT_PORT, TOKEN_HEADER};
    use std::sync::atomic::AtomicU32;

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const MANAGED_URL: &str = "https://oauth2:ghp_example@github.com/owner/name.git";

    /// The same request a real launcher page makes, so the tests read the wire rather than the
    /// functions behind it, exactly as the other modules' tests do.
    fn ask(body: &str) -> Value {
        let head = format!(
            "POST {COMMAND_PATH} HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\n\
             Sec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\n\
             {TOKEN_HEADER}: {TEST_TOKEN}\r\nContent-Length: {}\r\n\r\n",
            crate::shim_authority(DEFAULT_PORT),
            crate::shim_origin(DEFAULT_PORT),
            body.len()
        );
        let mut request = parse_request(&head).expect("parsed request");
        request.body = body.as_bytes().to_vec();
        let response = handle(&request, DEFAULT_PORT, TEST_TOKEN, None);
        assert_eq!(response.status, 200, "the command was refused");
        serde_json::from_slice(&response.body).expect("a JSON answer")
    }

    /// A directory of its own under the temp directory, removed when the test ends. `XDG_DATA_HOME`
    /// is pointed at a sibling so the pick file lands somewhere removable rather than in the
    /// person's own data home. Serialized by a lock because the variable is process-wide.
    struct Scratch {
        root: PathBuf,
        data: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    /// One lock for every test that moves `XDG_DATA_HOME`, since the variable is shared.
    fn data_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let guard = data_lock();
            let root = std::env::temp_dir().join(format!(
                "lithic-syncfolder-{label}-{}-{unique}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&root);
            let data = root.join("data");
            fs::create_dir_all(&data).expect("the scratch data directory");
            std::env::set_var("XDG_DATA_HOME", &data);
            // A data home of its own is the only thing that keeps this test from writing into
            // a running shim's pick file, so it is asserted rather than assumed.
            assert_eq!(app_data_dir().as_deref(), Some(data.join("lithic").as_path()));
            Scratch { root, data, _guard: guard }
        }

        /// A folder to name in an answer, created so `is_dir` is true.
        fn folder(&self, name: &str) -> PathBuf {
            let dir = self.root.join(name);
            fs::create_dir_all(&dir).expect("folder");
            dir
        }

        /// A Lith inside a folder, which is what the launcher's derived path names. The file
        /// is the point: a derived path is the open Lith or the newest recents row, and only
        /// one that is on this machine counts as the launcher having a subject at all.
        fn lith(&self, dir: &Path, name: &str) -> PathBuf {
            let file = dir.join(name);
            fs::write(&file, "notes\n").expect("lith");
            file
        }

        /// Make `dir` a repository Lithic manages, which is the whole of what rule two reads.
        fn manage(&self, dir: &Path) {
            let git = dir.join(".git");
            fs::create_dir_all(&git).expect("dot git");
            fs::write(
                git.join("config"),
                format!("[remote \"origin\"]\n\turl = {MANAGED_URL}\n"),
            )
            .expect("config");
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // Read the guard so the field is not dead code; it is what keeps two tests from
            // moving `XDG_DATA_HOME` at once, and it is released after the removal below.
            let _ = &self._guard;
            let _ = fs::remove_dir_all(&self.root);
            std::env::remove_var("XDG_DATA_HOME");
        }
    }

    #[test]
    fn with_nothing_recorded_the_derived_folder_is_the_answer() {
        let scratch = Scratch::new("derived");
        let dir = scratch.folder("liths");
        let lith = scratch.lith(&dir, "notes.lith");
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&lith))
        ));
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["result"]["folder"], json!(path_text(&dir)));
        assert_eq!(answer["result"]["overridden"], json!(false));
    }

    #[test]
    fn a_managed_repository_above_the_derived_path_outranks_it() {
        let scratch = Scratch::new("cover");
        let root = scratch.folder("vault");
        scratch.manage(&root);
        let nested = root.join("projects");
        fs::create_dir_all(&nested).expect("nested");
        let lith = scratch.lith(&nested, "notes.lith");
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&lith))
        ));
        assert_eq!(answer["result"]["folder"], json!(path_text(&root)));
    }

    #[test]
    fn a_recorded_pick_outranks_everything_the_launcher_derived() {
        let scratch = Scratch::new("recorded");
        let picked = scratch.folder("chosen");
        let derived = scratch.folder("liths");
        scratch.manage(&derived);
        // Record through the file itself, which is what a successful `pick-folder` writes.
        fs::create_dir_all(scratch.data.join("lithic")).expect("data dir");
        fs::write(scratch.data.join("lithic").join(PICK_FILE), format!("{}\n", path_text(&picked)))
            .expect("pick file");
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&derived.join("notes.lith")))
        ));
        assert_eq!(answer["result"]["folder"], json!(path_text(&picked)));
        assert_eq!(answer["result"]["overridden"], json!(true));
    }

    #[test]
    fn a_recorded_pick_that_is_not_on_this_machine_falls_back() {
        let scratch = Scratch::new("stale");
        let derived = scratch.folder("liths");
        let lith = scratch.lith(&derived, "notes.lith");
        fs::create_dir_all(scratch.data.join("lithic")).expect("data dir");
        fs::write(
            scratch.data.join("lithic").join(PICK_FILE),
            format!("{}\n", path_text(&scratch.root.join("unplugged"))),
        )
        .expect("pick file");
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&lith))
        ));
        assert_eq!(answer["result"]["folder"], json!(path_text(&derived)));
        // Nothing recorded is in force, so the dialog has no override to offer to undo,
        // which is the desktop app's own rule (`overridden: chosen.is_some()`).
        assert_eq!(answer["result"]["overridden"], json!(false));
    }

    /// The proposal is the folder the app installs into, and that rule has one owner
    /// (`install.rs`). What this pins is that the folder the dialog is offered is that one,
    /// rather than a second folder invented here that would drift from it.
    #[test]
    fn the_proposal_is_the_folder_the_shim_installs_into() {
        assert_eq!(proposed(), install_dir());
    }

    #[test]
    fn with_nothing_to_name_the_answer_is_the_proposed_folder() {
        let _scratch = Scratch::new("proposed");
        let answer = ask("{\"command\":\"git-folder\",\"args\":{}}");
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(
            answer["result"]["folder"],
            json!(proposed().map(|dir| path_text(&dir))),
            "a machine that has never synced is offered where its backup will land"
        );
        assert_eq!(answer["result"]["overridden"], json!(false), "a proposal is not a pick");
        // An empty string is a launcher with nothing to name, not a folder called nothing.
        let blank = ask("{\"command\":\"git-folder\",\"args\":{\"derived\":\"  \"}}");
        assert_eq!(blank["result"]["folder"], json!(proposed().map(|dir| path_text(&dir))));
    }

    /// The proposal fills the empty case and no case with a Lith in it: the folder the person
    /// is working in still decides on its own, which is the desktop app's own rule.
    #[test]
    fn a_derived_folder_outranks_the_proposal() {
        let scratch = Scratch::new("proposal-derived");
        let dir = scratch.folder("liths");
        let lith = scratch.lith(&dir, "notes.lith");
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&lith))
        ));
        assert_eq!(answer["result"]["folder"], json!(path_text(&dir)));
    }

    /// The one folder a connect makes for itself, and the folder it must never silently
    /// become: `sync_dir_of` alone answers the folder *holding* a path that is not a
    /// directory, and for the proposal that is the whole of `Documents`.
    #[test]
    fn a_connect_makes_the_proposed_folder_and_never_the_folder_holding_it() {
        let scratch = Scratch::new("connect");
        let proposal = scratch.root.join("Documents/Lithic");
        assert!(!proposal.is_dir(), "the machine has never made it");

        // The proposal, named and missing: made, and the answer is the folder itself.
        assert_eq!(connect_dir(&proposal, Some(&proposal)), Some(proposal.clone()));
        assert!(proposal.is_dir(), "the proposal was made");

        // A folder the launcher derived that is not there keeps the old rule: nothing is made,
        // and the folder holding it is the answer.
        let holder = scratch.folder("liths");
        let stray = holder.join("gone.lith");
        assert_eq!(connect_dir(&stray, Some(&proposal)), Some(holder));
        assert!(!stray.exists(), "a stale row does not become a folder of its own");

        // A path with no folder to hold it is refused rather than guessed at.
        assert_eq!(connect_dir(&scratch.root.join("nowhere/gone.lith"), Some(&proposal)), None);
    }

    #[test]
    fn clearing_the_pick_goes_back_to_the_derived_folder() {
        let scratch = Scratch::new("clear");
        let picked = scratch.folder("chosen");
        let derived = scratch.folder("liths");
        assert_eq!(record(Some(&picked)), Ok(()));
        assert_eq!(recorded().as_deref(), Some(picked.as_path()));
        let cleared = ask("{\"command\":\"clear-folder-pick\",\"args\":{}}");
        assert_eq!(cleared["ok"], json!(true));
        assert_eq!(recorded(), None);
        // Clearing again is a success, not a missing-file failure.
        assert_eq!(record(None), Ok(()));
        let answer = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&derived))
        ));
        assert_eq!(answer["result"]["folder"], json!(path_text(&derived)));
        assert_eq!(answer["result"]["overridden"], json!(false));
    }

    /// A row is not a subject. A recents row outlives the Lith it names, and a folder is no
    /// evidence that the Lith inside it still is, so answering with one of those would leave
    /// the dialog naming a folder nothing can act on and the connect failing on `sync_dir_of`
    /// after the fact. The proposal answers instead, which is what a machine with no recents
    /// at all is offered.
    #[test]
    fn a_derived_path_that_is_not_on_this_machine_falls_through_to_the_proposal() {
        let scratch = Scratch::new("gone");
        // A row naming a folder that is gone from this machine entirely, and one naming a Lith
        // deleted out of a folder that is still here: the second is the likelier of the two,
        // because deleting a Lith is easier than deleting the folder it was in.
        let gone_folder = scratch.root.join("nowhere/notes.lith");
        let dir = scratch.folder("liths");
        let gone_lith = dir.join("notes.lith");
        for path in [gone_folder, gone_lith] {
            let answer = ask(&format!(
                "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
                json!(path_text(&path))
            ));
            assert_eq!(
                answer["result"]["folder"],
                json!(proposed().map(|dir| path_text(&dir))),
                "{} is not on this machine, so it is a row rather than a folder to act on",
                path_text(&path)
            );
            assert_eq!(answer["result"]["overridden"], json!(false), "a proposal is not a pick");
        }
    }

    #[test]
    fn the_folder_is_taken_from_a_file_or_the_folder_holding_it() {
        let scratch = Scratch::new("file-or-dir");
        let dir = scratch.folder("liths");
        let file = dir.join("notes.lith");
        fs::write(&file, "text").expect("file");
        let from_file = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&file))
        ));
        let from_dir = ask(&format!(
            "{{\"command\":\"git-folder\",\"args\":{{\"derived\":{}}}}}",
            json!(path_text(&dir))
        ));
        assert_eq!(from_file["result"], from_dir["result"]);
    }

    #[test]
    fn a_missing_derived_is_an_ordinary_answer_rather_than_a_refusal() {
        // `bad-args` is for a `path`-shaped command; `git-folder` may be asked with nothing,
        // so an absent derived is an answer rather than a refusal, and the answer is the
        // folder the shim proposes.
        let _scratch = Scratch::new("null-derived");
        let answer = ask("{\"command\":\"git-folder\",\"args\":{\"derived\":null}}");
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["result"]["folder"], json!(proposed().map(|dir| path_text(&dir))));
    }

    #[test]
    fn the_pick_file_is_the_only_thing_a_pick_writes() {
        let scratch = Scratch::new("file-shape");
        let picked = scratch.folder("chosen");
        assert_eq!(record(Some(&picked)), Ok(()));
        let file = scratch.data.join("lithic").join(PICK_FILE);
        assert_eq!(fs::read_to_string(&file).expect("the pick file"), format!("{}\n", path_text(&picked)));
        // Clearing removes it rather than leaving an empty line that would read as a pick.
        assert_eq!(record(None), Ok(()));
        assert!(!file.exists());
    }
}
