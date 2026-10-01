//! Hand a file from a launch that joined a shim to the shim already on the port.
//!
//! The gap this closes. A second launch that names a file usually finds the port already held
//! by a shim of the same build, and the rule for that is to join it rather than replace it: the
//! page in front of the person keeps its state and its origin. But the shim that owns the port
//! was started with no file, and the joining process cannot hand one to it directly, because
//! the command wire admits only the launcher page the shim itself served and that page holds a
//! per-launch secret this process has never seen.
//!
//! So the handoff goes through a file both processes can compute: one line under the shim's own
//! data directory (`app_data_dir()`), keyed by the port so two shims on two ports cannot read
//! each other's requests. The joining launch writes it before opening the browser, and the
//! running shim answers it through the `take-open` command, which reads and removes it so a
//! file opens once. The launcher asks for it at boot and then on a timer, which is what makes
//! it work whether the browser opened a new window (the boot ask) or merely raised the one it
//! already had (the timer).
//!
//! Best effort throughout, and never fatal: the person's window still opens and their launcher
//! still works if the file cannot be written, so the caller reports a failed handoff on stderr
//! and carries on rather than refusing to start.

use std::fs;
use std::path::{Path, PathBuf};

use crate::app_data_dir;

/// Hand the file a joining launch named to the shim serving `port`.
pub fn request_open(port: u16, path: &Path) -> Result<(), String> {
    let dir = app_data_dir().ok_or_else(|| "the shim has no data directory".to_string())?;
    record(&dir, port, path)
}

/// The file a running shim should open next, if a joining launch has left one, consumed.
pub(crate) fn take_open(port: u16) -> Option<PathBuf> {
    take(&app_data_dir()?, port)
}

/// Where a request for `port` lives under a given data directory.
///
/// The port in the name rather than one shared file: a shim is joined on the port it asked for,
/// and a request meant for the shim on 5484 must not be answered by one on 5485.
fn request_file(dir: &Path, port: u16) -> PathBuf {
    dir.join(format!("open-request-{port}"))
}

/// Write one path into the request file, creating the directory it needs.
fn record(dir: &Path, port: u16, path: &Path) -> Result<(), String> {
    let file = request_file(dir, port);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&file, format!("{}\n", path.to_string_lossy())).map_err(|error| error.to_string())
}

/// Read and remove the request file.
///
/// Reading and removing in one call is what makes a handed file open exactly once: the file is
/// gone whether the answer is used or not, so the launcher's next ask (or its timer, or a
/// second window) cannot open the same file twice. A missing or blank file is no request.
fn take(dir: &Path, port: u16) -> Option<PathBuf> {
    let file = request_file(dir, port);
    let text = fs::read_to_string(&file).ok()?;
    let _ = fs::remove_file(&file);
    let value = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A private scratch directory, with no environment touched, so this runs beside every
    /// other test in the crate without moving a process-wide variable.
    fn scratch(label: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("lithic-pending-{label}-{}-{unique}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A request is answered once: the file is consumed, so a timer or a second window cannot
    /// reopen it.
    #[test]
    fn a_requested_file_is_answered_once() {
        let dir = scratch("once");
        let file = dir.join("notes.lith");
        record(&dir, 5484, &file).expect("record");
        assert_eq!(take(&dir, 5484), Some(file.clone()));
        assert_eq!(take(&dir, 5484), None, "a handed file opens once");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Two shims on two ports keep separate requests.
    #[test]
    fn a_request_is_read_only_by_the_port_it_names() {
        let dir = scratch("port");
        record(&dir, 5484, Path::new("/a.lith")).expect("record");
        assert_eq!(take(&dir, 5485), None, "another port's shim must not answer this");
        assert_eq!(take(&dir, 5484), Some(PathBuf::from("/a.lith")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Nothing recorded, and a blank file, are both no request rather than an empty path.
    #[test]
    fn nothing_recorded_is_no_request() {
        let dir = scratch("empty");
        assert_eq!(take(&dir, 5484), None);
        fs::write(request_file(&dir, 5484), "\n").expect("blank");
        assert_eq!(take(&dir, 5484), None);
        assert!(!request_file(&dir, 5484).exists(), "a blank file is still consumed");
        let _ = fs::remove_dir_all(&dir);
    }
}
