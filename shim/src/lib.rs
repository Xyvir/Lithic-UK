//! The Lithic shim: the launcher and the wiki engine, served to the browser the
//! machine already has.
//!
//! Why this binary exists next to `src-tauri` rather than inside it. The Tauri
//! build links GTK and WebKitGTK, so the AppImage it produces carries a second
//! web engine (about 43.5 MB of an 82 MB download) that every Linux desktop
//! already has a browser for. This crate links nothing but the standard library:
//! it answers HTTP on loopback for a handful of local files and hands the address
//! to the system browser, in an app window of its own where the machine has a
//! Chromium-family browser and in an ordinary tab otherwise. That is the entire
//! artifact, so it is the size of the
//! payload rather than the size of the engine.
//!
//! What makes that honest rather than a stripped-down webapp. A page opened from
//! a local server has no File System Access API everywhere (Firefox and Safari
//! have none), and no Tauri bridge, so the save path the launcher would normally
//! take does not exist. The launcher already knows how to live without one, and
//! which of the two answers the page gets is the platform's rather than the
//! shim's: on Chromium the declaration changes nothing and a mounted Lith is a
//! real file written in place, while a browser with no API keeps every mounted
//! Lith in IndexedDB, page text and all. What the shim has to declare is the other
//! thing the address cannot say: the served document is `lithic-browser-only`
//! (`mode.ts`, `declaresBrowserOnly`), so a loopback origin resolves to `webapp`
//! rather than to the instance the machine rules would read it as. That is why the
//! server is the one to add it, since the launcher file cannot declare what it is,
//! only its server can. So [`inject_browser_only_meta`] puts that meta tag into the
//! launcher as it is served, and nothing on disk changes.
//!
//! Two consequences of browser storage are built into the serving model rather
//! than left to chance, because both silently lose a person's wiki:
//!
//!   * IndexedDB is scoped to an origin, which includes the port. A server on a
//!     different port is a different storage bucket, so a random port per launch
//!     would open a launcher with none of the saved Liths in it. Hence a fixed
//!     [`DEFAULT_PORT`], a probe for a shim that is already running, and
//!     [`loopback_alias`]: `localhost:5484` and `127.0.0.1:5484` are two origins
//!     too, so the served page redirects the `localhost` spelling to the address
//!     the shim opens.
//!   * A page that is never installed is evictable storage. Serving the manifest
//!     and the service worker is what makes the shim's address installable as an
//!     app, which is the one path from "a browser tab" to durable storage.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The meta tag the launcher reads to decide it is a browser mount rather than an
/// instance. It says nothing about where saves land: that is the platform's answer.
/// The name is `BROWSER_ONLY_META` in `launcher-ui/src/mode.ts`, and the two have
/// to agree, so a change there is a change here.
pub const BROWSER_ONLY_META_NAME: &str = "lithic-browser-only";

/// The port a shim listens on unless it is told otherwise.
///
/// Fixed, not ephemeral, because the port is part of the storage origin: an
/// OS-assigned port would give every launch a fresh empty IndexedDB. Low enough
/// to stay clear of the Linux ephemeral range (32768 and up), where a random
/// outgoing connection could otherwise hold it.
pub const DEFAULT_PORT: u16 = 5484;

/// Environment override for [`DEFAULT_PORT`].
pub const PORT_ENV: &str = "LITHIC_SHIM_PORT";
/// Environment override for the payload directory, used by tests and by a run
/// from a layout that is neither the AppImage nor the repository.
pub const ROOT_ENV: &str = "LITHIC_SHIM_ROOT";
/// Set by the AppImage runtime to the mount directory containing `usr/`.
pub const APPDIR_ENV: &str = "APPDIR";

/// The window class an app window advertises, which is what a desktop entry's
/// `StartupWMClass` matches so the dock shows Lithic's own icon and groups the
/// window with the launcher instead of with a generic browser. The entry the
/// AppImage build writes names the same string, and a test holds the two
/// together because they live in files that cannot see each other.
pub const APP_WINDOW_CLASS: &str = "Lithic";

/// Environment override naming the Chromium-family program to open the app
/// window with, for a build under a name the list does not carry. Pointing it at
/// a program that is not Chromium family is a mistake this cannot detect: the
/// app-window flags go to whatever it names.
pub const BROWSER_ENV: &str = "LITHIC_SHIM_BROWSER";

/// Environment override for the private profile an app window uses.
pub const PROFILE_ENV: &str = "LITHIC_SHIM_PROFILE";

/// Every response carries this header, and the value is what a second launch
/// proves before deciding that the port is already a shim of its own.
pub const SHIM_MARKER_HEADER: &str = "x-lithic-shim";
pub const SHIM_MARKER_VALUE: &str = "1";
/// The one path that is not a file. Used as the liveness probe.
pub const PROBE_PATH: &str = "/__lithic";
/// The host the shim both binds and opens, never `localhost`. See [`loopback_alias`].
pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Files without which the payload is not a launcher. Checked before the port is
/// bound so a broken layout fails with a list rather than with half a page.
pub const REQUIRED_PAYLOAD: [&str; 5] = [
    "index.html",
    "manifest.json",
    "offline-service-worker.js",
    "src/launcher.html",
    "src/lithic.html",
];

/// Files that dress the page rather than drive it: a missing icon is a 404 in a
/// console nobody reads, not a broken launcher.
const OPTIONAL_PAYLOAD: [&str; 6] = [
    "favicon.ico",
    "apple-touch-icon.png",
    "android-chrome-192x192.png",
    "android-chrome-512x512.png",
    "src/app-icon.png",
    "src/mstile-150x150.png",
];

/// A request head longer than this is a client that is not a browser. Read and
/// dropped rather than buffered without limit.
const MAX_HEAD_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// Payload discovery
// ---------------------------------------------------------------------------

/// Where the served files are, searched in the order that matters.
///
/// Every candidate below is a real layout rather than a guess:
///
///   1. `LITHIC_SHIM_ROOT`, so a test or a wrapper can point anywhere.
///   2. `$APPDIR/usr/share/lithic`, the AppImage's own layout, where the runtime
///      has already told us the mount directory.
///   3. `../share/lithic` beside the executable, the same layout reached through
///      `/proc/self/exe` when `$APPDIR` is absent.
///   4. `payload` beside the executable, for an unpacked tarball dropped next to
///      the binary.
///   5. Any ancestor of the executable's directory that holds `src/launcher.html`.
///      This is the repository checkout, which is why the shim runs from
///      `cargo run` with no setup at all: the root of this repo already carries
///      the launcher, the engine, the manifest and the service worker.
pub fn default_payload_root(
    exe_dir: &Path,
    appdir: Option<&Path>,
    override_root: Option<PathBuf>,
) -> Option<PathBuf> {
    // An explicit root is an answer, not a preference. `LITHIC_SHIM_ROOT` and
    // `--root` are how a build or a wrapper points the shim at a directory of its
    // own, and a directory that is not a payload has to be reported rather than
    // quietly losing to the checkout the executable happens to sit under.
    if let Some(root) = override_root {
        return payload_problems(&root).is_empty().then(|| normalize(&root));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(appdir) = appdir {
        candidates.push(appdir.join("usr/share/lithic"));
    }
    candidates.push(exe_dir.join("../share/lithic"));
    candidates.push(exe_dir.join("payload"));

    let mut ancestor = Some(exe_dir);
    for _ in 0..5 {
        let Some(dir) = ancestor else { break };
        candidates.push(dir.to_path_buf());
        ancestor = dir.parent();
    }

    candidates
        .into_iter()
        .find(|candidate| payload_problems(candidate).is_empty())
        .map(|candidate| normalize(&candidate))
}

/// Collapse `.` and `..` without touching the filesystem, so the directory the
/// shim reports is the one a person would have typed. `canonicalize` would also
/// resolve it, at the cost of the `\\?\` verbatim prefix it puts on a Windows
/// path, which reads as noise in a status line.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The payload files that are missing, empty when the directory is servable.
pub fn payload_problems(root: &Path) -> Vec<String> {
    REQUIRED_PAYLOAD
        .iter()
        .filter(|relative| !root.join(relative).is_file())
        .map(|relative| (*relative).to_string())
        .collect()
}

/// The payload files that are absent but survivable.
pub fn payload_warnings(root: &Path) -> Vec<String> {
    OPTIONAL_PAYLOAD
        .iter()
        .filter(|relative| !root.join(relative).is_file())
        .map(|relative| (*relative).to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// The browser-only declaration
// ---------------------------------------------------------------------------

/// Insert the browser-only meta tag into a launcher document.
///
/// The insertion point is the document's own `</head>`, which sounds trivial and
/// is not: the built launcher inlines its whole runtime as one script element
/// inside the head, and that script's HTML helpers contain `</head>`,
/// `<script` and `<style` as string literals (it writes documents of its own).
/// The four occurrences of `</head>` in `src/launcher.html` are one real tag and
/// three inside that script, and the real one is the last of them. A plain
/// `find("</head>")` would therefore put the meta tag in the middle of a script,
/// where a browser reads it as JavaScript and the launcher never sees it.
///
/// So the scan walks the document the way a parser does: a `<script>` or
/// `<style>` body is raw text that ends at its own closing tag, a comment ends at
/// `-->`, and none of them can contain the head's close. The lowercased copy is
/// byte-for-byte the same length as the original (only ASCII case changes), so an
/// offset found in one is an offset in the other.
pub fn inject_browser_only_meta(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if declares_browser_only(&lower) {
        return html.to_string();
    }
    let Some(at) = injection_offset(&lower) else {
        return html.to_string();
    };
    let mut out = String::with_capacity(html.len() + 64);
    out.push_str(&html[..at]);
    out.push_str(&meta_tag());
    out.push_str(&html[at..]);
    out
}

/// The tag itself, in the empty-element style the launcher's own head uses.
pub fn meta_tag() -> String {
    format!("<meta name=\"{BROWSER_ONLY_META_NAME}\" content=\"1\" />")
}

/// Whether a document already declares browser-only. Takes the lowercased form.
pub fn declares_browser_only(lowercased_html: &str) -> bool {
    let name = BROWSER_ONLY_META_NAME;
    lowercased_html.contains(&format!("name=\"{name}\""))
        || lowercased_html.contains(&format!("name='{name}'"))
        || lowercased_html.contains(&format!("name={name}"))
}

/// Where to put the tag: before the head's close, or before the body's open if
/// the document has no head of its own. `None` for a fragment with neither, and
/// the caller then serves the file untouched rather than guessing a position
/// ahead of the doctype, which would flip the document into quirks mode.
fn injection_offset(lower: &str) -> Option<usize> {
    if let Some(at) = head_close_offset(lower) {
        return Some(at);
    }
    for opener in ["<body", "<html"] {
        if let Some(open) = find_tag(lower, opener, 0) {
            if let Some(after) = after_tag_end(lower, open) {
                return Some(after);
            }
        }
    }
    None
}

/// Offset of the `</head>` that closes the document's own head.
fn head_close_offset(lower: &str) -> Option<usize> {
    let mut cursor = match find_tag(lower, "<head", 0) {
        Some(open) => after_tag_end(lower, open)?,
        None => 0,
    };

    while cursor < lower.len() {
        // The earliest of the three things that can hide a `</head>` from a
        // plain search, and the close itself.
        let candidates = [
            (lower[cursor..].find("</head>").map(|i| cursor + i), 0u8),
            (lower[cursor..].find("<!--").map(|i| cursor + i), 1),
            (lower[cursor..].find("<script").map(|i| cursor + i), 2),
            (lower[cursor..].find("<style").map(|i| cursor + i), 3),
        ];
        let mut next: Option<(usize, u8)> = None;
        for (at, kind) in candidates {
            let Some(at) = at else { continue };
            if next.is_none_or(|(best, _)| at < best) {
                next = Some((at, kind));
            }
        }
        let (at, kind) = next?;
        cursor = match kind {
            // The head's close.
            0 => return Some(at),
            // Past the comment.
            1 => skip_to(lower, at + 4, "-->")?,
            // Past the script element, whose body cannot contain the close.
            2 => after_tag_end(lower, skip_to(lower, at + 7, "</script")?)?,
            // The same for a style element.
            _ => after_tag_end(lower, skip_to(lower, at + 6, "</style")?)?,
        };
    }
    None
}

/// Offset of `<name` at or after `from`, only when it is a tag rather than the
/// start of a longer word (`<head` is not `<header`).
fn find_tag(lower: &str, name: &str, from: usize) -> Option<usize> {
    let mut search = from;
    while let Some(relative) = lower[search..].find(name) {
        let at = search + relative;
        let next = lower[at + name.len()..].chars().next();
        if next.is_none_or(|character| character == '>' || character.is_whitespace() || character == '/') {
            return Some(at);
        }
        search = at + name.len();
    }
    None
}

/// Offset just past the `>` that closes the tag starting at `from`.
fn after_tag_end(lower: &str, from: usize) -> Option<usize> {
    lower[from..].find('>').map(|relative| from + relative + 1)
}

/// Offset just past `marker`, searching from `from`.
fn skip_to(lower: &str, from: usize, marker: &str) -> Option<usize> {
    if from > lower.len() {
        return None;
    }
    lower[from..].find(marker).map(|relative| from + relative + marker.len())
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub host: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    fn plain(status: u16, reason: &'static str, message: &str, cache: &str) -> Self {
        Response {
            status,
            reason,
            headers: vec![
                ("content-type".to_string(), "text/plain; charset=utf-8".to_string()),
                ("cache-control".to_string(), cache.to_string()),
                ("x-content-type-options".to_string(), "nosniff".to_string()),
            ],
            body: message.as_bytes().to_vec(),
        }
    }

    /// The whole response as bytes, with `head_only` dropping the body.
    pub fn bytes(&self, head_only: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.body.len() + 256);
        out.extend_from_slice(format!("HTTP/1.1 {} {}\r\n", self.status, self.reason).as_bytes());
        for (name, value) in &self.headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(format!("content-length: {}\r\n", self.body.len()).as_bytes());
        out.extend_from_slice(format!("{SHIM_MARKER_HEADER}: {SHIM_MARKER_VALUE}\r\n").as_bytes());
        // One request per connection: a page load opens several at once, a
        // thread per connection serves them, and nothing has to track keep-alive.
        out.extend_from_slice(b"connection: close\r\n\r\n");
        if !head_only {
            out.extend_from_slice(&self.body);
        }
        out
    }
}

/// Parse a request head (the request line and the headers, ending at a blank
/// line). Only the three fields the shim acts on are kept.
pub fn parse_request(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n").flat_map(|line| line.split('\n'));
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.0");
    if !version.starts_with("HTTP/") {
        return None;
    }
    let mut host = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("host") {
                host = Some(value.trim().to_string());
            }
        }
    }
    Some(Request { method, target, host })
}

/// Turn a request into a response. `root_canonical` is the payload directory
/// already resolved, so the traversal check below is a prefix test on resolved
/// paths rather than a string comparison of what the client sent.
pub fn handle(request: &Request, root: &Path, root_canonical: &Path, port: u16) -> Response {
    if request.method != "GET" && request.method != "HEAD" {
        return Response::plain(405, "Method Not Allowed", "The shim serves GET and HEAD.\n", "no-store");
    }

    let raw_target = request.target.as_str();
    let raw_path = raw_target.split(['?', '#']).next().unwrap_or(raw_target);
    let Some(path) = percent_decode(raw_path) else {
        return Response::plain(400, "Bad Request", "The request target is not readable.\n", "no-store");
    };

    if path == PROBE_PATH {
        let body = format!(
            "{{\"shim\":true,\"version\":\"{}\",\"port\":{port}}}",
            env!("CARGO_PKG_VERSION")
        );
        return Response {
            status: 200,
            reason: "OK",
            headers: vec![
                ("content-type".to_string(), "application/json; charset=utf-8".to_string()),
                ("cache-control".to_string(), "no-store".to_string()),
                ("x-content-type-options".to_string(), "nosniff".to_string()),
            ],
            body: body.into_bytes(),
        };
    }

    // The other spelling of this machine is a different storage origin, so a page
    // reached through it is sent to the address the shim opens. Without this, a
    // person who types `localhost` once would find an empty launcher and conclude
    // the saves were lost.
    if let Some(alias) = request.host.as_deref().and_then(loopback_alias) {
        let location = format!("http://{LOOPBACK_HOST}:{port}{raw_target}");
        return Response::plain(
            302,
            "Found",
            &format!(
                "This shim keeps browser storage per origin, and `{alias}` is not the origin it opened.\n\
                 Continue at {location} to reach the same saves.\n"
            ),
            "no-store",
        )
        .located(&location);
    }

    let relative = path.trim_start_matches('/');
    let mut candidate = root.join(relative);
    if relative.is_empty() || path.ends_with('/') {
        candidate = candidate.join("index.html");
    }
    let Ok(file) = candidate.canonicalize() else {
        return not_found();
    };
    if !file.starts_with(root_canonical) || !file.is_file() {
        return not_found();
    }
    let Ok(mut body) = fs::read(&file) else {
        return Response::plain(500, "Internal Server Error", "The shim could not read that file.\n", "no-store");
    };

    let is_launcher = file.file_name().and_then(|name| name.to_str()) == Some("launcher.html");
    if is_launcher {
        match String::from_utf8(body) {
            Ok(text) => body = inject_browser_only_meta(&text).into_bytes(),
            Err(error) => body = error.into_bytes(),
        }
    }

    let cache = cache_control_for(&file);
    Response {
        status: 200,
        reason: "OK",
        headers: vec![
            ("content-type".to_string(), content_type_for(&file).to_string()),
            ("cache-control".to_string(), cache.to_string()),
            ("x-content-type-options".to_string(), "nosniff".to_string()),
        ],
        body,
    }
}

impl Response {
    /// Add a `location` header, for the alias redirect.
    fn located(mut self, location: &str) -> Self {
        self.headers.push(("location".to_string(), location.to_string()));
        self
    }
}

fn not_found() -> Response {
    Response::plain(404, "Not Found", "The shim serves only the launcher and its files.\n", "no-store")
}

/// The host names that mean this machine but are not the origin the shim uses.
pub fn loopback_alias(host: &str) -> Option<&'static str> {
    let trimmed = host.trim();
    if trimmed.eq_ignore_ascii_case("::1") {
        return Some("[::1]");
    }
    let name = match trimmed.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => trimmed.split(':').next().unwrap_or(trimmed),
    };
    if name.eq_ignore_ascii_case("localhost") {
        return Some("localhost");
    }
    if name == "::1" {
        return Some("[::1]");
    }
    None
}

/// Percent-decode a request target. `None` for malformed escapes, for a NUL, or
/// for anything that is not valid UTF-8. A `+` stays a plus: that is a query
/// string convention, and a path is not a query string.
pub fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_string());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = input.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    if out.contains(&0) {
        return None;
    }
    String::from_utf8(out).ok()
}

pub fn content_type_for(path: &Path) -> &'static str {
    match extension_of(path).as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "lith" | "tid" => "text/plain; charset=utf-8",
        "gz" => "application/gzip",
        "zip" => "application/zip",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Document and script responses are `no-store` so a newer shim takes effect on
/// the next load rather than the next cache eviction. Images may be cached: they
/// change only when the app icon does.
fn cache_control_for(path: &Path) -> &'static str {
    match extension_of(path).as_str() {
        "png" | "ico" | "jpg" | "jpeg" | "svg" | "woff2" => "public, max-age=86400",
        _ => "no-store",
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/// The address the shim opens, and the one it tells everyone else to use.
pub fn url_for(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}/")
}

/// Bind the loopback address the shim serves on.
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
}

/// Accept connections forever, one thread each.
pub fn serve(listener: TcpListener, root: PathBuf, port: u16) -> std::io::Result<()> {
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.clone());
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        let root = root.clone();
        let root_canonical = root_canonical.clone();
        std::thread::spawn(move || {
            if let Err(error) = handle_connection(stream, &root, &root_canonical, port) {
                eprintln!("shim: a connection failed: {error}");
            }
        });
    }
    Ok(())
}

fn handle_connection(stream: TcpStream, root: &Path, root_canonical: &Path, port: u16) -> std::io::Result<()> {
    // A client that connects and says nothing must not hold a thread open.
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let head = read_head(&mut reader)?;
    let request = parse_request(&head);
    let response = match &request {
        Some(request) => handle(request, root, root_canonical, port),
        None => Response::plain(400, "Bad Request", "The request head is not readable.\n", "no-store"),
    };
    let head_only = matches!(&request, Some(request) if request.method == "HEAD");
    let mut writer = stream;
    writer.write_all(&response.bytes(head_only))?;
    writer.flush()
}

fn read_head(reader: &mut impl BufRead) -> std::io::Result<String> {
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 || line == b"\r\n" || line == b"\n" {
            break;
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD_BYTES {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

/// Whether a shim of ours is already answering on the port.
///
/// A second launch should not start a second server on another port (that would
/// be a second storage origin), and it should not fail either: it opens the shim
/// that is already running. The marker header is what makes that answer certain
/// rather than a guess about some other program's port.
pub fn probe_existing_shim(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(600)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let request = format!("GET {PROBE_PATH} HTTP/1.1\r\nhost: {LOOPBACK_HOST}\r\nconnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut answer = String::new();
    if stream.take(8 * 1024).read_to_string(&mut answer).is_err() {
        return false;
    }
    answer
        .to_ascii_lowercase()
        .contains(&format!("{SHIM_MARKER_HEADER}: {SHIM_MARKER_VALUE}"))
}

/// Hand the address to the browser the machine already has.
///
/// Chromium family first, because it is the only family that can be asked for an
/// app window: `--app` draws the page with no tab strip and no URL bar, and the
/// window gets a profile of the shim's own so nothing else ever writes to this
/// origin's storage. Firefox has no equivalent (`--kiosk` is fullscreen, which is
/// a different thing), and stock Ubuntu ships Firefox alone, so that desktop gets
/// an ordinary tab. `None` means nothing answered at all.
pub fn open_in_browser(url: &str) -> Option<BrowserLaunch> {
    #[cfg(target_os = "linux")]
    if let Some(launch) = open_chromium_app_window(url) {
        return Some(launch);
    }
    open_the_ordinary_way(url).then_some(BrowserLaunch::Tab)
}

/// What answered when the address was handed over.
///
/// `AppWindow` is the good rung, and it names the program that took it. `Tab` is
/// what every other desktop gets: the address in an ordinary browser tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserLaunch {
    AppWindow(String),
    Tab,
}

/// Chromium-family programs, in the order a machine is likely to have one. The
/// distribution's own packages come first, because the shim ships to Linux and
/// `chromium` is what apt installs.
#[cfg(any(target_os = "linux", test))]
const CHROMIUM_PROGRAMS: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "vivaldi",
    "opera",
];

/// Whether a program name is on `PATH`.
#[cfg(any(target_os = "linux", test))]
fn program_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// The first Chromium-family program a lookup finds, or none.
///
/// The lookup is a parameter rather than a call to [`program_on_path`] so the
/// order, which is the whole of the rule here, can be pinned without a PATH.
#[cfg(any(target_os = "linux", test))]
fn first_chromium(lookup: impl Fn(&str) -> bool) -> Option<&'static str> {
    CHROMIUM_PROGRAMS.iter().copied().find(|&program| lookup(program))
}

/// The private profile an app window is given.
///
/// A directory of its own rather than the person's everyday profile, because
/// browser storage is scoped to the profile as well as to the origin: this way
/// nothing else ever writes to this origin's storage, and clearing a browsing
/// session elsewhere cannot clear a Lith. Stable across launches for the same
/// reason the port is.
#[cfg(any(target_os = "linux", test))]
fn app_profile_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(PROFILE_ENV) {
        return Some(PathBuf::from(explicit));
    }
    let base = match std::env::var_os("XDG_DATA_HOME") {
        Some(data_home) => PathBuf::from(data_home),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".local").join("share"),
    };
    Some(base.join("lithic").join("chrome"))
}

/// The flags that turn a Chromium launch into an app window.
///
/// `--app` removes the tab strip, the URL bar and the browser's own chrome.
/// `--user-data-dir` is the private profile above, left off entirely when that
/// directory cannot be created, so the window is still an app window with the
/// browser's own profile rather than no window at all. `--class` is what a
/// desktop entry's `StartupWMClass` matches. The two `no-` flags are for that
/// profile's first launch, which would otherwise open a first-run page and a
/// default-browser question on top of the launcher.
#[cfg(any(target_os = "linux", test))]
fn app_window_args(url: &str, profile: Option<&Path>) -> Vec<String> {
    let mut args = vec![format!("--app={url}")];
    if let Some(profile) = profile {
        args.push(format!("--user-data-dir={}", profile.display()));
    }
    args.push(format!("--class={APP_WINDOW_CLASS}"));
    args.push("--no-first-run".to_string());
    args.push("--no-default-browser-check".to_string());
    args
}

#[cfg(target_os = "linux")]
fn open_chromium_app_window(url: &str) -> Option<BrowserLaunch> {
    let program = match std::env::var(BROWSER_ENV) {
        Ok(name) if !name.trim().is_empty() => name,
        _ => first_chromium(program_on_path)?.to_string(),
    };
    // A profile that cannot be created is not passed, so the app window still
    // opens with the browser's own profile. A confined browser (Chromium's snap
    // cannot write a dot-directory under `$HOME`) would otherwise refuse to start,
    // and losing the window is worse than losing the profile.
    let profile = app_profile_dir().filter(|dir| fs::create_dir_all(dir).is_ok());
    let args = app_window_args(url, profile.as_deref());
    Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
        .then_some(BrowserLaunch::AppWindow(program))
}

/// The machine's own way of handing over an address: `xdg-open` and its
/// equivalents elsewhere. A normal tab, which is what a desktop with no
/// Chromium-family browser gets.
fn open_the_ordinary_way(url: &str) -> bool {
    #[cfg(target_os = "linux")]
    let candidates: [(&str, &[&str]); 3] = [
        ("xdg-open", &[url]),
        ("gio", &["open", url]),
        ("sensible-browser", &[url]),
    ];
    #[cfg(target_os = "macos")]
    let candidates: [(&str, &[&str]); 1] = [("open", &[url])];
    #[cfg(target_os = "windows")]
    let candidates: [(&str, &[&str]); 1] = [("cmd", &["/C", "start", "", url])];
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let candidates: [(&str, &[&str]); 0] = [];

    candidates.iter().any(|(program, arguments)| {
        Command::new(program)
            .args(*arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A payload directory of its own, removed when the test ends.
    ///
    /// The payload sits one level down from the directory the test owns, so the
    /// traversal tests have a real file above the payload root to fail to reach.
    struct Payload {
        root: PathBuf,
        parent: PathBuf,
    }

    impl Payload {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let parent = std::env::temp_dir().join(format!("lithic-shim-{label}-{}-{unique}", std::process::id()));
            let _ = fs::remove_dir_all(&parent);
            let root = parent.join("payload");
            fs::create_dir_all(root.join("src")).expect("payload directory");
            for (path, contents) in [
                ("index.html", "<html><head></head><body>redirect</body></html>"),
                ("manifest.json", "{\"name\":\"Lithic\"}"),
                ("offline-service-worker.js", "const VERSION = '0.0.0'"),
                ("src/launcher.html", "<html><head><title>Launcher</title></head><body></body></html>"),
                ("src/lithic.html", "<html><head></head><body>engine</body></html>"),
                ("src/app-icon.png", "png"),
            ] {
                fs::write(root.join(path), contents).expect("payload file");
            }
            Payload { root, parent }
        }

        fn request(&self, target: &str) -> Response {
            let canonical = self.root.canonicalize().expect("canonical payload");
            handle(
                &parse_request(&format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).expect("parsed request"),
                &self.root,
                &canonical,
                DEFAULT_PORT,
            )
        }
    }

    impl Drop for Payload {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.parent);
        }
    }

    fn body_of(response: &Response) -> String {
        String::from_utf8_lossy(&response.body).into_owned()
    }

    /// The invariant the injected tag has to satisfy, checked without repeating
    /// the scan that placed it: one insertion, nothing else changed, and the tag
    /// sitting after every raw text element has closed and before the body.
    ///
    /// A plain `find("</head>")` fails the third of those on both documents
    /// below, which is the whole reason this rule exists.
    fn assert_inserted_at_the_top_of_the_head(html: &str, injected: &str) -> usize {
        let at = injected.find(&meta_tag()).expect("the tag was inserted");
        let lower = html.to_ascii_lowercase();
        assert_eq!(injected.matches(meta_tag().as_str()).count(), 1, "the tag was inserted more than once");
        assert_eq!(injected.replace(meta_tag().as_str(), ""), html, "the document changed beyond the insertion");
        assert!(
            injected[at + meta_tag().len()..].to_ascii_lowercase().starts_with("</head>"),
            "the tag does not sit immediately before the head's close"
        );
        assert!(
            lower.find("<head").is_some_and(|open| open < at),
            "the tag landed before the head"
        );
        assert!(
            lower.find("<body").is_none_or(|body| at < body),
            "the tag landed after the body had started"
        );
        for element in ["</script", "</style"] {
            if let Some(last) = lower.rfind(element) {
                assert!(last < at, "the tag landed inside {element}");
            }
        }
        at
    }

    /// The port has to stay out of the ephemeral range, where a random outgoing
    /// connection could take it and leave the shim unable to reach its own
    /// storage origin. Checked by the compiler, not by a test that can be skipped.
    const _: () = assert!(
        DEFAULT_PORT < 32768,
        "a port in the ephemeral range can be taken by an outgoing connection"
    );

    #[test]
    fn the_payload_check_names_what_is_missing() {
        let payload = Payload::new("problems");
        assert!(payload_problems(&payload.root).is_empty());
        fs::remove_file(payload.root.join("src/lithic.html")).expect("remove engine");
        assert_eq!(payload_problems(&payload.root), vec!["src/lithic.html".to_string()]);
    }

    #[test]
    fn the_repository_root_is_a_payload_of_its_own() {
        // The layout the shim discovers by walking up from the executable, and
        // the only reason `cargo run` works with no setup.
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        assert!(
            payload_problems(&repo_root).is_empty(),
            "missing from the repository root: {:?}",
            payload_problems(&repo_root)
        );
    }

    #[test]
    fn an_environment_root_wins_over_the_layout() {
        let payload = Payload::new("override");
        let exe_dir = payload.root.join("bin");
        fs::create_dir_all(&exe_dir).expect("exe directory");
        let found = default_payload_root(&exe_dir, None, Some(payload.root.clone()));
        assert_eq!(found, Some(payload.root.clone()));
    }

    #[test]
    fn an_explicit_root_is_an_answer_rather_than_a_preference() {
        let payload = Payload::new("explicit");
        let incomplete = payload.parent.join("incomplete");
        fs::create_dir_all(incomplete.join("src")).expect("directory");
        // The repository root is a payload, so a fall-through would find it.
        let exe_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        assert_eq!(
            default_payload_root(&exe_dir, None, Some(incomplete)),
            None,
            "an incomplete explicit root fell through to another payload"
        );
        assert_eq!(
            default_payload_root(&exe_dir, None, Some(payload.root.clone())),
            Some(payload.root.clone())
        );
    }

    #[test]
    fn the_appimage_layout_is_found_from_the_executable() {
        let appdir = Payload::new("appimage");
        let exe_dir = appdir.root.join("usr/bin");
        fs::create_dir_all(&exe_dir).expect("exe directory");
        let payload_dir = appdir.root.join("usr/share/lithic");
        fs::create_dir_all(payload_dir.join("src")).expect("payload directory");
        for relative in REQUIRED_PAYLOAD {
            fs::write(payload_dir.join(relative), "x").expect("payload file");
        }
        let found = default_payload_root(&exe_dir, None, None);
        assert_eq!(found, Some(appdir.root.join("usr/share/lithic")));
    }

    #[test]
    fn the_launcher_is_served_with_the_declaration_and_the_engine_without_it() {
        let payload = Payload::new("declaration");
        let launcher = payload.request("/src/launcher.html");
        assert_eq!(launcher.status, 200);
        assert!(body_of(&launcher).contains(&meta_tag()));
        assert!(declares_browser_only(&body_of(&launcher).to_ascii_lowercase()));

        let engine = payload.request("/src/lithic.html");
        assert_eq!(engine.status, 200);
        assert!(!body_of(&engine).contains(BROWSER_ONLY_META_NAME));
    }

    #[test]
    fn the_root_serves_the_redirect_page() {
        let payload = Payload::new("root");
        assert_eq!(payload.request("/").status, 200);
        assert!(body_of(&payload.request("/")).contains("redirect"));
    }

    #[test]
    fn a_missing_file_is_a_404_with_a_body() {
        let payload = Payload::new("missing");
        let response = payload.request("/nope.html");
        assert_eq!(response.status, 404);
        assert!(!response.body.is_empty());
    }

    #[test]
    fn a_path_above_the_payload_is_refused() {
        let payload = Payload::new("traversal");
        // A real file, one level above the payload root, that must stay out of
        // reach no matter how the request spells its way up there.
        let secret = payload.parent.join("secret.txt");
        fs::write(&secret, "should not be served").expect("secret");
        assert!(secret.is_file());
        for target in ["/../secret.txt", "/%2e%2e/secret.txt", "/src/../../secret.txt", "//etc/passwd"] {
            let response = payload.request(target);
            assert_eq!(response.status, 404, "{target} was served");
            assert!(!body_of(&response).contains("should not be served"), "{target} read the file above");
        }
    }

    #[test]
    fn a_query_string_does_not_change_which_file_is_served() {
        let payload = Payload::new("query");
        let response = payload.request("/src/launcher.html?storage=file&mode=webapp");
        assert_eq!(response.status, 200);
        assert!(body_of(&response).contains("Launcher"));
    }

    #[test]
    fn localhost_is_sent_to_the_origin_the_shim_opened() {
        let payload = Payload::new("alias");
        let canonical = payload.root.canonicalize().expect("canonical payload");
        for host in ["localhost", "localhost:5484", "LOCALHOST:5484", "[::1]:5484"] {
            let request = parse_request(&format!("GET /src/launcher.html?x=1 HTTP/1.1\r\nHost: {host}\r\n\r\n"))
                .expect("parsed request");
            let response = handle(&request, &payload.root, &canonical, DEFAULT_PORT);
            assert_eq!(response.status, 302, "{host} was served directly");
            let location = response
                .headers
                .iter()
                .find(|(name, _)| name == "location")
                .map(|(_, value)| value.clone());
            assert_eq!(location.as_deref(), Some("http://127.0.0.1:5484/src/launcher.html?x=1"));
        }
        assert_eq!(loopback_alias("127.0.0.1:5484"), None);
        assert_eq!(loopback_alias("lithic.local:5484"), None);
    }

    #[test]
    fn only_get_and_head_are_served() {
        let payload = Payload::new("methods");
        let canonical = payload.root.canonicalize().expect("canonical payload");
        let request = parse_request("DELETE /src/launcher.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").expect("request");
        assert_eq!(handle(&request, &payload.root, &canonical, DEFAULT_PORT).status, 405);
        let head = parse_request("HEAD /src/launcher.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").expect("request");
        let response = handle(&head, &payload.root, &canonical, DEFAULT_PORT);
        assert_eq!(response.status, 200);
        let bytes = response.bytes(true);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("content-length:"), "a HEAD still reports the length");
        assert!(!text.contains("<html"), "a HEAD carries no body");
    }

    #[test]
    fn the_probe_endpoint_answers_without_touching_the_payload() {
        let payload = Payload::new("probe");
        let response = payload.request(PROBE_PATH);
        assert_eq!(response.status, 200);
        assert!(body_of(&response).contains("\"shim\":true"));
        let bytes = String::from_utf8_lossy(&response.bytes(false)).to_ascii_lowercase();
        assert!(bytes.contains(&format!("{SHIM_MARKER_HEADER}: {SHIM_MARKER_VALUE}")));
    }

    #[test]
    fn a_head_close_inside_a_script_is_not_the_insertion_point() {
        let html = "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\" />\n<script>\n\
                    const close = `</head>`;\nconst open = `<script>`;\n</script>\n</head>\n<body>x</body>\n</html>\n";
        let injected = inject_browser_only_meta(html);
        let at = assert_inserted_at_the_top_of_the_head(html, &injected);
        assert_eq!(
            at,
            html.rfind("</head>").expect("a head close"),
            "the first `</head>` in the file is a string in the script, not the head's"
        );
        assert!(injected.contains("const close = `</head>`;"), "the script was altered");
    }

    #[test]
    fn a_head_close_inside_a_style_or_a_comment_is_not_the_insertion_point() {
        let html = "<html><head><style>/* </head> */</style><!-- </head> --></head><body></body></html>";
        let injected = inject_browser_only_meta(html);
        let at = injected.find(&meta_tag()).expect("the tag was inserted");
        assert!(injected[at + meta_tag().len()..].starts_with("</head>"));
        assert_eq!(injected.matches(meta_tag().as_str()).count(), 1);
    }

    #[test]
    fn injecting_twice_changes_nothing() {
        let html = "<html><head><title>t</title></head><body></body></html>";
        let once = inject_browser_only_meta(html);
        let twice = inject_browser_only_meta(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn a_document_without_a_head_still_gets_the_declaration() {
        let injected = inject_browser_only_meta("<html><body>fragment</body></html>");
        let at = injected.find(&meta_tag()).expect("the tag was inserted");
        assert!(injected[..at].ends_with("<body>"), "the tag belongs after the body's open tag");
        assert!(injected[at + meta_tag().len()..].starts_with("fragment"), "nothing was disturbed");
    }

    #[test]
    fn a_fragment_with_no_structure_is_left_alone() {
        let html = "just text";
        assert_eq!(inject_browser_only_meta(html), html);
    }

    #[test]
    fn the_built_launcher_is_declared_outside_every_script() {
        // The real artifact, which is what the insertion rule has to survive:
        // its inline runtime contains `</head>` three times before the head's own
        // close, so a plain search would put the tag inside JavaScript.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/launcher.html");
        let Ok(html) = fs::read_to_string(&path) else {
            panic!("src/launcher.html is missing, so this rule is untested");
        };
        let injected = inject_browser_only_meta(&html);
        assert_eq!(injected.len(), html.len() + meta_tag().len());
        assert_inserted_at_the_top_of_the_head(&html, &injected);
        assert!(html.matches("</head>").count() > 1, "the artifact stopped exercising the script case");
        assert_ne!(
            html.find("</head>"),
            html.rfind("</head>"),
            "the artifact no longer carries a `</head>` before the head's own, so this rule is untested"
        );
    }

    #[test]
    fn content_types_cover_what_the_payload_ships() {
        assert_eq!(content_type_for(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type_for(Path::new("a/manifest.json")), "application/json; charset=utf-8");
        assert_eq!(content_type_for(Path::new("a/sw.js")), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for(Path::new("a/icon.png")), "image/png");
        assert_eq!(content_type_for(Path::new("a/unknown.bin")), "application/octet-stream");
        assert_eq!(cache_control_for(Path::new("a/icon.png")), "public, max-age=86400");
        assert_eq!(cache_control_for(Path::new("a/launcher.html")), "no-store");
    }

    #[test]
    fn a_request_head_is_parsed_into_its_three_fields() {
        let request = parse_request("GET /src/launcher.html?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5484\r\nAccept: */*\r\n\r\n")
            .expect("parsed");
        assert_eq!(request.method, "GET");
        assert_eq!(request.target, "/src/launcher.html?x=1");
        assert_eq!(request.host.as_deref(), Some("127.0.0.1:5484"));
        assert!(parse_request("").is_none());
        assert!(parse_request("hello\r\n\r\n").is_none(), "not a request line");
        assert!(parse_request("GET\r\n\r\n").is_none(), "a method with no target");
    }

    #[test]
    fn percent_decoding_refuses_what_it_cannot_read() {
        assert_eq!(percent_decode("/a%20b.html").as_deref(), Some("/a b.html"));
        assert_eq!(percent_decode("/a+b.html").as_deref(), Some("/a+b.html"));
        assert_eq!(percent_decode("/%zz").as_deref(), None);
        assert_eq!(percent_decode("/%00").as_deref(), None);
    }

    #[test]
    fn the_chromium_search_prefers_the_distribution_packages() {
        // The order is the rule: a machine with several Chromium builds opens the
        // one the distribution installed, not whichever name a lookup happens to
        // hand back first.
        assert_eq!(
            first_chromium(|name| name == "chromium" || name == "google-chrome"),
            Some("chromium")
        );
        assert_eq!(first_chromium(|name| name == "opera"), Some("opera"));
        assert_eq!(first_chromium(|_| true), Some("chromium"));
        // A program the list does not carry is not a Chromium family answer, which
        // is why the fallback tab exists rather than any browser being guessed at.
        assert_eq!(first_chromium(|name| name == "chrome"), None);
        assert_eq!(first_chromium(|_| false), None);
    }

    #[test]
    fn a_program_that_is_not_installed_is_not_on_the_path() {
        assert!(!program_on_path("lithic-shim-definitely-not-a-real-program"));
    }

    #[test]
    fn the_app_profile_sits_under_the_data_home() {
        // The environment is read rather than written, so the shape is what is
        // pinned: the leaf names the browser, and the directory is absolute. A
        // `LITHIC_SHIM_PROFILE` in the environment is a person overriding it on
        // purpose, and the leaf assertion stands down there.
        let Some(profile) = app_profile_dir() else {
            // A machine with neither HOME nor XDG_DATA_HOME has no data home to
            // derive one from, which is exactly why an app window omits the flag.
            return;
        };
        assert!(profile.is_absolute(), "the profile has to be a real path: {}", profile.display());
        if std::env::var_os(PROFILE_ENV).is_none() {
            assert_eq!(profile.file_name().and_then(|name| name.to_str()), Some("chrome"));
        }
    }

    #[test]
    fn an_app_window_is_asked_for_by_name_and_class() {
        let profile = Path::new("/home/a/.local/share/lithic/chrome");
        let args = app_window_args("http://127.0.0.1:5484/", Some(profile));
        assert!(args.contains(&"--app=http://127.0.0.1:5484/".to_string()));
        assert!(args.contains(&format!("--user-data-dir={}", profile.display())));
        assert!(args.contains(&format!("--class={APP_WINDOW_CLASS}")));
        assert!(args.contains(&"--no-first-run".to_string()));
        assert!(args.contains(&"--no-default-browser-check".to_string()));
        // A profile that could not be created drops the flag and nothing else: the
        // window is still an app window, which is the part worth keeping.
        let without = app_window_args("http://127.0.0.1:5484/", None);
        assert!(!without.iter().any(|arg| arg.starts_with("--user-data-dir")));
        assert!(without.contains(&"--app=http://127.0.0.1:5484/".to_string()));
        assert!(without.contains(&format!("--class={APP_WINDOW_CLASS}")));
    }

    #[test]
    fn the_desktop_entry_groups_an_app_window_by_its_class() {
        // The class a Chromium app window advertises and the `StartupWMClass` a
        // desktop entry matches are the same string, or the dock draws a generic
        // browser's icon beside a Lithic window. The two live in files that cannot
        // see each other, so the agreement is pinned here.
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/build-shim-appimage.sh");
        let text = fs::read_to_string(&script).expect("the AppImage build script");
        assert!(
            text.contains(&format!("StartupWMClass={APP_WINDOW_CLASS}")),
            "the desktop entry does not name the app window's class"
        );
    }
}
