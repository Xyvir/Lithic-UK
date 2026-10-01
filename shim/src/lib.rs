//! The Lithic shim: the launcher and the wiki engine, served to the browser the
//! machine already has.
//!
//! Why this binary exists next to `src-tauri` rather than inside it. The Tauri
//! build links GTK and WebKitGTK, so the AppImage it produces carries a second
//! web engine (about 43.5 MB of an 82 MB download) that every Linux desktop
//! already has a browser for. This crate links no toolkit: `getrandom` for the
//! command wire's per-launch secret and `serde_json` for the wire itself are the
//! whole dependency list, and neither draws in a window. It answers HTTP on
//! loopback for a handful of local files and hands the address to the system
//! browser, in an app window of its own where the machine has a Chromium-family
//! browser and in an ordinary tab otherwise. That is the entire artifact, so it is
//! the size of the payload rather than the size of the engine.
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
//! only its server can. So [`inject_server_meta`] puts that meta tag into the
//! launcher as it is served, and nothing on disk changes.
//!
//! The same insertion carries a second tag: the release tag this binary was built
//! from, [`BUILD_TAG_META_NAME`], whenever the build has one. GitHub answers
//! `releases/latest` with CORS open to any origin, so the launcher asks it directly
//! and needs no backend behind the shim to know a newer AppImage exists; all the
//! shim contributes is which build it is, which only the shim can know. A build
//! whose tag was never baked in carries none, so a run from a checkout offers
//! nothing, which is the rule the desktop app already follows. That is what makes a
//! local build untagged without a second flag, so the shim job in the release
//! workflow is the one thing that has to set [`BUILD_TAG_ENV`].
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
//!   * A page that is never installed is evictable storage, so the manifest ships
//!     with the launcher, which keeps its name and its icons. No service worker
//!     does: this server runs on the same machine as the browser it opened, so
//!     there is no offline mode to keep, and a worker answers navigations out of a
//!     cache keyed by whole URLs, which is how a launcher an older build cached
//!     came to be served in place of the one on disk. The launcher skips the
//!     registration on a page this shim served; see `main.ts`.
//!
//! The one path that is not a file is the command wire. It exists because a browser
//! cannot choose a path: it hands a page a file's *contents*, never where the file
//! is, so anything the launcher does with a real path has to be done by the process
//! serving the page. [`COMMAND_PATH`] is where that would happen, one JSON request
//! at a time, and nothing is behind it yet. What is behind it is the gate.
//!
//! The gate is the hard part, because the alternative is a loopback endpoint that
//! writes files, runs git and lends a stored credential to any page on the machine
//! that asks for it. CORS does not help: it stops a hostile page from *reading* an
//! answer, not from causing the effect. So the wire refuses everything a page this
//! shim served would not send. [`TOKEN_META_NAME`] carries a secret minted per launch
//! into the launcher document and into no other, the request has to present it, and
//! `Origin`, `Host` and `Sec-Fetch-Site` all have to name this shim's own origin,
//! which a page anywhere else cannot. The `x-lithic-shim` marker a second launch
//! probes with is deliberately not part of that: it says a port is ours, not that a
//! request is.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

mod command;

/// The meta tag the launcher reads to decide it is a browser mount rather than an
/// instance. It says nothing about where saves land: that is the platform's answer.
/// The name is `BROWSER_ONLY_META` in `launcher-ui/src/mode.ts`, and the two have
/// to agree, so a change there is a change here.
pub const BROWSER_ONLY_META_NAME: &str = "lithic-browser-only";

/// The meta tag carrying the release tag this binary was built from.
///
/// A build with one is a build the release workflow cut, and the tag is how the
/// launcher tells two things at once: that this page came from a shim rather than
/// from a static host or an instance, and which release it is, so it can compare
/// itself against GitHub's newest. A build with no tag serves no tag.
///
/// The name is read by `readBuildTag` in `launcher-ui/src/update-notice.ts`, and the
/// two have to agree, so a change there is a change here.
pub const BUILD_TAG_META_NAME: &str = "lithic-build-tag";

/// The compile-time variable the release workflow sets to the tag it cut a build
/// from. It is read through [`build_tag`], and nothing sets it for a local build.
pub const BUILD_TAG_ENV: &str = "LITHIC_BUILD_TAG";

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
/// The command wire: the endpoint the launcher page of this shim posts to. It
/// answers no request that did not come from the page this shim itself served.
pub const COMMAND_PATH: &str = "/__lithic/command";
/// The host the shim both binds and opens, never `localhost`. See [`loopback_alias`].
pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// The meta tag carrying the per-launch secret the command wire requires.
///
/// It rides in the launcher document and nowhere else, so the only page on the
/// machine that holds it is the one this shim served. The launch that mints it
/// forgets it when the process ends, which is deliberate: a secret that outlived
/// the server behind it would be a credential nothing could revoke.
///
/// The name is read by `readShimToken` in `launcher-ui/src/shim-command.ts`.
pub const TOKEN_META_NAME: &str = "lithic-shim-token";
/// The request header the launcher presents the token in.
pub const TOKEN_HEADER: &str = "x-lithic-token";
/// How many bytes of entropy the token is minted from. 32 is the conventional
/// answer and hex doubles it into a 64-character attribute.
const TOKEN_BYTES: usize = 32;
/// The largest command body worth reading.
///
/// It has to carry a Lith, because `write` is one of the commands now: a document the
/// launcher can mount is the unit of work here, not a liveness probe. Still a cap, and one
/// the transport applies before it buffers anything, so a client that declares more than
/// this is refused rather than read.
pub(crate) const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Files without which the payload is not a launcher. Checked before the port is
/// bound so a broken layout fails with a list rather than with half a page.
///
/// The service worker the published launcher registers is deliberately not here:
/// the shim has no offline mode, and a cached launcher is what an old worker would
/// answer a navigation with. A payload that happens to carry the file is the
/// checkout the shim can also run from, not anything the AppImage ships.
pub const REQUIRED_PAYLOAD: [&str; 4] = [
    "index.html",
    "manifest.json",
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
///      the launcher, the engine and the manifest.
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
    inject_server_meta(html, None)
}

/// Inject the tags this server is the only one able to add: the browser-only
/// declaration, and the build tag when this binary carries one.
///
/// Both go in at one offset in one pass, so neither can land on the far side of a
/// raw text element from the other. Either is skipped when the document already
/// carries it, which is what makes a second pass a no-op rather than a second tag.
/// `build_tag` is `None` for a build the release workflow did not cut, and the
/// document then goes out with the declaration alone.
pub fn inject_server_meta(html: &str, build_tag: Option<&str>) -> String {
    let lower = html.to_ascii_lowercase();
    let mut tags = String::new();
    if !declares_browser_only(&lower) {
        tags.push_str(&meta_tag());
    }
    if let Some(tag) = build_tag {
        if !declares_build_tag(&lower) {
            tags.push_str(&build_tag_meta_tag(tag));
        }
    }
    if tags.is_empty() {
        return html.to_string();
    }
    let Some(at) = injection_offset(&lower) else {
        return html.to_string();
    };
    let mut out = String::with_capacity(html.len() + tags.len());
    out.push_str(&html[..at]);
    out.push_str(&tags);
    out.push_str(&html[at..]);
    out
}

/// The tag itself, in the empty-element style the launcher's own head uses.
pub fn meta_tag() -> String {
    format!("<meta name=\"{BROWSER_ONLY_META_NAME}\" content=\"1\" />")
}

/// The build tag's tag, the same shape as [`meta_tag`].
pub fn build_tag_meta_tag(tag: &str) -> String {
    format!("<meta name=\"{BUILD_TAG_META_NAME}\" content=\"{tag}\" />")
}

/// The command wire's secret, in a meta tag.
pub fn token_meta_tag(token: &str) -> String {
    format!("<meta name=\"{TOKEN_META_NAME}\" content=\"{token}\" />")
}

/// Mint a token for this launch.
///
/// The operating system's entropy source, never the clock or the process id: the
/// point of the secret is that nothing outside this page can guess it, and a
/// quantity a page can read for itself is not a secret. Panicking on failure is
/// deliberate, since a shim that cannot mint one must not start a wire that would
/// then accept a weaker one.
pub fn new_token() -> String {
    use std::fmt::Write as _;
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut bytes).expect("the operating system entropy source");
    let mut token = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    token
}

/// Whether a token can go into an attribute exactly as it is.
///
/// The same guard [`is_tag_safe`] gives a build tag, and for the same reason: a
/// token is written into the served document rather than escaped into it, and
/// [`new_token`] produces hex so this only ever refuses something a caller made up.
fn is_token_safe(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 128
        && token.chars().all(|character| character.is_ascii_hexdigit())
}

/// Whether a document already carries a command-wire token. Takes the lowercased form.
pub fn declares_token(lowercased_html: &str) -> bool {
    let name = TOKEN_META_NAME;
    lowercased_html.contains(&format!("name=\"{name}\""))
        || lowercased_html.contains(&format!("name='{name}'"))
        || lowercased_html.contains(&format!("name={name}"))
}

/// Inject the command wire's token into the launcher document.
///
/// A pass of its own rather than a third tag inside [`inject_server_meta`], so the
/// proven browser-only and build-tag rules are not disturbed to carry something
/// with a different lifetime. The two passes find the same insertion point (an
/// injected meta tag neither opens a `<script>` nor closes the head), so the tags
/// still go in beside each other.
pub fn inject_token_meta(html: &str, token: Option<&str>) -> String {
    let Some(token) = token.filter(|token| is_token_safe(token)) else {
        return html.to_string();
    };
    let lower = html.to_ascii_lowercase();
    if declares_token(&lower) {
        return html.to_string();
    }
    let tag = token_meta_tag(token);
    let Some(at) = injection_offset(&lower) else {
        return html.to_string();
    };
    let mut out = String::with_capacity(html.len() + tag.len());
    out.push_str(&html[..at]);
    out.push_str(&tag);
    out.push_str(&html[at..]);
    out
}

/// The release tag this binary was built from, or `None` for a build the release
/// workflow did not cut.
///
/// Read at compile time, so it is a property of the binary rather than of the
/// machine it runs on, and so a release build is the only kind that has one.
pub fn build_tag() -> Option<&'static str> {
    option_env!("LITHIC_BUILD_TAG").filter(|tag| is_tag_safe(tag))
}

/// Whether a tag can go into an attribute exactly as it is.
///
/// The release tags look like `v2026.09.30-2116`, so this is not a parser: it is
/// the guard that keeps a tag somebody exported by hand out of the served
/// document, where it would otherwise land in an attribute unescaped. A tag that
/// fails it is treated as no tag at all.
fn is_tag_safe(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && tag
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '+'))
}

/// Whether a document already carries a build tag. Takes the lowercased form.
///
/// Presence alone rather than the value: a document that already has one has been
/// through this already, and a second would leave the launcher reading whichever
/// the browser found first.
pub fn declares_build_tag(lowercased_html: &str) -> bool {
    let name = BUILD_TAG_META_NAME;
    lowercased_html.contains(&format!("name=\"{name}\""))
        || lowercased_html.contains(&format!("name='{name}'"))
        || lowercased_html.contains(&format!("name={name}"))
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
    /// Every header, name lowercased and in the order they arrived. The command
    /// wire reads several of them, and a lookup that was case sensitive would be a
    /// gate a client could walk around by spelling `Origin` differently.
    pub headers: Vec<(String, String)>,
    /// The body, read separately once the head is parsed. Empty for every request
    /// the shim answers out of the payload.
    pub body: Vec<u8>,
}

impl Request {
    /// The first value of a header, matched case insensitively on the name. The
    /// names are already lowercased in [`parse_request`], so this is a plain scan.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub(crate) fn plain(status: u16, reason: &'static str, message: &str, cache: &str) -> Self {
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

/// Parse a request head (the request line and the headers, ending at a blank line).
/// The body is read separately, by [`read_body`], once the length is known.
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
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let host = headers
        .iter()
        .find(|(name, _)| name == "host")
        .map(|(_, value)| value.clone());
    Some(Request { method, target, host, headers, body: Vec::new() })
}

/// How many body bytes the request declares, or `None` for no usable length.
///
/// A guessable length is worse than none: a truncated read would hand the command
/// parser half a JSON object and a missing length is not a reason to buffer
/// whatever the client keeps sending. No declaration, no body.
fn declared_length(request: &Request) -> Option<usize> {
    request.header("content-length")?.parse().ok()
}

/// Read a declared number of body bytes. A client that stops early is tolerated
/// by handing the parser what it did send, which then fails on its own.
fn read_body(reader: &mut impl Read, length: usize) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::with_capacity(length.min(MAX_BODY_BYTES));
    reader.take(length as u64).read_to_end(&mut body)?;
    Ok(body)
}

/// Turn a request into a response. `root_canonical` is the payload directory
/// already resolved, so the traversal check below is a prefix test on resolved
/// paths rather than a string comparison of what the client sent. `token` is this
/// launch's command-wire secret, minted by [`serve`] and injected into the launcher
/// document it serves.
pub fn handle(
    request: &Request,
    root: &Path,
    root_canonical: &Path,
    port: u16,
    token: &str,
    startup: Option<&Path>,
) -> Response {
    let raw_target = request.target.as_str();
    let raw_path = raw_target.split(['?', '#']).next().unwrap_or(raw_target);
    let Some(path) = percent_decode(raw_path) else {
        return Response::plain(400, "Bad Request", "The request target is not readable.\n", "no-store");
    };

    // The one path that is not a file, and the one that is method specific, so it
    // is dispatched before the payload's own two rules.
    if path == COMMAND_PATH {
        return command::handle(request, port, token, startup);
    }

    if request.method != "GET" && request.method != "HEAD" {
        return Response::plain(405, "Method Not Allowed", "The shim serves GET and HEAD.\n", "no-store");
    }

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
            Ok(text) => {
                let declared = inject_server_meta(&text, build_tag());
                body = inject_token_meta(&declared, Some(token)).into_bytes();
            }
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

    /// Add an `allow` header, for the command wire's method refusal.
    pub(crate) fn allowing(mut self, methods: &str) -> Self {
        self.headers.push(("allow".to_string(), methods.to_string()));
        self
    }
}

/// The origin a page this shim served is at, which is the only `Origin` the command
/// wire accepts. `localhost` is deliberately not here: the shim redirects that
/// spelling to this one before any page loads, so a request carrying it is a request
/// from somewhere that did not come through this shim.
pub(crate) fn shim_origin(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}")
}

/// The same address as it appears in a `Host` header.
pub(crate) fn shim_authority(port: u16) -> String {
    format!("{LOOPBACK_HOST}:{port}")
}

/// A refusal, which says only that this request was not one of ours.
///
/// One message for every failed check on purpose: a client that could tell "wrong
/// origin" apart from "wrong token" would be a client that could probe the wire,
/// and a real launcher page never sees this at all.
pub(crate) fn refused() -> Response {
    Response::plain(
        403,
        "Forbidden",
        "This endpoint answers only the launcher page this shim served.\n",
        "no-store",
    )
}

/// A JSON response, which is the whole shape of the command wire.
pub(crate) fn json_response(status: u16, reason: &'static str, body: serde_json::Value) -> Response {
    Response {
        status,
        reason,
        headers: vec![
            ("content-type".to_string(), "application/json; charset=utf-8".to_string()),
            ("cache-control".to_string(), "no-store".to_string()),
            ("x-content-type-options".to_string(), "nosniff".to_string()),
        ],
        body: body.to_string().into_bytes(),
    }
}

/// Compare two tokens without an early exit.
///
/// The comparison is over every byte rather than up to the first difference, so the
/// time a wrong token takes says nothing about how much of it was right. The length
/// check leaks only the length, which is fixed by [`new_token`] and public anyway.
pub(crate) fn token_matches(expected: &str, presented: &str) -> bool {
    if expected.len() != presented.len() {
        return false;
    }
    expected
        .bytes()
        .zip(presented.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
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
///
/// The command wire's secret is minted here, once per process, and then cloned into
/// each connection's thread: every response a launch serves carries the same token,
/// and the next launch has a different one. `startup` is the `.lith` this process was
/// started with, cloned the same way, so the launcher can ask for it once it boots.
pub fn serve(listener: TcpListener, root: PathBuf, port: u16, startup: Option<PathBuf>) -> std::io::Result<()> {
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.clone());
    let token = new_token();
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        let root = root.clone();
        let root_canonical = root_canonical.clone();
        let token = token.clone();
        let startup = startup.clone();
        std::thread::spawn(move || {
            if let Err(error) = handle_connection(stream, &root, &root_canonical, port, &token, startup.as_deref()) {
                eprintln!("shim: a connection failed: {error}");
            }
        });
    }
    Ok(())
}

fn handle_connection(
    stream: TcpStream,
    root: &Path,
    root_canonical: &Path,
    port: u16,
    token: &str,
    startup: Option<&Path>,
) -> std::io::Result<()> {
    // A client that connects and says nothing must not hold a thread open.
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let head = read_head(&mut reader)?;
    let mut request = match parse_request(&head) {
        Some(request) => request,
        None => {
            let response = Response::plain(400, "Bad Request", "The request head is not readable.\n", "no-store");
            let mut writer = stream;
            writer.write_all(&response.bytes(false))?;
            return writer.flush();
        }
    };
    // A body is read only when one is declared, and only up to the size the wire will
    // look at. A command is never dispatched on bytes still sitting in the socket, and a
    // body nobody declared is not a body.
    if let Some(length) = declared_length(&request) {
        if command::body_is_oversized(length) {
            let response = Response::plain(413, "Payload Too Large", "The command body is too large.\n", "no-store");
            let mut writer = stream;
            writer.write_all(&response.bytes(false))?;
            return writer.flush();
        }
        request.body = read_body(&mut reader, length)?;
    }
    let head_only = request.method == "HEAD";
    let response = handle(&request, root, root_canonical, port, token, startup);
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
    /// The token the test requests present. A real one is minted per launch; here it
    /// only has to be the string both sides agree on.
    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
                TEST_TOKEN,
                None,
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
    fn a_payload_without_a_service_worker_is_complete() {
        // The service worker the published launcher registers is not something the
        // shim serves, so a payload that has none is a payload the AppImage could
        // ship. The fixture writes none, which is what the AppDir now copies.
        let payload = Payload::new("no-worker");
        assert!(!payload.root.join("offline-service-worker.js").exists());
        assert!(payload_problems(&payload.root).is_empty());
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
        // The wiki engine is not a shim's page either, so it carries neither tag.
        assert!(!body_of(&engine).contains(BUILD_TAG_META_NAME));
    }

    #[test]
    fn the_build_tag_rides_along_with_the_declaration() {
        let html = "<!DOCTYPE html>\n<html><head><title>t</title></head><body>x</body></html>\n";
        let tag = "v2026.09.30-2116";
        let injected = inject_server_meta(html, Some(tag));
        let both = format!("{}{}", meta_tag(), build_tag_meta_tag(tag));
        assert_eq!(injected.replace(&both, ""), html, "the document changed beyond the insertion");
        assert_eq!(injected.matches(BUILD_TAG_META_NAME).count(), 1);
        let at = injected.find(&meta_tag()).expect("the declaration was inserted");
        assert!(injected[at..].starts_with(&both), "the two tags are not together");
        assert!(
            injected[at + both.len()..].to_ascii_lowercase().starts_with("</head>"),
            "the pair does not sit immediately before the head's close"
        );
        // The declaration's own position rule still holds with the tag beside it.
        assert_inserted_at_the_top_of_the_head(html, &injected.replace(&build_tag_meta_tag(tag), ""));
        assert!(declares_build_tag(&injected.to_ascii_lowercase()));
    }

    #[test]
    fn a_build_with_no_tag_serves_no_tag() {
        let html = "<html><head></head><body></body></html>";
        let injected = inject_server_meta(html, None);
        assert!(!declares_build_tag(&injected.to_ascii_lowercase()));
        assert_eq!(
            injected,
            format!("<html><head>{}</head><body></body></html>", meta_tag())
        );
    }

    #[test]
    fn the_served_launcher_carries_a_tag_exactly_when_the_build_has_one() {
        // The correspondence, rather than the environment: green both in a plain
        // checkout (no tag, so none is served) and in a release build (the tag the
        // workflow baked in, served beside the declaration), so it never asserts
        // something about whoever happened to run it.
        let payload = Payload::new("tag");
        let served = body_of(&payload.request("/src/launcher.html"));
        match build_tag() {
            Some(tag) => assert!(served.contains(&build_tag_meta_tag(tag))),
            None => assert!(!declares_build_tag(&served.to_ascii_lowercase())),
        }
    }

    #[test]
    fn a_tag_that_cannot_go_into_an_attribute_is_refused() {
        // The guard on an environment variable a person can export by hand, since a
        // tag is written into an attribute rather than escaped into one.
        assert!(is_tag_safe("v2026.09.30-2116"));
        assert!(is_tag_safe("0.0.282"));
        assert!(is_tag_safe("v1.0.0+linux"));
        assert!(!is_tag_safe(""));
        assert!(!is_tag_safe("   "));
        assert!(!is_tag_safe("v1\"><script>alert(1)</script>"));
        assert!(!is_tag_safe(&"a".repeat(65)));
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
            let response = handle(&request, &payload.root, &canonical, DEFAULT_PORT, TEST_TOKEN, None);
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
        assert_eq!(handle(&request, &payload.root, &canonical, DEFAULT_PORT, TEST_TOKEN, None).status, 405);
        let head = parse_request("HEAD /src/launcher.html HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").expect("request");
        let response = handle(&head, &payload.root, &canonical, DEFAULT_PORT, TEST_TOKEN, None);
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
    fn injecting_the_tags_twice_changes_nothing() {
        let html = "<html><head><title>t</title></head><body></body></html>";
        let tag = "v2026.09.30-2116";
        let once = inject_server_meta(html, Some(tag));
        assert_eq!(inject_server_meta(&once, Some(tag)), once);
        // A document that already declares the mount but not the build, which is the
        // state one pass leaves behind when it ran with no tag to add.
        let declared = inject_server_meta(html, None);
        let tagged = inject_server_meta(&declared, Some(tag));
        assert!(tagged.contains(&build_tag_meta_tag(tag)));
        assert_eq!(tagged.matches(BROWSER_ONLY_META_NAME).count(), 1);
        assert_eq!(inject_server_meta(&tagged, Some(tag)), tagged);
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
        // The same rule has to survive the pair, since a release build serves both
        // tags and the build tag is longer than the declaration.
        let tag = "v2026.09.30-2116";
        let tagged = inject_server_meta(&html, Some(tag));
        assert_eq!(
            tagged.len(),
            html.len() + meta_tag().len() + build_tag_meta_tag(tag).len()
        );
        assert_inserted_at_the_top_of_the_head(&html, &tagged.replace(&build_tag_meta_tag(tag), ""));
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

    // -----------------------------------------------------------------------
    // The command wire
    // -----------------------------------------------------------------------

    /// A command request with every field explicit, so a test can bend exactly one.
    fn command_request(method: &str, origin: &str, host: &str, fetch_site: &str, token: &str, content_type: &str, body: &str) -> Request {
        let head = format!(
            "{method} {COMMAND_PATH} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\n\
             Sec-Fetch-Site: {fetch_site}\r\nContent-Type: {content_type}\r\n\
             {TOKEN_HEADER}: {token}\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut request = parse_request(&head).expect("parsed request");
        request.body = body.as_bytes().to_vec();
        request
    }

    /// The same request a real launcher page makes, as one value a test can mutate.
    fn launcher_command(body: &str) -> Request {
        command_request(
            "POST",
            &shim_origin(DEFAULT_PORT),
            &shim_authority(DEFAULT_PORT),
            "same-origin",
            TEST_TOKEN,
            "application/json",
            body,
        )
    }

    fn command_response(request: &Request) -> Response {
        command::handle(request, DEFAULT_PORT, TEST_TOKEN, None)
    }

    #[test]
    fn the_command_wire_answers_the_launcher_page() {
        let response = command_response(&launcher_command("{\"command\":\"ping\"}"));
        assert_eq!(response.status, 200);
        assert_eq!(body_of(&response), "{\"ok\":true,\"result\":{\"shim\":true}}");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "content-type" && value.starts_with("application/json")));

        // A command with nothing behind it is still an answer: the wire worked and
        // the thing asked for does not exist yet.
        let unknown = command_response(&launcher_command("{\"command\":\"open-file\"}"));
        assert_eq!(unknown.status, 200);
        assert!(body_of(&unknown).contains("unknown-command"));
    }

    #[test]
    fn the_command_wire_refuses_a_request_the_launcher_would_not_send() {
        // Every request below is one mutation away from the launcher's own. Each has
        // to be refused, or the endpoint is a loopback writer any page can reach.
        let get = command_response(&command_request(
            "GET",
            &shim_origin(DEFAULT_PORT),
            &shim_authority(DEFAULT_PORT),
            "same-origin",
            TEST_TOKEN,
            "application/json",
            "",
        ));
        assert_eq!(get.status, 405, "a state-changing GET was answered");
        assert!(get.headers.iter().any(|(name, value)| name == "allow" && value == "POST"));

        let refusals: [(&str, Request); 7] = [
            // A page the shim did not serve: a real browser at another origin.
            (
                "another origin",
                command_request("POST", "https://example.com", &shim_authority(DEFAULT_PORT), "cross-site", TEST_TOKEN, "application/json", "{\"command\":\"ping\"}"),
            ),
            // A name that resolves to loopback, so the browser sends the attacker's name.
            (
                "another host",
                command_request("POST", &shim_origin(DEFAULT_PORT), "evil.example:5484", "same-origin", TEST_TOKEN, "application/json", "{\"command\":\"ping\"}"),
            ),
            // No fetch metadata at all, which a real browser request always carries.
            (
                "no fetch metadata",
                command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "", TEST_TOKEN, "application/json", "{\"command\":\"ping\"}"),
            ),
            // A cross-site fetch, which says so out loud.
            (
                "a cross-site fetch",
                command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "cross-site", TEST_TOKEN, "application/json", "{\"command\":\"ping\"}"),
            ),
            // Right origin, wrong secret.
            (
                "a wrong token",
                command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "same-origin", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "application/json", "{\"command\":\"ping\"}"),
            ),
            // The shape a form can cause without a preflight.
            (
                "a form content type",
                command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "same-origin", TEST_TOKEN, "application/x-www-form-urlencoded", "command=ping"),
            ),
            // A JSON body that is not a command object.
            (
                "a body naming no command",
                command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "same-origin", TEST_TOKEN, "application/json", "{\"args\":{}}"),
            ),
        ];
        for (label, request) in refusals {
            let response = command_response(&request);
            assert!(
                response.status == 403 || response.status == 415 || response.status == 400,
                "{label} was answered with {}",
                response.status
            );
            // A refusal says nothing about which check failed, so it cannot be probed.
            if response.status == 403 {
                assert!(!body_of(&response).to_lowercase().contains("token"), "{label} named the check it failed");
            }
        }

        // The path is not reachable without the token even by a same-origin page: a
        // second product on another loopback port can send the same shape of request.
        let no_token = command_request("POST", &shim_origin(DEFAULT_PORT), &shim_authority(DEFAULT_PORT), "same-origin", "", "application/json", "{\"command\":\"ping\"}");
        assert_eq!(command_response(&no_token).status, 403);
    }

    #[test]
    fn the_command_wire_is_not_reachable_by_a_get() {
        // The one shape a hostile page can cause with no preflight at all. It gets
        // the method refusal, and the payload path keeps its own method rule.
        let payload = Payload::new("command-get");
        let canonical = payload.root.canonicalize().expect("canonical payload");
        let request = parse_request(&format!("GET {COMMAND_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"))
            .expect("parsed request");
        let response = handle(&request, &payload.root, &canonical, DEFAULT_PORT, TEST_TOKEN, None);
        assert_eq!(response.status, 405);
    }

    #[test]
    fn the_served_launcher_carries_the_launch_token_and_the_engine_does_not() {
        let payload = Payload::new("token");
        let launcher = body_of(&payload.request("/src/launcher.html"));
        assert!(launcher.contains(&token_meta_tag(TEST_TOKEN)));
        assert!(declares_token(&launcher.to_ascii_lowercase()));
        let engine = body_of(&payload.request("/src/lithic.html"));
        assert!(!engine.contains(TOKEN_META_NAME), "the engine carried the wire's secret");
    }

    #[test]
    fn injecting_the_token_twice_changes_nothing() {
        let html = "<html><head><title>t</title></head><body></body></html>";
        let once = inject_token_meta(html, Some(TEST_TOKEN));
        assert_eq!(inject_token_meta(&once, Some(TEST_TOKEN)), once);
        assert_eq!(once.matches(TOKEN_META_NAME).count(), 1);
        // No token is no tag, which is what an untagged local run serves.
        assert_eq!(inject_token_meta(html, None), html);
    }

    #[test]
    fn a_token_that_cannot_go_into_an_attribute_is_refused() {
        assert!(is_token_safe(TEST_TOKEN));
        assert!(is_token_safe("deadbeef"));
        assert!(!is_token_safe(""));
        assert!(!is_token_safe("not hex"));
        assert!(!is_token_safe("\"><script>alert(1)</script>"));
        assert!(!is_token_safe(&"a".repeat(129)));
        let html = "<html><head></head><body></body></html>";
        assert_eq!(inject_token_meta(html, Some("\"><script>x</script>")), html);
    }

    #[test]
    fn a_minted_token_is_random_and_hex() {
        let first = new_token();
        let second = new_token();
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert!(is_token_safe(&first));
        assert_ne!(first, second, "two launches minted the same secret");
        assert!(token_matches(&first, &first));
        assert!(!token_matches(&first, &second));
        // A prefix of the right token is not the right token.
        assert!(!token_matches(&first, &first[..first.len() - 1]));
    }

    #[test]
    fn the_three_tags_go_in_beside_each_other_before_the_head_closes() {
        // The real artifact, where the browser-only and build-tag pair already run
        // through one insertion rule; the token joins them and has to land with them
        // rather than on the far side of a script.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/launcher.html");
        let Ok(html) = fs::read_to_string(&path) else {
            panic!("src/launcher.html is missing, so this rule is untested");
        };
        let tag = "v2026.09.30-2116";
        let declared = inject_server_meta(&html, Some(tag));
        let injected = inject_token_meta(&declared, Some(TEST_TOKEN));
        let pair = format!("{}{}", meta_tag(), build_tag_meta_tag(tag));
        let all = format!("{pair}{}", token_meta_tag(TEST_TOKEN));
        assert_eq!(injected.len(), html.len() + all.len());
        assert_eq!(injected.replace(&all, ""), html, "the document changed beyond the insertion");
        assert!(
            injected[injected.find(&pair).expect("the pair was inserted")..].starts_with(&all),
            "the token landed away from the declaration and the build tag"
        );
        assert!(
            injected.contains(&format!("{all}</head>")),
            "the tags are not immediately before the head's close"
        );
    }
}
