//! The other Lithic windows on this machine, and the two questions an install asks them.
//!
//! An install writes over the program that is already installed, and the operating system
//! will not let it: a running executable is locked against writes (Windows answers a
//! sharing violation, Unix answers `ETXTBSY`). So an update either closes the windows that
//! are holding the installed copy, or it fails on a file nobody can explain. This module is
//! how one window knows another is there, and the whole of the answer is one small file per
//! window in a folder every copy of the app can read.
//!
//! **Where the folder is, and why not beside the program.** Every other piece of this app
//! keeps its state beside the executable, which is what makes a folder of liths, the program
//! and its state one portable neighbourhood. That rule is exactly wrong here: the whole
//! point is for the copy in `Downloads` to find the copy that was installed last month, and
//! those two keep their state in different folders. So the registry lives where the machine
//! keeps per-user data (`dirs::data_local_dir`, the roaming-free half of it), and every copy
//! of the app reads the same one.
//!
//! **A window's word is only good while it is still talking.** The entry carries the moment
//! it was last confirmed, and a window confirms it from the page (`launcher_stage`, which the
//! launcher calls every [`BEAT_MS`] for as long as it runs). That is deliberate rather than a
//! heartbeat kept by this side: it is what tells the two cases apart that would otherwise
//! look identical.
//!
//!   1. **A window inside a Lith can keep talking.** The engine takes the document over with
//!      `document.open`/`write`/`close`, which replaces the page without replacing the
//!      *window*: globals and timers survive it, so the launcher's own beat keeps running and
//!      goes on saying `wiki`. An install therefore knows, by name, whose window is holding
//!      the installed copy, and can say so instead of guessing.
//!   2. **A window showing somebody else's page cannot talk at all.** The desktop app opens a
//!      bookmarked instance in its own window, and Rust refuses IPC from a document outside
//!      the app's own URL, so such a page never sends a beat and its entry goes stale within
//!      [`LIVE_MS`]. A stale entry is never asked to close, which is the rule that keeps this
//!      feature from closing somebody's open Lith: it may only close a window that is still
//!      saying, right now, that it is sitting on a launcher.
//!
//! **Asking is a file, not a signal.** A request is a second file beside the entry
//! (`<pid>.quit`), which the asking side writes and removes again when its wait is over, and
//! which the target reads on its next beat. One writer per file, no locking, and nothing that
//! can be delivered to the wrong process: a request is only ever acted on by the window whose
//! own pid names it, and only while that window is on a launcher.
//!
//! **What is not asked here.** Whether the folder can be written, and whether the platform
//! offers an install at all, are `platform`'s questions. This module answers what the other
//! windows are doing, and nothing else.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How often a launcher window says where it is. The beat is also how it learns that somebody
/// has asked it to close, so it is the upper bound on how long an install waits for a window
/// that is only idling.
pub const BEAT_MS: u64 = 2000;

/// How long a window's last word is believed. Comfortably longer than one beat, so a slow
/// moment is not mistaken for a window that has gone, and short enough that a page which can
/// no longer talk (see the module docs) stops being asked to close within a few seconds.
pub const LIVE_MS: u64 = 6000;

/// How long an entry nobody refreshes may sit in the folder before a start sweeps it away.
/// A crashed window leaves one behind, and a stale entry is already ignored by everything
/// here; this only keeps the folder from collecting them.
pub const SWEEP_MS: u64 = 60_000;

/// How long an install waits for the windows it asked to close. Long enough for a few beats
/// plus the time it takes a window to shut down, and short enough not to look hung.
pub const WAIT_MS: u64 = 3000;

/// How often the waiting install looks again.
pub const POLL_MS: u64 = 100;

// The three clocks are one decision, so their relationship is a compile error rather than a
// test: the page beats every `BEAT_MS` (handed to it by `launcher_stage`, so the two cannot
// drift), a word is believed for `LIVE_MS`, and an install waits `WAIT_MS` for the windows it
// asked. A single missed beat must not read as a window that has gone, and the wait has to
// outlast the beat it is waiting on.
const _: () = assert!(LIVE_MS >= BEAT_MS * 2);
const _: () = assert!(WAIT_MS > BEAT_MS);

/// A window that is sitting on a launcher, which is the one state it is safe to close.
pub const STAGE_LAUNCHER: &str = "launcher";

/// A window whose engine has taken the document over, which is the state that must not be
/// closed behind somebody's back.
pub const STAGE_WIKI: &str = "wiki";

/// The folder name, under the app's own data folder.
const DIR: &str = "Lithic";

/// One running window, as it records itself.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Presence {
    pub pid: u32,
    /// [`STAGE_LAUNCHER`] or [`STAGE_WIKI`], as the page last said.
    pub stage: String,
    /// The Lith this window has open, when it is inside one. Read out for the sentence an
    /// install refuses with, which is the only place a window's own name is worth anything.
    pub wiki: Option<String>,
    /// The program file this window is running, so the install can tell which window is
    /// holding the copy it is about to write.
    pub image: String,
    /// When the page last confirmed all of the above.
    pub seen_ms: u64,
}

/// The milliseconds since the epoch, which is the only clock here.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// The folder every copy of the app keeps its window registry in.
///
/// `data_local_dir` rather than `data_dir`: this is state about *this machine's* running
/// processes, and one that roams to another machine would be an entry about a window that
/// was never there.
pub fn dir() -> Option<PathBuf> {
    dir_on(dirs::data_local_dir(), dirs::data_dir())
}

/// The same decision with its inputs named, so a test can drive it without a home folder.
pub fn dir_on(local: Option<PathBuf>, roaming: Option<PathBuf>) -> Option<PathBuf> {
    local
        .or(roaming)
        .map(|root| root.join(DIR).join("instances"))
}

/// The registry as a folder of files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registry {
    dir: PathBuf,
}

impl Registry {
    /// The machine's registry, or `None` when this process cannot name a per-user folder.
    pub fn open() -> Option<Self> {
        dir().map(|dir| Registry { dir })
    }

    /// A registry in a folder a test chose.
    #[cfg(test)]
    pub fn in_dir(dir: PathBuf) -> Self {
        Registry { dir }
    }

    /// Where one window records itself.
    fn entry_file(&self, pid: u32) -> PathBuf {
        self.dir.join(format!("{pid}.json"))
    }

    /// Where one window is asked to close.
    fn quit_file(&self, pid: u32) -> PathBuf {
        self.dir.join(format!("{pid}.quit"))
    }

    /// Every other window on this machine. Unreadable and half-written files are skipped
    /// rather than reported: an entry is a convenience, and a torn one is not a window.
    pub fn entries(&self) -> Vec<Presence> {
        let own = std::process::id();
        let Ok(listing) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for entry in listing.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(presence) = serde_json::from_str::<Presence>(&text) else {
                continue;
            };
            if presence.pid == own {
                continue;
            }
            found.push(presence);
        }
        found
    }

    /// Record this window. Creates the folder on the way, since this is the first writer of
    /// it that every copy of the app shares.
    pub fn write(&self, presence: &Presence) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let text = serde_json::to_string(presence).unwrap_or_default();
        fs::write(self.entry_file(presence.pid), text)
    }

    /// Forget this window. Called as the app exits, so the ordinary end of a session leaves
    /// nothing behind; a crash leaves an entry that [`SWEEP_MS`] takes care of.
    pub fn forget(&self, pid: u32) {
        let _ = fs::remove_file(self.entry_file(pid));
    }

    /// Ask one window to close, by leaving the request where its own beat will find it.
    pub fn ask_to_quit(&self, pid: u32) {
        let _ = fs::create_dir_all(&self.dir);
        let _ = fs::write(self.quit_file(pid), "");
    }

    /// Take the request back. The asking side owns this file: it writes it, and it removes it
    /// when its wait is over, whether or not the window it was meant for did anything.
    pub fn recall_quit(&self, pid: u32) {
        let _ = fs::remove_file(self.quit_file(pid));
    }

    /// Whether this window has been asked to close.
    pub fn quit_requested(&self, pid: u32) -> bool {
        self.quit_file(pid).exists()
    }

    /// Remove entries nobody has refreshed for [`SWEEP_MS`]. Only ever called by a window
    /// that has just started, so it cannot remove a live sibling: every live window beats.
    pub fn sweep(&self, now: u64) {
        let Ok(listing) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in listing.flatten() {
            let path = entry.path();
            let Some(age) = now.checked_sub(entry_seen(&path).unwrap_or(0)) else {
                continue;
            };
            if age > SWEEP_MS {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// When the window an entry file describes last said anything, if it is readable at all.
fn entry_seen(path: &Path) -> Option<u64> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("quit") {
        // A leftover request is nobody's entry, and it is removed by age like the rest.
        return fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as u64);
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Presence>(&text)
        .ok()
        .map(|presence| presence.seen_ms)
}

/// The windows an install may ask to close: the ones sitting on a launcher, and still saying
/// so. A window inside a Lith, and a window that has stopped answering, are both left alone.
pub fn askable(entries: &[Presence], now: u64) -> Vec<Presence> {
    entries
        .iter()
        .filter(|entry| may_close(entry, now))
        .cloned()
        .collect()
}

/// Whether one window may be asked to close.
pub fn may_close(entry: &Presence, now: u64) -> bool {
    entry.stage == STAGE_LAUNCHER && is_live(entry, now)
}

/// Whether a window has said anything recently enough to be believed.
pub fn is_live(entry: &Presence, now: u64) -> bool {
    now.saturating_sub(entry.seen_ms) <= LIVE_MS
}

/// The Lith a window has open, when it is inside one. The name read out of the entry that is
/// holding the installed copy, which is what the refusal sentence says out loud.
pub fn open_lith(entry: &Presence) -> Option<String> {
    if entry.stage != STAGE_WIKI {
        return None;
    }
    let name = entry.wiki.as_deref()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Which window is holding the file an install is about to write, if a live one explains it.
///
/// Named only for a window that is inside a Lith: that is the case an install refuses, and
/// the sentence is more use with the Lith in it. A launcher window still holding the copy is
/// a window that simply did not close, and the generic sentence covers it as well.
pub fn holder(entries: &[Presence], now: u64, target: &Path) -> Option<String> {
    entries
        .iter()
        .filter(|entry| is_live(entry, now))
        .filter(|entry| same_file(Path::new(&entry.image), target))
        .find_map(open_lith)
}

/// Whether two paths name the same file, tolerating a path that cannot be resolved.
fn same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Whether the file an install is about to write is being held by a running program.
///
/// Asked rather than assumed, because the answer decides between two entirely different
/// sentences: the update is refused while another window holds it, and attempted otherwise.
/// Only the two shapes a *running program* produces count, so a read-only file, a missing
/// file and an antivirus lock are all left to the copy itself to report.
pub fn is_locked(path: &Path) -> bool {
    match fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(error) => {
            error.kind() == std::io::ErrorKind::ExecutableFileBusy
                || error.raw_os_error() == Some(SHARING_VIOLATION)
        }
    }
}

/// `ERROR_SHARING_VIOLATION`, which is how Windows refuses to open a running executable for
/// writing. Named rather than matched by kind, because the kind for it is `PermissionDenied`,
/// which is also what a dozen unrelated refusals answer with.
const SHARING_VIOLATION: i32 = 32;

/// How long an install waits between looks, as a duration.
pub fn poll_interval() -> Duration {
    Duration::from_millis(POLL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lithic-instances-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn window(pid: u32, stage: &str, wiki: Option<&str>, seen: u64) -> Presence {
        Presence {
            pid,
            stage: stage.to_string(),
            wiki: wiki.map(str::to_string),
            image: format!("/programs/Lithic-{pid}"),
            seen_ms: seen,
        }
    }

    /// The rule the whole feature rests on: a window that is inside a Lith, and a window that
    /// has stopped answering, are both left alone. This is what keeps an install from closing
    /// somebody's open wiki, which no download can give back.
    #[test]
    fn only_a_window_that_still_says_it_is_on_a_launcher_is_asked_to_close() {
        let now = 1_000_000;
        let entries = vec![
            window(10, STAGE_LAUNCHER, None, now - 1_000),
            window(11, STAGE_WIKI, Some("notes.lith"), now - 1_000),
            // A launcher that stopped beating two minutes ago: a page nobody can reach any
            // more, so it is not a window to close.
            window(12, STAGE_LAUNCHER, None, now - 120_000),
        ];
        let asked: Vec<u32> = askable(&entries, now)
            .iter()
            .map(|entry| entry.pid)
            .collect();
        assert_eq!(asked, vec![10]);
    }

    /// The boundary of `LIVE_MS`, held from both sides, because an install's whole behaviour
    /// turns on it.
    #[test]
    fn a_word_is_good_for_the_window_and_no_longer() {
        let now = 1_000_000;
        assert!(is_live(
            &window(1, STAGE_LAUNCHER, None, now - LIVE_MS),
            now
        ));
        assert!(!is_live(
            &window(1, STAGE_LAUNCHER, None, now - LIVE_MS - 1),
            now
        ));
    }

    /// A refusal names the Lith when a window explains the lock, and says nothing when the
    /// entry holding the copy is not inside one.
    #[test]
    fn the_window_holding_the_copy_is_named_only_when_it_has_a_lith_open() {
        let now = 1_000_000;
        let target = Path::new("/programs/Lithic-installed");
        let held = |stage: &str, wiki: Option<&str>, image: &str| Presence {
            pid: 20,
            stage: stage.to_string(),
            wiki: wiki.map(str::to_string),
            image: image.to_string(),
            seen_ms: now,
        };

        let inside = vec![held(
            STAGE_WIKI,
            Some("study.lith"),
            "/programs/Lithic-installed",
        )];
        assert_eq!(holder(&inside, now, target).as_deref(), Some("study.lith"));

        // A launcher window holding it is a window that did not close, not a Lith, so the
        // refusal falls back to its generic sentence.
        let idle = vec![held(STAGE_LAUNCHER, None, "/programs/Lithic-installed")];
        assert_eq!(holder(&idle, now, target), None);

        // A window running a *different* file does not hold this one at all, whatever it has
        // open: the copy is not blocked by it.
        let elsewhere = vec![held(
            STAGE_WIKI,
            Some("other.lith"),
            "/downloads/Lithic-new.exe",
        )];
        assert_eq!(holder(&elsewhere, now, target), None);

        // And a window that has gone quiet explains nothing.
        let quiet = vec![Presence {
            seen_ms: now - LIVE_MS - 1,
            ..held(STAGE_WIKI, Some("old.lith"), "/programs/Lithic-installed")
        }];
        assert_eq!(holder(&quiet, now, target), None);
    }

    /// A Lith with no name in it is not a name to quote, and a stage that is not a Lith has
    /// no Lith to quote either.
    #[test]
    fn an_empty_lith_name_is_not_a_name() {
        assert_eq!(open_lith(&window(1, STAGE_WIKI, Some("   "), 0)), None);
        assert_eq!(open_lith(&window(1, STAGE_WIKI, None, 0)), None);
        assert_eq!(
            open_lith(&window(1, STAGE_LAUNCHER, Some("notes.lith"), 0)),
            None
        );
        assert_eq!(
            open_lith(&window(1, STAGE_WIKI, Some("notes.lith"), 0)).as_deref(),
            Some("notes.lith")
        );
    }

    /// The request is a file one side writes and the asking side takes back, so a window that
    /// was asked to close, then left alone, is not asked again by a later install.
    #[test]
    fn a_request_is_written_and_taken_back() {
        let registry = Registry::in_dir(scratch("quit"));
        assert!(!registry.quit_requested(4242));
        registry.ask_to_quit(4242);
        assert!(registry.quit_requested(4242));
        registry.recall_quit(4242);
        assert!(!registry.quit_requested(4242));
    }

    /// Entries round-trip through the folder, this window's own file is never among them, and
    /// a file that is not a whole entry is passed over rather than read as one.
    #[test]
    fn entries_are_read_back_without_this_window_or_a_torn_file() {
        let dir = scratch("entries");
        let registry = Registry::in_dir(dir.clone());
        registry
            .write(&window(7, STAGE_WIKI, Some("notes.lith"), 1234))
            .unwrap();
        fs::write(dir.join(format!("{}.json", std::process::id())), "{}").unwrap();
        fs::write(dir.join("999.json"), "{\"pid\":99").unwrap();
        fs::write(dir.join("notes.txt"), "not an entry").unwrap();

        let entries = registry.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, 7);
        assert_eq!(entries[0].stage, STAGE_WIKI);
        assert_eq!(entries[0].wiki.as_deref(), Some("notes.lith"));
        assert_eq!(entries[0].seen_ms, 1234);

        registry.forget(7);
        assert!(registry.entries().is_empty());
    }

    /// A sweep takes what nobody has refreshed, including a request left behind by a window
    /// that crashed mid-install, and keeps a live entry where it is.
    #[test]
    fn a_sweep_removes_only_what_nobody_has_refreshed() {
        let dir = scratch("sweep");
        let registry = Registry::in_dir(dir.clone());
        let now = now_ms();
        registry
            .write(&window(1, STAGE_LAUNCHER, None, now - 1_000))
            .unwrap();
        registry
            .write(&window(2, STAGE_LAUNCHER, None, now - SWEEP_MS - 1))
            .unwrap();
        // Two requests, and only their own age tells them apart: one an install is waiting on
        // right now, and one left behind by an install that died mid-wait. The second is the
        // whole reason the sweep looks at request files at all, since nothing else would ever
        // remove it and a later window with that pid would close for no reason at all.
        registry.ask_to_quit(3);
        registry.ask_to_quit(4);
        let stale = SystemTime::now() - Duration::from_millis(SWEEP_MS + 60_000);
        fs::OpenOptions::new()
            .write(true)
            .open(dir.join("3.quit"))
            .unwrap()
            .set_modified(stale)
            .unwrap();

        registry.sweep(now);

        let left: Vec<u32> = registry.entries().iter().map(|entry| entry.pid).collect();
        assert_eq!(left, vec![1]);
        assert!(
            !registry.quit_requested(3),
            "a request nobody is waiting on is swept"
        );
        assert!(
            registry.quit_requested(4),
            "and one an install is waiting on is kept"
        );
    }

    /// The local folder wins over the roaming one, and a machine with neither is no registry
    /// rather than a folder in the working directory.
    #[test]
    fn the_registry_folder_is_local_before_roaming() {
        let local = PathBuf::from("/local");
        let roaming = PathBuf::from("/roaming");
        assert_eq!(
            dir_on(Some(local.clone()), Some(roaming.clone())),
            Some(local.join(DIR).join("instances"))
        );
        assert_eq!(
            dir_on(None, Some(roaming.clone())),
            Some(roaming.join(DIR).join("instances"))
        );
        assert_eq!(dir_on(None, None), None);
    }

    /// The lock probe answers about a running program, not about every refusal. A file this
    /// process is not allowed to write is the copy's business, not a window's.
    #[test]
    fn the_lock_probe_separates_a_busy_file_from_a_missing_one() {
        let dir = scratch("lock");
        let free = dir.join("free.bin");
        fs::write(&free, b"here").unwrap();
        assert!(!is_locked(&free), "a writable file is not locked");
        assert!(
            !is_locked(&dir.join("absent.bin")),
            "a file that is not there is not locked"
        );
    }
}
