//! Git sync: what the shim can answer about a folder with the standard library alone.
//!
//! The desktop app answers these questions through libgit2 (`src-tauri/src/gitcore.rs`),
//! because a process that already links a git library should use it. The shim cannot afford
//! to be that process: the whole reason this crate exists is an artifact the size of the
//! payload it serves, and a linked libgit2 plus a TLS stack is the one thing that ends that.
//! So the surface is split by what an answer actually needs, and this module is the half that
//! needs no library at all.
//!
//! Reading a repository is a file read. The only question the launcher asks about a folder it
//! already has is whether Lithic manages it, and Lithic marks every folder it manages with an
//! origin URL it wrote itself, `https://oauth2:<token>@github.com/owner/name.git`. That marker
//! lives in `.git/config`, which is text, so `git-status`, `git-coverage` and
//! `list-folder-liths` are `std::fs` and nothing else. They are also the commands a launcher
//! calls on every boot and every save, so answering them without a thread that can block on a
//! network is the behaviour the shim wants regardless of what it links.
//!
//! Writing to a repository is the other half, and it does need git: cloning, committing,
//! fetching and pushing are not things to reimplement over the wire. Those commands
//! (`git-setup`, `git-commit`, `git-heartbeat`, `git-reauth`, `git-disconnect`, and the GitHub
//! device flow beside them) are not here yet, and the dependency set they need is chosen and
//! written up in the round log (`docs/rounds/`) rather than pulled in ahead of the code that uses
//! it. Until they
//! land, a request for one is the wire's ordinary `unknown-command` answer, which is honest:
//! the wire worked, and what it was asked for it does not have.
//!
//! Two rules come from the desktop app rather than being invented here, and both of them are
//! load bearing. The marker is the `oauth2:` in the URL, which is what keeps a git folder the
//! person made themselves out of every automatic commit and push. And containment walks *up*,
//! because staging is recursive: a wiki in a subfolder really is published by the repository
//! at the root, so reporting it as un-backed-up would be false and would aim a "back up this
//! folder" offer at a folder inside a repository.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::command::{bad_args, ok, path_arg, path_text};
use crate::Response;

/// The marker Lithic writes into the origin of a repository it manages.
///
/// This is not a display string and not a guess: it is the whole distinction between a folder
/// Lithic connected and a git folder somebody else made, and only the first kind is ever
/// committed into or pushed from. `deploy/github-sync.sh` writes the same shape self-host, so
/// a folder connected on either side reads the same here.
const MANAGED_MARKER: &str = "oauth2:";

/// The most `.lith` files a re-index is answered with, the same cap the desktop app's
/// `REINDEX_LIST_LIMIT` puts on its own listing.
const LIST_LIMIT: usize = 500;

/// `git-status { path }`
///
/// Mirrors `git_sync_status` in the desktop app down to the null: a folder outside a
/// repository, and a repository whose origin Lithic did not write, both answer `null` rather
/// than a status that says disconnected. The launcher draws the same grey for either, so a
/// field distinguishing them would be one nobody reads.
pub(crate) fn status(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(url) = sync_dir_of(&path).and_then(|dir| managed_remote_url(&dir)) else {
        return ok(json!(null));
    };
    ok(json!({
        "connected": true,
        "repo": repo_name(&url),
        // The shim does no commit work yet, so a backup is never running. The field is
        // answered anyway rather than omitted: the launcher reads it, and a missing key is how
        // a launcher built ahead of its backend is recognised, which is not the state this is.
        "in_flight": false,
    }))
}

/// `git-coverage { paths }`
///
/// One answer for a whole recents list rather than a status call per row, the same bargain the
/// desktop app makes: each path is looked up against the repository containing it, and a path
/// no repository covers is simply absent from the answer. A row cannot be told apart from an
/// unbacked one by a null, so absence is the shape.
pub(crate) fn coverage(args: &Value) -> Response {
    let Some(paths) = args.get("paths").and_then(Value::as_array) else { return bad_args() };
    let mut backed = Map::new();
    for path in paths.iter().filter_map(Value::as_str) {
        let Some(root) = sync_dir_of(Path::new(path)).and_then(|dir| managed_root_for(&dir)) else {
            continue;
        };
        backed.insert(path.to_string(), Value::String(path_text(&root)));
    }
    ok(Value::Object(backed))
}

/// `list-folder-liths { path }`
///
/// Every `.lith` in one folder for the launcher's re-index, newest first. It accepts a file or
/// the folder holding it, so a caller can hand over whichever of the two it already has, for
/// the same reason the desktop app's `sync_dir_of` exists. Flat, like `list_lith_wikis` there:
/// a repository that needs a deeper walk says so through several calls rather than one
/// recursive one, and the cap keeps a Downloads folder from being enumerated in full.
pub(crate) fn list_folder_liths(args: &Value) -> Response {
    let Some(path) = path_arg(args) else { return bad_args() };
    let Some(dir) = sync_dir_of(&path) else { return ok(json!(Vec::<String>::new())) };
    ok(json!(liths_in(&dir)))
}

// ---------------------------------------------------------------------------
// What a managed folder is
// ---------------------------------------------------------------------------

/// The folder a sync path names: the path itself when it is a folder, else the folder holding
/// it. `None` when neither can be named, which is a path with no directory part at all.
///
/// Filtering the empty parent matters here and is the one place this diverges from the desktop
/// app: `Path::new("notes.lith").parent()` is `Some("")`, and joining `.git` onto that would
/// read a config relative to the process's working directory, which is a folder nobody named.
pub(crate) fn sync_dir_of(given: &Path) -> Option<PathBuf> {
    if given.is_dir() {
        return Some(given.to_path_buf());
    }
    given
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

/// Whether this folder is itself a repository Lithic manages: the marker, and nothing else.
///
/// A save does commit through a marker-only folder, so this is the question the write path
/// asks, and it stays the loose one. Preferring a folder is a different question with a
/// different answer in the desktop app (it also wants a commit, so a connect that died leaves
/// nothing to aim at), and the shim will need that same distinction when it grows a setup.
fn is_managed_dir(dir: &Path) -> bool {
    dir.join(".git").is_dir() && managed_remote_url(dir).is_some()
}

/// The nearest folder at or above `dir` that is a repository Lithic manages. Walks up because
/// that is what a commit does (staging is recursive), nearest first.
pub(crate) fn managed_root_for(dir: &Path) -> Option<PathBuf> {
    ancestors(dir).find(|candidate| is_managed_dir(candidate))
}

/// `dir` and every folder above it, nearest first.
fn ancestors(dir: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    std::iter::successors(Some(dir.to_path_buf()), |current| current.parent().map(Path::to_path_buf))
}

/// The origin URL of a repository Lithic manages, if this folder is one.
///
/// Reads `.git/config` directly rather than opening the repository, because the only thing
/// asked of it is one line of text. A `.git` that is a *file* rather than a folder (the shape
/// a linked worktree or a submodule leaves) is not a managed folder here: Lithic never writes
/// one, so there is nothing of its own to find inside it.
pub(crate) fn managed_remote_url(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(".git").join("config")).ok()?;
    let url = config_value(&text, "remote", Some("origin"), "url")?;
    url.contains(MANAGED_MARKER).then_some(url)
}

/// The `owner/name` a managed remote addresses.
///
/// Deliberately lenient, and deliberately the same shape the desktop app's `git_sync_status`
/// produces: a URL that carries the marker but cannot be read still reports as connected with
/// a generic name, because a folder Lithic wrote is a folder Lithic manages whatever a
/// hand-edit did to the URL, and reconnect is the repair.
fn repo_name(url: &str) -> String {
    url.split("github.com/")
        .nth(1)
        .map(|tail| tail.trim_end_matches(".git").trim().to_string())
        .unwrap_or_else(|| "github repository".to_string())
}

/// A managed remote taken apart: the `owner/name` it addresses and the token it carries.
///
/// Mirrors the desktop app's own reader, and deliberately lenient about the path, because this
/// also reads remotes an older Lithic or a self-host instance wrote: a missing `.git` or a
/// trailing slash still parses. Only the marker is strict, since that is what makes the folder
/// ours at all.
pub(crate) fn parse_managed_remote(url: &str) -> Option<(String, String)> {
    let (userinfo, host_and_path) = url.split_once("://")?.1.split_once('@')?;
    let token = userinfo.strip_prefix(MANAGED_MARKER)?.trim();
    if token.is_empty() {
        return None;
    }
    let path = host_and_path.split_once('/')?.1.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some((format!("{owner}/{name}"), token.to_string()))
}

/// Every `.lith` file in one folder, newest first, capped. A flat read of the folder itself,
/// so a nested wiki is found by the call that names its folder rather than by this one.
pub(crate) fn liths_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".lith") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push((modified, path_text(&entry.path())));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found.into_iter().take(LIST_LIMIT).map(|(_, path)| path).collect()
}

// ---------------------------------------------------------------------------
// Reading a git config
// ---------------------------------------------------------------------------

/// The value of one key in one section of a git config file.
///
/// A reader for the subset `.git/config` actually uses for a remote rather than a general
/// config parser, because that is the whole of what this module reads: sections in
/// `[name "subsection"]` form, `key = value` lines, `#`/`;` comments (stripped only outside
/// quotes, since a comment marker can sit inside a value), and the double quotes git applies
/// to a value with a leading or trailing space. Sections and keys are matched
/// case-insensitively, which is git's own rule, while a subsection is matched exactly, which
/// is how `remote "origin"` is told apart from any other remote.
///
/// Not handled, and named here so the limits are visible rather than discovered: `include`/
/// `includeIf` directives, and the older `[section.subsection]` spelling is understood but its
/// subsection is treated case-sensitively like the quoted one. Neither appears in the config of
/// a repository Lithic created, and a remote Lithic did not write answers `None`, which is the
/// safe direction.
fn config_value(text: &str, section: &str, subsection: Option<&str>, key: &str) -> Option<String> {
    let mut current: Option<(String, Option<String>)> = None;
    for raw in text.lines() {
        let line = strip_comment(raw);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            current = Some(split_header(header));
            continue;
        }
        let Some((name, value)) = line.split_once('=') else { continue };
        let Some((in_section, in_subsection)) = current.as_ref() else { continue };
        if !in_section.eq_ignore_ascii_case(section) {
            continue;
        }
        if in_subsection.as_deref() != subsection {
            continue;
        }
        if !name.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        return Some(unquote(value.trim()));
    }
    None
}

/// A config line with any trailing comment removed, leaving quoted text alone. Git treats `#`
/// and `;` as comment markers wherever they start a run outside quotes.
fn strip_comment(line: &str) -> &str {
    let mut quoted = false;
    let mut escaped = false;
    for (at, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return &line[..at],
            _ => {}
        }
    }
    line
}

/// A section header split into its name and its subsection, for both spellings git accepts:
/// `remote "origin"` and `branch.main`.
fn split_header(header: &str) -> (String, Option<String>) {
    let header = header.trim();
    if let Some((name, rest)) = header.split_once(|character: char| character.is_whitespace()) {
        let rest = rest.trim();
        let subsection = if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
            rest[1..rest.len() - 1].to_string()
        } else {
            rest.to_string()
        };
        return (name.trim().to_ascii_lowercase(), Some(subsection));
    }
    if let Some((name, subsection)) = header.split_once('.') {
        return (name.trim().to_ascii_lowercase(), Some(subsection.trim().to_string()));
    }
    (header.to_ascii_lowercase(), None)
}

/// Undo the one quoting rule that matters here: a value wrapped in double quotes, with `\n`,
/// `\t`, `\\` and `\"` escapes inside it. An unquoted value is taken as it stands.
fn unquote(value: &str) -> String {
    if value.len() < 2 || !value.starts_with('"') || !value.ends_with('"') {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut characters = value[1..value.len() - 1].chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            out.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::handle;
    use crate::{parse_request, COMMAND_PATH, DEFAULT_PORT, TOKEN_HEADER};
    use std::sync::atomic::AtomicU32;

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// The same request a real launcher page makes, so the tests read the wire rather than the
    /// functions behind it, exactly as `command.rs`'s own tests do.
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

    /// A directory of its own under the temp directory, removed when the test ends.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!("lithic-git-{label}-{}-{unique}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("scratch directory");
            Scratch { root }
        }

        /// Write a `.git/config` holding one managed origin, which is the whole of what makes
        /// a folder look connected to everything in this module.
        fn with_remote(&self, url: &str) -> PathBuf {
            let git = self.root.join(".git");
            fs::create_dir_all(&git).expect("dot git");
            fs::write(
                git.join("config"),
                format!(
                    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\
                     [remote \"origin\"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\
                     [branch \"main\"]\n\tremote = origin\n"
                ),
            )
            .expect("config");
            git
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn managed_url() -> &'static str {
        "https://oauth2:ghp_example@github.com/owner/name.git"
    }

    #[test]
    fn a_folder_with_a_managed_origin_reads_as_connected() {
        let scratch = Scratch::new("status");
        scratch.with_remote(managed_url());
        let answer = ask(&format!(
            "{{\"command\":\"git-status\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["result"]["connected"], json!(true));
        assert_eq!(answer["result"]["repo"], json!("owner/name"));
        assert_eq!(answer["result"]["in_flight"], json!(false));
    }

    #[test]
    fn a_file_inside_a_managed_folder_is_answered_for_its_folder() {
        let scratch = Scratch::new("status-file");
        scratch.with_remote(managed_url());
        let file = scratch.root.join("notes.lith");
        fs::write(&file, "text").expect("file");
        let answer = ask(&format!(
            "{{\"command\":\"git-status\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&file))
        ));
        assert_eq!(answer["result"]["repo"], json!("owner/name"));
    }

    #[test]
    fn a_repository_lithic_did_not_write_is_not_connected() {
        let scratch = Scratch::new("status-foreign");
        scratch.with_remote("https://github.com/somebody/their-own.git");
        let answer = ask(&format!(
            "{{\"command\":\"git-status\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["result"], json!(null));
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_not_connected() {
        let scratch = Scratch::new("status-plain");
        let answer = ask(&format!(
            "{{\"command\":\"git-status\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(answer["result"], json!(null));
        let none = ask("{\"command\":\"git-status\",\"args\":{}}");
        assert_eq!(none["error"], json!("bad-args"));
    }

    #[test]
    fn coverage_finds_the_repository_above_a_nested_wiki() {
        let scratch = Scratch::new("coverage");
        scratch.with_remote(managed_url());
        let nested = scratch.root.join("projects/deep");
        fs::create_dir_all(&nested).expect("nested");
        let wiki = nested.join("notes.lith");
        fs::write(&wiki, "text").expect("wiki");
        let outside = std::env::temp_dir().join("lithic-git-coverage-outside/other.lith");
        let answer = ask(&format!(
            "{{\"command\":\"git-coverage\",\"args\":{{\"paths\":[{},{}]}}}}",
            json!(path_text(&wiki)),
            json!(path_text(&outside))
        ));
        let covered = answer["result"].as_object().expect("a map");
        assert_eq!(covered.len(), 1, "only the covered path is answered: {answer}");
        assert_eq!(
            covered.get(&path_text(&wiki)).and_then(Value::as_str),
            Some(path_text(&scratch.root).as_str())
        );
        let bad = ask("{\"command\":\"git-coverage\",\"args\":{}}");
        assert_eq!(bad["error"], json!("bad-args"));
    }

    #[test]
    fn listing_a_folder_answers_the_liths_it_holds_and_no_others() {
        let scratch = Scratch::new("list");
        fs::write(scratch.root.join("one.lith"), "one").expect("one");
        fs::write(scratch.root.join("two.LITH"), "two").expect("two");
        fs::write(scratch.root.join("notes.md"), "md").expect("md");
        fs::create_dir_all(scratch.root.join("nested")).expect("nested");
        fs::write(scratch.root.join("nested/deep.lith"), "deep").expect("deep");
        let answer = ask(&format!(
            "{{\"command\":\"list-folder-liths\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        let mut listed: Vec<String> = answer["result"]
            .as_array()
            .expect("an array")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        listed.sort();
        let mut expected = vec![
            path_text(&scratch.root.join("one.lith")),
            path_text(&scratch.root.join("two.LITH")),
        ];
        expected.sort();
        assert_eq!(listed, expected);
    }

    #[test]
    fn listing_accepts_a_file_or_the_folder_holding_it() {
        let scratch = Scratch::new("list-file");
        let file = scratch.root.join("one.lith");
        fs::write(&file, "one").expect("one");
        let from_file = ask(&format!(
            "{{\"command\":\"list-folder-liths\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&file))
        ));
        let from_folder = ask(&format!(
            "{{\"command\":\"list-folder-liths\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(from_file["result"], from_folder["result"]);
        let nested = ask(&format!(
            "{{\"command\":\"list-folder-liths\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root.join("gone/one.lith")))
        ));
        assert_eq!(nested["result"], json!([]));
    }

    #[test]
    fn the_config_reader_takes_a_quoted_value_and_ignores_a_comment() {
        let text = "; a comment\n[remote \"origin\"]\n\turl = \"https://example/one.git\" # tail\n";
        assert_eq!(
            config_value(text, "remote", Some("origin"), "url").as_deref(),
            Some("https://example/one.git")
        );
        // A hash inside a quoted value is text, not a comment.
        let quoted = "[remote \"origin\"]\n\turl = \"https://example/a#b.git\"\n";
        assert_eq!(
            config_value(quoted, "remote", Some("origin"), "url").as_deref(),
            Some("https://example/a#b.git")
        );
    }

    #[test]
    fn the_config_reader_matches_sections_and_keys_without_case() {
        let text = "[Remote \"origin\"]\n\tURL = https://example/one.git\n";
        assert_eq!(
            config_value(text, "remote", Some("origin"), "url").as_deref(),
            Some("https://example/one.git")
        );
        // A subsection is matched exactly, so another remote is not this one.
        let other = "[remote \"upstream\"]\n\turl = https://example/two.git\n";
        assert_eq!(config_value(other, "remote", Some("origin"), "url"), None);
        // The older spelling, `[section.subsection]`, is understood too.
        let dotted = "[remote.origin]\n\turl = https://example/three.git\n";
        assert_eq!(
            config_value(dotted, "remote", Some("origin"), "url").as_deref(),
            Some("https://example/three.git")
        );
    }

    #[test]
    fn a_managed_remote_is_taken_apart_the_way_the_health_check_needs() {
        assert_eq!(
            parse_managed_remote(managed_url()),
            Some(("owner/name".to_string(), "ghp_example".to_string()))
        );
        // Lenient about the path, because older writers spelled it differently.
        assert_eq!(
            parse_managed_remote("https://oauth2:t@github.com/owner/name"),
            Some(("owner/name".to_string(), "t".to_string()))
        );
        assert_eq!(
            parse_managed_remote("https://oauth2:t@github.com/owner/name.git/"),
            Some(("owner/name".to_string(), "t".to_string()))
        );
        // Anything that is not a managed remote, or cannot be read, is nothing.
        assert_eq!(parse_managed_remote("https://github.com/owner/name.git"), None);
        assert_eq!(parse_managed_remote("https://oauth2:@github.com/owner/name.git"), None);
        assert_eq!(parse_managed_remote("https://oauth2:t@github.com/owner/name/deeper.git"), None);
        assert_eq!(parse_managed_remote("not a url"), None);
    }

    #[test]
    fn an_unreadable_url_still_reports_the_folder_as_connected() {
        // The marker is what makes a folder ours, so a URL that carries it is managed even
        // when its host is not GitHub: reconnect is the repair, and the name says so.
        let scratch = Scratch::new("status-odd");
        scratch.with_remote("https://oauth2:token@example.invalid/repo.git");
        let answer = ask(&format!(
            "{{\"command\":\"git-status\",\"args\":{{\"path\":{}}}}}",
            json!(path_text(&scratch.root))
        ));
        assert_eq!(answer["result"]["connected"], json!(true));
        assert_eq!(answer["result"]["repo"], json!("github repository"));
    }
}
