//! The command wire: the gate, and the native file commands behind it.
//!
//! Why this endpoint exists at all. A browser hands a page a file's *contents* and never
//! where the file is: a `FileSystemFileHandle` deliberately exposes a name and no path, and
//! `<input type=file>` gives a fake one. So every operation that needs a real path, which is
//! every operation that has to write a Lith back where it came from, can only be done by the
//! process serving the page. That process is this shim, and this module is the whole of what
//! it will do for the page.
//!
//! Why the gate comes before the first command, and stays in front of all of them. CORS stops
//! a hostile page from *reading* an answer, not from causing the effect, and the alternative
//! is a loopback endpoint that reads and writes any file the person can. So the gate refuses
//! everything a page this shim served would not send: `POST` only, because a state-changing
//! `GET` is the one shape a hostile page can cause with no preflight; `Origin` exactly this
//! shim's origin; `Host` exactly the address the shim opened, which is what a name resolving
//! to loopback cannot present; `Sec-Fetch-Site: same-origin`; the per-launch token minted into
//! the launcher document and into no other; and an `application/json` body inside the cap.
//! Every failed check answers the same one message, so the wire cannot be probed.
//!
//! What is behind it, all of it through `std::fs` and `std::process` rather than a toolkit:
//!
//!   * `pick` opens the desktop's own file chooser (`zenity`, `yad` or `kdialog`, the same
//!     programs the shim already trusts for `xdg-open`) so the person names a real path. A
//!     desktop with none answers `no-picker`, and the launcher keeps the browser's own picker
//!     as the fallback.
//!   * `read` hands back a path's text, `write` puts text back at a path atomically, and
//!     `list` answers a directory's entries for the recents check and for a chooser the
//!     launcher can draw where no dialog exists.
//!   * `startup` names the `.lith` the shim was started with, so double-clicking one in a file
//!     manager opens it, which is the shape every desktop document program already has.
//!
//! `ping` stays, because a launcher asks it to learn that a backend is here at all, which is
//! the one fact every later command needs.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::{
    json_response, refused, shim_authority, shim_origin, token_matches, Request, Response,
    MAX_BODY_BYTES, TOKEN_HEADER,
};

/// The largest file the shim will read into a JSON answer. Comfortably above the largest Lith
/// seen, and small enough that a wrong path cannot ask for the machine's whole disk.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The largest text a single `write` will accept, for the same reason.
const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;

/// Whether a body of this length is past what the wire will look at.
///
/// A function rather than an inline comparison so the rule has one owner and a test can check
/// it without allocating the bytes it describes.
pub fn body_is_oversized(length: usize) -> bool {
    length > MAX_BODY_BYTES
}

/// Turn a request into an answer, or refuse it.
///
/// The order runs from the cheapest identity proof to the request itself, and every refusal
/// before the body is parsed is the same message. `startup` is the `.lith` the process was
/// started with, threaded in rather than read from an environment variable because it is a
/// property of this launch alone.
pub fn handle(request: &Request, port: u16, token: &str, startup: Option<&Path>) -> Response {
    if request.method != "POST" {
        return Response::plain(
            405,
            "Method Not Allowed",
            "The command wire answers POST only.\n",
            "no-store",
        )
        .allowing("POST");
    }
    if request.header("origin") != Some(shim_origin(port).as_str()) {
        return refused();
    }
    if request.host.as_deref() != Some(shim_authority(port).as_str()) {
        return refused();
    }
    if request.header("sec-fetch-site") != Some("same-origin") {
        return refused();
    }
    match request.header(TOKEN_HEADER) {
        Some(presented) if token_matches(token, presented) => {}
        _ => return refused(),
    }
    let is_json = request
        .header("content-type")
        .is_some_and(|value| value.trim_start().to_ascii_lowercase().starts_with("application/json"));
    if !is_json {
        return Response::plain(
            415,
            "Unsupported Media Type",
            "The command wire reads application/json.\n",
            "no-store",
        );
    }
    if body_is_oversized(request.body.len()) {
        return Response::plain(413, "Payload Too Large", "The command body is too large.\n", "no-store");
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&request.body) else {
        return Response::plain(400, "Bad Request", "The command body is not JSON.\n", "no-store");
    };
    let Some(command) = payload.get("command").and_then(|value| value.as_str()) else {
        return Response::plain(400, "Bad Request", "The command body names no command.\n", "no-store");
    };
    let args = payload.get("args").cloned().unwrap_or(Value::Null);

    match command {
        // The wire's own liveness: a launcher asks this to learn that a backend is here at
        // all, which is the one fact every later command needs.
        "ping" => ok(json!({ "shim": true })),
        "startup" => ok(json!({ "path": startup.map(path_text) })),
        "pick" => pick(&args),
        "read" => read(&args),
        "write" => write(&args),
        "list" => list(&args),
        // A command with nothing behind it is still an answer rather than a refusal: the wire
        // worked, and what it was asked for it does not have.
        other => json_response(
            200,
            "OK",
            json!({ "ok": false, "error": "unknown-command", "command": other }),
        ),
    }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/// A command that worked.
fn ok(result: Value) -> Response {
    json_response(200, "OK", json!({ "ok": true, "result": result }))
}

/// A command that could not, named by a code rather than by a paragraph the launcher would
/// have to translate. The launcher turns the code into its own line.
fn failed(code: &str) -> Response {
    json_response(200, "OK", json!({ "ok": false, "error": code }))
}

/// A missing or unusable argument.
fn bad_args() -> Response {
    failed("bad-args")
}

// ---------------------------------------------------------------------------
// Reading, writing, listing
// ---------------------------------------------------------------------------

/// `read { path }`
///
/// The bytes come back as lossy UTF-8 rather than an error: a Lith is text, and the only way
/// to hand binary through this wire would be base64 the launcher would then have to undo.
fn read(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(_) => return failed("unreadable"),
    };
    if !meta.is_file() {
        return failed("not-a-file");
    }
    if meta.len() > MAX_FILE_BYTES {
        return failed("too-large");
    }
    let Ok(bytes) = fs::read(&path) else { return failed("unreadable") };
    ok(json!({
        "name": file_name(&path),
        "path": path_text(&path),
        "text": String::from_utf8_lossy(&bytes),
    }))
}

/// `write { path, text }`
///
/// The write is atomic: the text lands in a temporary file beside the target and is renamed
/// over it, so a save that is interrupted leaves the previous copy rather than half of the
/// new one. The temporary name carries the process id and a counter, so two saves to the same
/// folder can never collide.
fn write(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(text) = args.get("text").and_then(|value| value.as_str()) else {
        return bad_args();
    };
    if text.len() > MAX_WRITE_BYTES {
        return failed("too-large");
    }
    if path.is_dir() {
        return failed("not-a-file");
    }
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return failed("no-directory");
        }
    }
    match write_atomic(&path, text.as_bytes()) {
        Ok(()) => ok(json!({ "name": file_name(&path), "path": path_text(&path) })),
        Err(error) => {
            eprintln!("shim: write to {} failed: {error}", path.display());
            failed("io")
        }
    }
}

/// `list { path? }`
///
/// With no path the answer is the home directory, which is where a chooser and a recents check
/// both want to start. Directories sort before files so a person reading the answer sees the
/// places to go before the documents in them.
fn list(args: &Value) -> Response {
    let dir = match path_arg(args) {
        Some(path) => path,
        None => match home_dir() {
            Some(home) => home,
            None => return failed("bad-args"),
        },
    };
    let Ok(meta) = fs::metadata(&dir) else { return failed("unreadable") };
    if !meta.is_dir() {
        return failed("not-a-directory");
    }
    let Ok(entries) = fs::read_dir(&dir) else { return failed("unreadable") };
    let mut rows: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        rows.push(json!({
            "name": file_name(&path),
            "path": path_text(&path),
            "dir": is_dir,
        }));
    }
    rows.sort_by(|a, b| {
        let a_dir = a.get("dir").and_then(Value::as_bool).unwrap_or(false);
        let b_dir = b.get("dir").and_then(Value::as_bool).unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| {
            let a_name = a.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let b_name = b.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            a_name.cmp(&b_name)
        })
    });
    let parent = dir.parent().filter(|parent| !parent.as_os_str().is_empty()).map(path_text);
    ok(json!({ "path": path_text(&dir), "parent": parent, "entries": rows }))
}

/// Write bytes to `path` by way of a temporary file in the same directory, then rename. A
/// rename within one directory is atomic on every platform this ships to, so a reader sees
/// either the whole old file or the whole new one.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let directory = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
    let temporary = directory.join(format!(".lithic-save-{}-{unique}", std::process::id()));
    if let Err(error) = fs::write(&temporary, bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The desktop's own chooser
// ---------------------------------------------------------------------------

/// The chooser programs, in the order a machine is likely to have one, with the dialect each
/// speaks. `zenity` and `yad` share one; KDE's `kdialog` is its own.
#[cfg(any(target_os = "linux", test))]
const PICKERS: &[(&str, Picker)] = &[("zenity", Picker::Zenity), ("yad", Picker::Zenity), ("kdialog", Picker::Kdialog)];

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Picker {
    Zenity,
    Kdialog,
}

/// The file filter both choosers are handed: the formats the launcher can mount.
#[cfg(any(target_os = "linux", test))]
const PICK_FILTER: &str = "*.lith *.html *.htm *.json *.md *.txt *.tid *.ipynb";

/// `pick { mode, multiple?, suggestedName?, startDir? }`
///
/// On Linux the desktop's own chooser answers. Everywhere else the shim has no chooser to
/// reach, which is an answer rather than a fault: the launcher keeps the browser's picker for
/// exactly that case.
fn pick(args: &Value) -> Response {
    #[cfg(target_os = "linux")]
    {
        let mode = args.get("mode").and_then(Value::as_str).unwrap_or("open");
        let multiple = mode == "open" && args.get("multiple").and_then(Value::as_bool).unwrap_or(false);
        let suggested = args.get("suggestedName").and_then(Value::as_str);
        let start = args.get("startDir").and_then(Value::as_str);
        let Some((program, dialect)) = first_picker(program_on_path) else {
            return failed("no-picker");
        };
        let arguments = picker_args(dialect, program, mode, multiple, suggested, start);
        return match run_picker(program, &arguments) {
            Ok(Some(stdout)) => ok(json!({ "paths": pick_output(&stdout, multiple) })),
            // A chooser that answered nothing is a cancelled pick, which is an ordinary
            // answer rather than a failure: the person pressed Escape.
            Ok(None) => ok(json!({ "paths": Vec::<String>::new() })),
            Err(error) => {
                eprintln!("shim: the file chooser {program} failed: {error}");
                failed("pick-failed")
            }
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        failed("no-picker")
    }
}

/// The first chooser a lookup finds, with the dialect it speaks.
#[cfg(any(target_os = "linux", test))]
fn first_picker(lookup: impl Fn(&str) -> bool) -> Option<(&'static str, Picker)> {
    PICKERS.iter().copied().find(|(program, _)| lookup(program))
}

/// Whether a program name is on `PATH`.
///
/// The `allow` is for a non-Linux test build, where no real chooser is reachable and the
/// only caller of this is compiled out, yet the tests still check the program order.
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn program_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// The arguments that put a chooser into the shape the request asks for.
#[cfg(any(target_os = "linux", test))]
fn picker_args(
    dialect: Picker,
    program: &str,
    mode: &str,
    multiple: bool,
    suggested: Option<&str>,
    start: Option<&str>,
) -> Vec<String> {
    let saving = mode == "save";
    let mut args: Vec<String> = vec!["--title".to_string(), "Lithic".to_string()];
    match dialect {
        Picker::Zenity => {
            args.push("--file-selection".to_string());
            if saving {
                args.push("--save".to_string());
                args.push("--confirm-overwrite".to_string());
            } else if multiple {
                args.push("--multiple".to_string());
            }
            if let Some(name) = start_for_zenity(start, suggested, saving) {
                args.push(format!("--filename={name}"));
            }
            args.push(format!("--file-filter=Lithic files | {PICK_FILTER}"));
        }
        Picker::Kdialog => {
            if !saving && multiple {
                args.push("--multiple".to_string());
                args.push("--separate-output".to_string());
            }
            args.push(if saving { "--getsavefilename".to_string() } else { "--getopenfilename".to_string() });
            args.push(start_for_kdialog(start, suggested, saving));
            args.push(format!("{PICK_FILTER}|Lithic files"));
        }
    }
    let _ = program;
    args
}

/// `zenity` wants a file name to preselect: a directory (with its trailing separator) for an
/// open dialog, and the suggested name under the start directory for a save.
#[cfg(any(target_os = "linux", test))]
fn start_for_zenity(start: Option<&str>, suggested: Option<&str>, saving: bool) -> Option<String> {
    let directory = start.map(|value| value.trim_end_matches(['/', '\\']).to_string());
    match (saving, directory) {
        (true, Some(directory)) => Some(match suggested {
            Some(name) if !name.is_empty() => format!("{directory}/{name}"),
            _ => format!("{directory}/"),
        }),
        (true, None) => suggested.filter(|name| !name.is_empty()).map(str::to_string),
        (false, Some(directory)) => Some(format!("{directory}/")),
        (false, None) => None,
    }
}

/// `kdialog` wants a start directory, or `:` for the current one, and appends the suggested
/// name for a save.
#[cfg(any(target_os = "linux", test))]
fn start_for_kdialog(start: Option<&str>, suggested: Option<&str>, saving: bool) -> String {
    let directory = start
        .map(|value| value.trim_end_matches(['/', '\\']).to_string())
        .unwrap_or_else(|| ":".to_string());
    if saving {
        if let Some(name) = suggested.filter(|name| !name.is_empty()) {
            if directory == ":" {
                return name.to_string();
            }
            return format!("{directory}/{name}");
        }
    }
    directory
}

/// The chosen paths out of a chooser's standard output, one per line and blank lines dropped.
/// A save asks for one, so only the first line is an answer.
#[cfg(any(target_os = "linux", test))]
fn pick_output(stdout: &str, multiple: bool) -> Vec<String> {
    let mut paths: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if !multiple {
        paths.truncate(1);
    }
    paths
}

/// Run a chooser and read what it printed. `Ok(None)` means it exited without an answer, which
/// is a cancellation rather than a failure.
#[cfg(target_os = "linux")]
fn run_picker(program: &str, args: &[String]) -> std::io::Result<Option<String>> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// A path argument, trimmed and refused when empty.
fn path_arg(args: &Value) -> Option<PathBuf> {
    let raw = args.get("path").and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

/// The home directory, which is where a chooser with no start and a bare `list` both begin.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|home| !home.as_os_str().is_empty())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_text(path))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse_request, COMMAND_PATH, DEFAULT_PORT};
    use std::sync::atomic::AtomicU32;

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// The same request a real launcher page makes, as one value a test can read.
    fn launcher_request(body: &str) -> Request {
        let head = format!(
            "POST {COMMAND_PATH} HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\n\
             Sec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\n\
             {TOKEN_HEADER}: {TEST_TOKEN}\r\nContent-Length: {}\r\n\r\n",
            shim_authority(DEFAULT_PORT),
            shim_origin(DEFAULT_PORT),
            body.len()
        );
        let mut request = parse_request(&head).expect("parsed request");
        request.body = body.as_bytes().to_vec();
        request
    }

    fn ask(body: &str) -> Response {
        handle(&launcher_request(body), DEFAULT_PORT, TEST_TOKEN, None)
    }

    fn body_of(response: &Response) -> String {
        String::from_utf8_lossy(&response.body).into_owned()
    }

    /// A directory of its own under the temp directory, removed when the test ends.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!("lithic-command-{label}-{}-{unique}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("scratch directory");
            Scratch { root }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// The JSON answer to a `read`, `write` or `list`, parsed rather than matched as text so
    /// the tests read as the launcher's own decoding would.
    fn answer(body: &str) -> Value {
        let response = ask(body);
        assert_eq!(response.status, 200, "the command was refused: {}", body_of(&response));
        serde_json::from_slice(&response.body).expect("a JSON answer")
    }

    #[test]
    fn ping_answers_that_a_backend_is_here() {
        let response = ask("{\"command\":\"ping\"}");
        assert_eq!(response.status, 200);
        assert_eq!(body_of(&response), "{\"ok\":true,\"result\":{\"shim\":true}}");
    }

    #[test]
    fn write_then_read_round_trips_a_path() {
        let scratch = Scratch::new("round-trip");
        let file = scratch.root.join("note.lith");
        let written = answer(&format!(
            "{{\"command\":\"write\",\"args\":{{\"path\":{},\"text\":\"hello, lith\"}}}}",
            json!(path_text(&file))
        ));
        assert_eq!(written["ok"], json!(true));
        assert_eq!(written["result"]["name"], json!("note.lith"));
        assert_eq!(fs::read_to_string(&file).expect("the file was written"), "hello, lith");

        let read = answer(&format!(
            "{{\"command\":\"read\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&file))
        ));
        assert_eq!(read["result"]["text"], json!("hello, lith"));
        assert_eq!(read["result"]["path"], json!(path_text(&file)));
    }

    #[test]
    fn a_write_leaves_no_temporary_file_behind() {
        let scratch = Scratch::new("atomic");
        let file = scratch.root.join("note.lith");
        fs::write(&file, "old").expect("seed");
        answer(&format!(
            "{{\"command\":\"write\",\"args\":{{\"path\":{},\"text\":\"new\"}}}}",
            json!(path_text(&file))
        ));
        assert_eq!(fs::read_to_string(&file).expect("the file was written"), "new");
        let leftovers: Vec<String> = fs::read_dir(&scratch.root)
            .expect("scratch")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".lithic-save-"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files were left behind: {leftovers:?}");
    }

    #[test]
    fn reading_what_is_not_a_file_is_named_not_guessed() {
        let scratch = Scratch::new("read-errors");
        let directory = answer(&format!(
            "{{\"command\":\"read\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(directory["error"], json!("not-a-file"));
        let missing = answer(&format!(
            "{{\"command\":\"read\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root.join("nope.lith")))
        ));
        assert_eq!(missing["error"], json!("unreadable"));
        let no_path = answer("{\"command\":\"read\",\"args\":{}}");
        assert_eq!(no_path["error"], json!("bad-args"));
    }

    #[test]
    fn writing_into_a_directory_that_is_not_there_is_refused() {
        let scratch = Scratch::new("write-errors");
        let missing = scratch.root.join("nowhere/note.lith");
        let answer = answer(&format!(
            "{{\"command\":\"write\",\"args\":{{\"path\":{},\"text\":\"x\"}}}}",
            json!(path_text(&missing))
        ));
        assert_eq!(answer["error"], json!("no-directory"));
        assert!(!missing.exists());
    }

    #[test]
    fn listing_a_directory_puts_the_places_before_the_documents() {
        let scratch = Scratch::new("list");
        fs::create_dir_all(scratch.root.join("folder")).expect("folder");
        fs::write(scratch.root.join("b.lith"), "b").expect("file");
        fs::write(scratch.root.join("a.lith"), "a").expect("file");
        let listed = answer(&format!(
            "{{\"command\":\"list\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        let names: Vec<String> = listed["result"]["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| entry["name"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(names, vec!["folder", "a.lith", "b.lith"]);
        assert_eq!(listed["result"]["entries"][0]["dir"], json!(true));
        assert_eq!(listed["result"]["entries"][1]["dir"], json!(false));
        assert_eq!(listed["result"]["parent"], json!(path_text(scratch.root.parent().expect("parent"))));
    }

    #[test]
    fn listing_what_is_not_a_directory_is_refused() {
        let scratch = Scratch::new("list-errors");
        let file = scratch.root.join("a.lith");
        fs::write(&file, "a").expect("file");
        let answer = answer(&format!(
            "{{\"command\":\"list\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&file))
        ));
        assert_eq!(answer["error"], json!("not-a-directory"));
    }

    #[test]
    fn the_startup_path_is_answered_and_absent_when_there_is_none() {
        let none = ask("{\"command\":\"startup\"}");
        assert_eq!(body_of(&none), "{\"ok\":true,\"result\":{\"path\":null}}");
        let path = Path::new("/home/a/notes.lith");
        let some = handle(&launcher_request("{\"command\":\"startup\"}"), DEFAULT_PORT, TEST_TOKEN, Some(path));
        assert_eq!(body_of(&some), "{\"ok\":true,\"result\":{\"path\":\"/home/a/notes.lith\"}}");
    }

    #[test]
    fn an_unknown_command_is_an_answer_rather_than_a_refusal() {
        let response = ask("{\"command\":\"open-file\"}");
        assert_eq!(response.status, 200);
        assert!(body_of(&response).contains("unknown-command"));
    }

    #[test]
    fn the_chooser_order_prefers_the_desktop_then_kde() {
        assert_eq!(first_picker(|name| name == "zenity" || name == "kdialog"), Some(("zenity", Picker::Zenity)));
        assert_eq!(first_picker(|name| name == "kdialog"), Some(("kdialog", Picker::Kdialog)));
        assert_eq!(first_picker(|name| name == "yad"), Some(("yad", Picker::Zenity)));
        assert_eq!(first_picker(|_| false), None);
    }

    #[test]
    fn a_zenity_open_asks_for_what_the_request_did() {
        let args = picker_args(Picker::Zenity, "zenity", "open", false, None, Some("/home/a"));
        assert!(args.contains(&"--file-selection".to_string()));
        assert!(args.contains(&"--filename=/home/a/".to_string()));
        assert!(args.iter().any(|arg| arg.starts_with("--file-filter=")));
        assert!(!args.contains(&"--multiple".to_string()));
        assert!(!args.contains(&"--save".to_string()));

        let many = picker_args(Picker::Zenity, "zenity", "open", true, None, None);
        assert!(many.contains(&"--multiple".to_string()));

        let save = picker_args(Picker::Zenity, "zenity", "save", false, Some("notes.lith"), Some("/home/a/"));
        assert!(save.contains(&"--save".to_string()));
        assert!(save.contains(&"--filename=/home/a/notes.lith".to_string()));
    }

    #[test]
    fn a_kdialog_save_asks_for_one_name() {
        let save = picker_args(Picker::Kdialog, "kdialog", "save", false, Some("notes.lith"), Some("/home/a"));
        assert_eq!(save[0], "--title");
        assert!(save.contains(&"--getsavefilename".to_string()));
        assert!(save.contains(&"/home/a/notes.lith".to_string()));
        assert!(!save.contains(&"--multiple".to_string()));

        let open = picker_args(Picker::Kdialog, "kdialog", "open", true, None, None);
        assert!(open.contains(&"--multiple".to_string()));
        assert!(open.contains(&"--separate-output".to_string()));
        assert!(open.contains(&"--getopenfilename".to_string()));
        // With no start directory, `:` is KDE's own word for the current one.
        assert!(open.contains(&":".to_string()));
    }

    #[test]
    fn the_choosers_output_is_read_one_path_per_line() {
        assert_eq!(pick_output("/a/one.lith\n/a/two.lith\n", true), vec!["/a/one.lith", "/a/two.lith"]);
        assert_eq!(pick_output("\n/a/one.lith\n\n", false), vec!["/a/one.lith"]);
        // A save asks for one, so a chooser that printed more is trimmed rather than trusted.
        assert_eq!(pick_output("/a/one.lith\n/a/two.lith\n", false), vec!["/a/one.lith"]);
        assert_eq!(pick_output("   \n", false), Vec::<String>::new());
    }

    /// A Lith is a document, so the cap has to be a document's size rather than a liveness
    /// probe's. Checked by the compiler rather than by a test that could be skipped.
    const _: () = assert!(
        MAX_BODY_BYTES >= 32 * 1024 * 1024,
        "the body cap cannot carry a large Lith"
    );

    #[test]
    fn the_body_cap_still_refuses_what_is_past_it() {
        assert!(!body_is_oversized(MAX_BODY_BYTES));
        assert!(body_is_oversized(MAX_BODY_BYTES + 1));
    }
}
