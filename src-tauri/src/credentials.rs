//! The credential vault: saved HTTP Basic credentials for bookmarked instances.
//!
//! A self-hosted instance behind Basic auth asks for a username and password on
//! every visit. The browser can be told to remember them; a WebView2 window
//! cannot, because the host application is the one that has to answer the auth
//! challenge. So the app keeps them itself.
//!
//! ## One secret, many credentials
//!
//! The vault is per install, not per instance: one secret unlocks one file that
//! maps each instance's origin to its own username and password. A second
//! bookmarked instance costs an entry, not another secret. The consequence is
//! worth stating plainly — the secret is the only thing between a copied vault
//! file and every password in it — which is why it is length-checked (see
//! [`MIN_SECRET_LEN`]) and why the UI warns about short all-digit secrets.
//!
//! ## What the file holds
//!
//! `credentials.vault` is JSON, so its *envelope* is inspectable — version, KDF
//! parameters, salt, nonce, and an index of the origins it holds as salted
//! hashes. Usernames and passwords are inside the ciphertext, and so are the
//! origins themselves; the index exists only so the launcher can answer "is there
//! a saved login for this address?" without the secret, which is what colours a
//! bookmark's key control. A copied file names no instance — an attacker has to
//! guess hostnames — and the index's salt is per write, so one file's answers say
//! nothing about another's.
//!
//! ```text
//! key   = Argon2id(secret, salt, m=64 MiB, t=3, p=1)
//! vault = XChaCha20-Poly1305(key, nonce, login map, aad = envelope parameters)
//! ```
//!
//! The envelope parameters are authenticated as additional data, so editing the
//! file to weaken the KDF (a smaller `m`, a cheaper `t`) fails the tag instead of
//! quietly deriving a weaker key. A wrong secret fails the tag too, which is how
//! this avoids storing a separate verifier.
//!
//! There is no recovery, and none is planned: this is a convenience store, so a
//! forgotten secret costs the passwords, never the credentials' *use*. Deleting
//! the file is a complete reset, and [`crate::forget_credentials`] is the
//! surgical version of the same thing.
//!
//! ## Unlocking is per instance
//!
//! The vault does not sit open for a session. It stays locked until the moment a
//! bookmarked instance is opened, and what is unlocked then is one credential,
//! lent to the app for as long as that instance takes to load ([`Grant`]) — which
//! is all the app needs to answer that instance's own password challenge. Leaving
//! the launcher drops it (the launcher locks on mount), and it expires on a clock
//! as well. The manager is the other caller, and it holds the vault open only
//! while its dialog is up.
//!
//! ## Tests
//!
//! The interesting cases are the ones a real deployment produces — a tampered
//! envelope, a truncated file, a secret typed with a trailing space — so they are
//! covered here rather than left to a manual pass.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

/// The vault's filename, looked for beside the executable first (see
/// [`crate::vault_path`]).
pub const VAULT_FILE: &str = "credentials.vault";

/// The floor for an unlock secret.
///
/// Six *characters*, not six digits: Argon2id takes bytes, so the character set
/// is what multiplies the search space. Six digits is 10^6 guesses — hours on one
/// core — while six mixed characters is 5.7×10^10, four orders of magnitude more
/// for the same typing effort. Nothing here enforces a maximum, because length is
/// the cheapest strength there is; [`validate_secret`] accepts anything up to
/// [`MAX_SECRET_BYTES`].
pub const MIN_SECRET_LEN: usize = 6;

/// A sanity ceiling, not a policy: an unbounded secret would be hashed by Argon2
/// anyway, but nothing reasonable is longer than this and a megabyte of input
/// should not reach the KDF at all.
pub const MAX_SECRET_BYTES: usize = 1024;

/// Known-answer values for the KDF, so the parameters and the algorithm are
/// pinned by a test rather than by a comment.
const M_COST_KIB: u32 = 65_536;
const T_COST: u32 = 3;
const P_COST: u32 = 1;
const SALT_BYTES: usize = 16;
/// The index's own salt, drawn per write. Per vault would be enough to stop two
/// files from being compared with each other; per write costs nothing and stops an
/// old copy of the file from being matched against the new one either.
const INDEX_SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const KDF_ID: &str = "argon2id";
const AEAD_ID: &str = "xchacha20poly1305";
const FORMAT_VERSION: u32 = 1;

/// One instance's credentials. Never serialised to the frontend: the UI lists
/// usernames and origins ([`CredentialSummary`]), not passwords.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Credential {
    pub user: String,
    pub password: String,
}

/// What the UI is allowed to see about a stored credential.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CredentialSummary {
    pub origin: String,
    pub user: String,
}

/// Everything a caller needs to tell one failure from another: "wrong secret,
/// try again" and "this file is not a vault, start over" are different answers.
#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    /// No vault file yet — not a failure, just nothing saved.
    Missing,
    /// The secret did not open it. Non-destructive by construction.
    WrongSecret,
    /// The file exists but is not a readable vault.
    Corrupt(String),
    /// The secret does not meet [`MIN_SECRET_LEN`] / [`MAX_SECRET_BYTES`].
    Secret(String),
    Io(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Deliberately credential-free: these strings reach the UI and, from
            // there, potentially a log.
            VaultError::Missing => write!(formatter, "No credentials saved yet."),
            VaultError::WrongSecret => write!(formatter, "That secret does not open the vault."),
            VaultError::Corrupt(detail) => write!(formatter, "The vault file is unreadable: {}", detail),
            VaultError::Secret(detail) => write!(formatter, "{}", detail),
            VaultError::Io(detail) => write!(formatter, "Vault file error: {}", detail),
        }
    }
}

impl From<VaultError> for String {
    fn from(error: VaultError) -> String {
        error.to_string()
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct Envelope {
    v: u32,
    kdf: KdfParams,
    aead: AeadPayload,
    /// Absent in a vault written before the index existed. Whether it is there is
    /// part of the additional data the ciphertext is bound to, so the field can be
    /// neither added nor removed from an existing file without failing the tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    index: Option<Index>,
}

/// Which origins a vault holds, as salted hashes.
///
/// The one part of the contents that is readable without the secret, deliberately:
/// the launcher has to know whether a bookmark's key control is grey (nothing
/// saved) or green (a login is), and answering that must not require unlocking
/// anything. Hashes rather than names keep the file from listing what it holds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct Index {
    /// Base64, like every other byte string in the envelope. The origin hashes
    /// below are hex instead: they are compared and joined as text, never decoded.
    salt: String,
    /// Sorted, so membership is a binary search and the bytes are reproducible.
    origins: Vec<String>,
}

impl Index {
    /// Built from the entries at write time, so it cannot drift from them: the
    /// only way to change what the index says is to rewrite the vault.
    fn build(entries: &BTreeMap<String, Credential>, salt: &[u8]) -> Index {
        let mut origins: Vec<String> = entries.keys().map(|origin| index_hash(salt, origin)).collect();
        origins.sort_unstable();
        origins.dedup();
        Index { salt: encode_base64(salt), origins }
    }

    fn contains(&self, origin: &str) -> bool {
        let Ok(salt) = decode_base64(&self.salt) else {
            return false;
        };
        self.origins.binary_search(&index_hash(&salt, origin)).is_ok()
    }

    fn len(&self) -> usize {
        self.origins.len()
    }
}

/// `sha256(salt || origin)`, hex, so the envelope stays JSON text.
///
/// Not a password hash and not pretending to be one: an origin is a hostname, so
/// anyone holding the file can hash candidates and test them. What this buys is
/// that the file does not *say* which instances are in it.
fn index_hash(salt: &[u8], origin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(origin.as_bytes());
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{:02x}", byte);
    }
    out
}

fn encode_base64(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, VaultError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD
        .decode(value)
        .map_err(|error| VaultError::Corrupt(format!("bad base64: {}", error)))
}

#[derive(Serialize, Deserialize, Debug)]
struct KdfParams {
    id: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct AeadPayload {
    id: String,
    nonce: String,
    ct: String,
}

/// An unlocked vault, held in memory for the session.
///
/// The derived key is kept rather than the secret: saving another instance has to
/// re-encrypt the file, and re-deriving would mean keeping the secret itself in
/// memory for the whole session. Locking drops the key (zeroized) and the
/// plaintext map.
pub struct Unlocked {
    key: [u8; KEY_BYTES],
    salt: Vec<u8>,
    params: (u32, u32, u32),
    entries: BTreeMap<String, Credential>,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        self.key.zeroize();
        for entry in self.entries.values_mut() {
            entry.password.zeroize();
        }
    }
}

impl fmt::Debug for Unlocked {
    /// Redacted deliberately: a derived `Debug` would put the derived key and
    /// every stored password into any panic message or assertion that printed it.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Unlocked")
            .field("entries", &self.entries.len())
            .field("key", &"<redacted>")
            .finish()
    }
}

impl Unlocked {
    pub fn summaries(&self) -> Vec<CredentialSummary> {
        self.entries
            .iter()
            .map(|(origin, entry)| CredentialSummary {
                origin: origin.clone(),
                user: entry.user.clone(),
            })
            .collect()
    }

    pub fn credential_for(&self, origin: &str) -> Option<&Credential> {
        self.entries.get(origin)
    }

    pub fn remember(&mut self, origin: String, user: String, password: String) {
        self.entries.insert(origin, Credential { user, password });
    }

    pub fn forget(&mut self, origin: &str) -> bool {
        self.entries.remove(origin).is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// One credential, lent to the app for as long as an instance takes to load.
///
/// Unlocking is not session state: the secret is asked for when a bookmarked
/// instance is opened, the credential it protects is held just long enough for the
/// app to answer that instance's own password challenge, and then it is dropped.
/// Everything through here is a lookup — the KDF is never run from the webview's
/// thread, where a 64 MiB derivation would freeze the window while it waits.
pub struct Grant {
    origin: String,
    user: String,
    password: String,
    expires_at: Instant,
}

/// How long a grant outlives the moment it was made.
///
/// It has to survive the navigation it was made for: the webview asks for the
/// password only once the server has answered 401, which is after the launcher has
/// left the page, and nothing reports when that has happened. So it expires on a
/// clock instead — long enough for a slow instance to load, short enough that a
/// credential is not sitting in memory for the rest of the session. Returning to
/// the launcher drops it immediately.
pub const GRANT_TTL: Duration = Duration::from_secs(120);

impl Grant {
    pub fn new(origin: String, user: String, password: String) -> Grant {
        Grant::with_ttl(origin, user, password, GRANT_TTL)
    }

    fn with_ttl(origin: String, user: String, password: String, ttl: Duration) -> Grant {
        Grant { origin, user, password, expires_at: Instant::now() + ttl }
    }

    /// The credential for `origin` — when this grant is for that origin and has
    /// not expired. Origin-exact, the same rule the rest of the vault uses.
    pub fn credential_for(&self, origin: &str) -> Option<(&str, &str)> {
        if !self.is_live() || self.origin != origin {
            return None;
        }
        Some((&self.user, &self.password))
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn is_live(&self) -> bool {
        Instant::now() < self.expires_at
    }
}

impl Drop for Grant {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

impl fmt::Debug for Grant {
    /// Redacted for the same reason [`Unlocked`]'s is.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Grant")
            .field("origin", &self.origin)
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// Hard rules for a secret. Anything that passes is usable; anything that fails
/// is refused with a reason the UI can show verbatim.
pub fn validate_secret(secret: &str) -> Result<(), VaultError> {
    if secret.chars().count() < MIN_SECRET_LEN {
        return Err(VaultError::Secret(format!(
            "Use at least {} characters — the secret is what protects every saved password.",
            MIN_SECRET_LEN
        )));
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err(VaultError::Secret(format!(
            "Keep the secret under {} bytes.",
            MAX_SECRET_BYTES
        )));
    }
    Ok(())
}

/// A soft warning, not a refusal: a short secret made only of digits is the one
/// case worth saying out loud, with the cost attached to it.
pub fn weak_secret_warning(secret: &str) -> Option<String> {
    let digits = secret.chars().all(|character| character.is_ascii_digit());
    let length = secret.chars().count();
    if !digits || length >= 10 {
        return None;
    }
    // 10^length guesses at this vault's own KDF cost. The 0.3 s per guess is the
    // measured-ish cost of m=64 MiB / t=3 on a desktop core; the point of the
    // warning is the shape of the curve, not the second decimal of it.
    let space = 10f64.powi(length as i32);
    let single_core = space * 0.3;
    let eight_cores = single_core / 8.0;
    let phrase = |seconds: f64| {
        if seconds < 3600.0 {
            format!("{} minutes", (seconds / 60.0).ceil().max(1.0))
        } else if seconds < 86_400.0 {
            format!("{} hours", (seconds / 3600.0).ceil())
        } else {
            format!("{} days", (seconds / 86_400.0).ceil())
        }
    };
    Some(format!(
        "{} digits is only {} combinations — about {} of guessing on one core, or {} spread across eight. Letters, or simply more characters, make that number useless.",
        length,
        thousands(space as u64),
        phrase(single_core),
        phrase(eight_cores)
    ))
}

/// `1000` → `1,000`. The warning is about a number, and a number that is not
/// readable does not do its job.
fn thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(character);
    }
    out
}

/// The vault's key: `origin` for `user:password` credentials.
///
/// Yields `scheme://host[:port]` with no path, query or fragment, because that is
/// exactly the scope HTTP Basic auth applies to — and the scope the webview's
/// auth challenge is matched against, so the two must agree on the shape.
pub fn normalize_origin(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A bookmark stores a bare origin, but the launcher also hands over full URLs
    // (`https://host/?lithic-from=...`), so both have to normalise the same way.
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    let rest = with_scheme.split_once("://")?;
    let scheme = rest.0.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.1.split(['/', '?', '#']).next()?;
    // Credentials embedded in the URL are refused: they are the shape a phisher
    // uses to make a host look like another one, and nothing here needs them.
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let authority = authority.to_ascii_lowercase();
    // A bracketed literal has to be split on the colon *after* the bracket, since
    // `[::1]:8080` contains three of them.
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(port.to_string()),
            None if tail.is_empty() => None,
            None => return None,
        };
        (format!("[{}]", host), port)
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host.to_string(), Some(port.to_string())),
            None => (authority.clone(), None),
        }
    };
    // A port has to be a port. This is what stops `javascript:alert(1)` — which
    // arrives here as the authority `javascript:alert(1)` — from reading as a host
    // with an odd port and becoming a "valid" origin.
    if let Some(port) = &port {
        if port.is_empty() || !port.chars().all(|character| character.is_ascii_digit()) || port.parse::<u16>().is_err() {
            return None;
        }
    }
    let host_is_sane = !host.is_empty()
        && ((host.starts_with('[') && host.ends_with(']'))
            || host
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')));
    if !host_is_sane {
        return None;
    }
    // Drop a default port so `https://host:443` and `https://host` are one origin
    // rather than two entries holding the same password.
    match (scheme.as_str(), port.as_deref()) {
        ("https", Some("443")) | ("http", Some("80")) => Some(format!("{}://{}", scheme, host)),
        (_, Some(port)) => Some(format!("{}://{}:{}", scheme, host, port)),
        (_, None) => Some(format!("{}://{}", scheme, host)),
    }
}

/// The `Authorization` header value for one credential.
///
/// Base64 of `user:password`, per RFC 7617. Note what that is *not*: encryption.
/// Over plain HTTP the password is readable by anything on the path, which is why
/// the UI warns rather than refuses (a self-hosted instance on a home network, and
/// the ESP32 deployment, are frequently http-only).
pub fn basic_header(user: &str, password: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    format!("Basic {}", STANDARD.encode(format!("{}:{}", user, password)))
}

fn derive_key(secret: &str, salt: &[u8], params: (u32, u32, u32)) -> Result<[u8; KEY_BYTES], VaultError> {
    let (m, t, p) = params;
    let params = Params::new(m, t, p, Some(KEY_BYTES))
        .map_err(|error| VaultError::Corrupt(format!("bad KDF parameters: {}", error)))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_BYTES];
    argon
        .hash_password_into(secret.as_bytes(), salt, &mut key)
        .map_err(|error| VaultError::Corrupt(format!("key derivation failed: {}", error)))?;
    Ok(key)
}

/// The additional data bound to the ciphertext: the version, the KDF, its
/// parameters, and the origin index. Editing any of them invalidates the tag, so
/// the file cannot be rewritten into a cheaper vault that still opens with the
/// same secret — nor have an origin added to or removed from its index.
///
/// A vault with no index produces exactly the bytes this produced before the index
/// existed, which is what lets an older file keep opening; the tag is what stops
/// one being written today and then downgraded by hand.
fn envelope_aad(version: u32, kdf: &KdfParams, index: Option<&Index>) -> Vec<u8> {
    let mut aad = format!(
        "lithic-vault:{}:{}:m={},t={},p={}:salt={}",
        version, kdf.id, kdf.m, kdf.t, kdf.p, kdf.salt
    );
    if let Some(index) = index {
        aad.push_str(&format!(":index={}:{}", index.salt, index.origins.join(",")));
    }
    aad.into_bytes()
}

fn random_bytes(count: usize) -> Result<Vec<u8>, VaultError> {
    let mut buffer = vec![0u8; count];
    getrandom::getrandom(&mut buffer).map_err(|error| VaultError::Io(error.to_string()))?;
    Ok(buffer)
}

/// Write the vault out with the index derived from its entries.
fn encrypt(
    key: &[u8; KEY_BYTES],
    salt: Vec<u8>,
    params: (u32, u32, u32),
    entries: &BTreeMap<String, Credential>,
) -> Result<Envelope, VaultError> {
    let index = Index::build(entries, &random_bytes(INDEX_SALT_BYTES)?);
    encrypt_with(key, salt, params, entries, Some(index))
}

/// The body of [`encrypt`], with the index given rather than derived — which is
/// what lets a test write the kind of file this build used to write.
fn encrypt_with(
    key: &[u8; KEY_BYTES],
    salt: Vec<u8>,
    params: (u32, u32, u32),
    entries: &BTreeMap<String, Credential>,
    index: Option<Index>,
) -> Result<Envelope, VaultError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let kdf = KdfParams {
        id: KDF_ID.to_string(),
        m: params.0,
        t: params.1,
        p: params.2,
        salt: STANDARD.encode(&salt),
    };
    let nonce = random_bytes(NONCE_BYTES)?;
    let plaintext = serde_json::to_vec(entries).map_err(|error| VaultError::Io(error.to_string()))?;
    let cipher = XChaCha20Poly1305::new(key.into());
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload { msg: &plaintext, aad: &envelope_aad(FORMAT_VERSION, &kdf, index.as_ref()) },
        )
        .map_err(|_| VaultError::Corrupt("could not encrypt the vault".to_string()))?;
    Ok(Envelope {
        v: FORMAT_VERSION,
        kdf,
        aead: AeadPayload {
            id: AEAD_ID.to_string(),
            nonce: STANDARD.encode(&nonce),
            ct: STANDARD.encode(&ct),
        },
        index,
    })
}

/// The key and parameters of an unlocked vault, so later saves can re-encrypt
/// without the secret. `entries` is decoded separately because a caller may only
/// want the shape.
fn key_from_envelope(envelope: &Envelope, secret: &str) -> Result<([u8; KEY_BYTES], Vec<u8>), VaultError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    if envelope.v != FORMAT_VERSION {
        return Err(VaultError::Corrupt(format!(
            "version {} vault, this build reads version {}",
            envelope.v, FORMAT_VERSION
        )));
    }
    if envelope.kdf.id != KDF_ID || envelope.aead.id != AEAD_ID {
        return Err(VaultError::Corrupt(format!(
            "unknown algorithms ({} / {})",
            envelope.kdf.id, envelope.aead.id
        )));
    }
    let salt = STANDARD
        .decode(&envelope.kdf.salt)
        .map_err(|error| VaultError::Corrupt(format!("bad salt: {}", error)))?;
    let key = derive_key(secret, &salt, (envelope.kdf.m, envelope.kdf.t, envelope.kdf.p))?;
    Ok((key, salt))
}

fn decode(envelope: &Envelope, key: &[u8; KEY_BYTES]) -> Result<BTreeMap<String, Credential>, VaultError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let nonce = STANDARD
        .decode(&envelope.aead.nonce)
        .map_err(|error| VaultError::Corrupt(format!("bad nonce: {}", error)))?;
    if nonce.len() != NONCE_BYTES {
        return Err(VaultError::Corrupt("nonce is the wrong length".to_string()));
    }
    let ct = STANDARD
        .decode(&envelope.aead.ct)
        .map_err(|error| VaultError::Corrupt(format!("bad ciphertext: {}", error)))?;
    let cipher = XChaCha20Poly1305::new(key.into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload { msg: &ct, aad: &envelope_aad(envelope.v, &envelope.kdf, envelope.index.as_ref()) },
        )
        // A failed tag is either a wrong secret or an edited envelope, and the two
        // are indistinguishable from here — which is the point. Callers treat this
        // as "wrong secret", because that is the recoverable one.
        .map_err(|_| VaultError::WrongSecret)?;
    serde_json::from_slice(&plaintext).map_err(|error| VaultError::Corrupt(error.to_string()))
}

fn parse_vault(bytes: &[u8]) -> Result<Envelope, VaultError> {
    serde_json::from_slice(bytes).map_err(|error| VaultError::Corrupt(error.to_string()))
}

/// Read an existing vault file, without a secret, for the writes that need its
/// parameters (nothing here can decrypt without the key).
fn read_envelope(path: &Path) -> Result<Envelope, VaultError> {
    let bytes = fs::read(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => VaultError::Missing,
        _ => VaultError::Io(error.to_string()),
    })?;
    parse_vault(&bytes)
}

/// Open the vault with `secret`, returning everything needed for the session.
pub fn unlock(path: &Path, secret: &str) -> Result<Unlocked, VaultError> {
    validate_secret(secret)?;
    let envelope = read_envelope(path)?;
    let (key, salt) = key_from_envelope(&envelope, secret)?;
    let entries = decode(&envelope, &key)?;
    Ok(Unlocked {
        key,
        salt,
        params: (envelope.kdf.m, envelope.kdf.t, envelope.kdf.p),
        entries,
    })
}

/// Write the vault out, atomically.
///
/// Temp file plus rename: a crash or a full disk mid-write must not leave a
/// half-written vault, because that file is the only copy of every saved
/// password. The salt is reused (it is already bound into the derived key) and a
/// fresh nonce is generated per write.
fn write(path: &Path, vault: &Unlocked) -> Result<(), VaultError> {
    let envelope = encrypt(&vault.key, vault.salt.clone(), vault.params, &vault.entries)?;
    let body = serde_json::to_vec_pretty(&envelope).map_err(|error| VaultError::Io(error.to_string()))?;
    let temporary = path.with_extension("vault.tmp");
    fs::write(&temporary, &body).map_err(|error| VaultError::Io(error.to_string()))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        VaultError::Io(error.to_string())
    })
}

/// Create a vault with `secret`, replacing any existing one. Used by the first
/// unlock (nothing saved yet) and by "start over" after a forgotten secret.
pub fn create(path: &Path, secret: &str, entries: BTreeMap<String, Credential>) -> Result<Unlocked, VaultError> {
    validate_secret(secret)?;
    let salt = random_bytes(SALT_BYTES)?;
    let params = (M_COST_KIB, T_COST, P_COST);
    let key = derive_key(secret, &salt, params)?;
    let mut vault = Unlocked { key, salt, params, entries };
    if vault.is_empty() {
        // An empty vault is a legitimate state (the last credential removed), and
        // it still holds the secret so the next save does not ask again.
        vault.entries = BTreeMap::new();
    }
    write(path, &vault)?;
    Ok(vault)
}

/// Re-encrypt an open vault under a new secret.
///
/// Only the manager can call this, and only while the vault is open: the key being
/// replaced is already in memory, so the old secret does not have to be typed
/// again. The new key gets a fresh salt, so the two secrets share no derivation,
/// and every entry is re-encrypted in one write.
pub fn rotate(path: &Path, vault: &mut Unlocked, secret: &str) -> Result<(), VaultError> {
    validate_secret(secret)?;
    let salt = random_bytes(SALT_BYTES)?;
    let params = (M_COST_KIB, T_COST, P_COST);
    let key = derive_key(secret, &salt, params)?;
    vault.key.zeroize();
    vault.key = key;
    vault.salt = salt;
    vault.params = params;
    write(path, vault)
}

/// Persist a mutation to an already-unlocked vault.
pub fn save(path: &Path, vault: &Unlocked) -> Result<(), VaultError> {
    write(path, vault)
}

/// Which of `origins` the vault holds a login for.
///
/// Answered from the envelope alone, so it works while the vault is locked — which
/// is the whole point of the index. An unreadable file covers nothing, the same
/// answer as an empty vault, and leaves the UI showing grey rather than claiming a
/// login it cannot produce.
pub fn coverage(path: &Path, origins: &[String]) -> Vec<String> {
    let Ok(envelope) = read_envelope(path) else {
        return Vec::new();
    };
    let Some(index) = envelope.index.as_ref() else {
        return Vec::new();
    };
    origins.iter().filter(|origin| index.contains(origin)).cloned().collect()
}

/// How many logins the file holds, from the envelope alone.
pub fn stored_count(path: &Path) -> usize {
    read_envelope(path)
        .ok()
        .and_then(|envelope| envelope.index.map(|index| index.len()))
        .unwrap_or(0)
}

/// Delete the vault. The only "recovery" this design has, and it costs the
/// saved passwords rather than the files they belong to.
pub fn destroy(path: &Path) -> Result<(), VaultError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(VaultError::Io(error.to_string())),
    }
}

/// Where the vault lives: beside the executable when that folder is writable
/// (a portable bundle keeps its state with it, exactly like `recents.txt`), and
/// in the user's app data directory otherwise — which is where an installed copy
/// under `Program Files` has to keep it.
pub fn vault_path(exe_dir: Option<PathBuf>, app_data: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = exe_dir {
        let beside = dir.join(VAULT_FILE);
        if beside.exists() || crate::dir_writable(&dir) {
            return beside;
        }
    }
    app_data
        .map(|dir| dir.join(VAULT_FILE))
        .unwrap_or_else(|| PathBuf::from(VAULT_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A secret long enough to be accepted, used by every test that is not about
    /// the rules themselves.
    const SECRET: &str = "correct-horse";
    const FIXTURE_PASSWORD: &str = "hunter2-not-a-real-password";

    fn temporary_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lithic-vault-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    fn entries() -> BTreeMap<String, Credential> {
        let mut map = BTreeMap::new();
        map.insert(
            "https://personal.lithic.uk".to_string(),
            Credential { user: "admin".to_string(), password: FIXTURE_PASSWORD.to_string() },
        );
        map
    }

    #[test]
    fn round_trips_credentials() {
        let dir = temporary_dir("roundtrip");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let opened = unlock(&path, SECRET).expect("unlock");
        assert_eq!(opened.summaries(), vec![CredentialSummary {
            origin: "https://personal.lithic.uk".to_string(),
            user: "admin".to_string(),
        }]);
        assert_eq!(
            opened.credential_for("https://personal.lithic.uk").map(|entry| entry.password.as_str()),
            Some(FIXTURE_PASSWORD)
        );
    }

    #[test]
    fn a_wrong_secret_fails_and_leaves_the_file_alone() {
        let dir = temporary_dir("wrongsecret");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let before = fs::read(&path).expect("read");
        assert!(
            matches!(unlock(&path, "wrong-secret"), Err(VaultError::WrongSecret)),
            "a wrong secret must not open the vault"
        );
        assert_eq!(fs::read(&path).expect("read"), before, "a failed unlock must not rewrite the vault");
        assert!(unlock(&path, SECRET).is_ok(), "the right secret still opens it");
    }

    #[test]
    fn the_file_never_contains_the_password_or_the_host() {
        let dir = temporary_dir("plaintext");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let raw = fs::read_to_string(&path).expect("read");
        assert!(!raw.contains(FIXTURE_PASSWORD), "the password is in the file in the clear");
        assert!(!raw.contains(SECRET), "the secret is in the file");
        // Origins and usernames are inside the ciphertext, so a copied file does
        // not say which instances it holds. The index answers questions *about*
        // origins without naming any of them.
        assert!(!raw.contains("personal.lithic.uk"), "the origin is readable without the secret");
        assert!(!raw.contains("admin"), "the username is readable without the secret");
        // The envelope stays readable, which is what keeps the file diagnosable.
        assert!(raw.contains("argon2id") && raw.contains("xchacha20poly1305"));
        assert!(raw.contains("\"index\""), "the index is what colours a bookmark's key control");
    }

    #[test]
    fn refuses_a_short_secret_and_accepts_anything_longer() {
        assert!(matches!(validate_secret("12345"), Err(VaultError::Secret(_))));
        assert!(validate_secret("123456").is_ok(), "six characters, digits or not");
        assert!(validate_secret("sixchr").is_ok());
        assert!(validate_secret("a 6-char secret with spaces").is_ok());
        let long = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(matches!(validate_secret(&long), Err(VaultError::Secret(_))));
    }

    #[test]
    fn the_secret_is_taken_exactly_as_typed() {
        let dir = temporary_dir("exact");
        let path = dir.join(VAULT_FILE);
        create(&path, "  spaced secret  ", entries()).expect("create");
        // Whitespace is part of the secret, not decoration: trimming it on either
        // side would silently accept a different secret than the one that was set.
        assert!(
            matches!(unlock(&path, "spaced secret"), Err(VaultError::WrongSecret)),
            "a trimmed secret must not open the vault"
        );
        assert!(unlock(&path, "  spaced secret  ").is_ok(), "the exact secret still opens it");
    }

    #[test]
    fn warns_only_about_short_all_digit_secrets() {
        let warning = weak_secret_warning("123456").expect("six digits is worth warning about");
        assert!(warning.contains("1,000,000"), "the warning carries the number: {}", warning);
        assert!(warning.contains("one core"), "and what it costs: {}", warning);
        assert!(weak_secret_warning("1234567890").is_none(), "ten digits is past the point of the warning");
        assert!(weak_secret_warning("hunter2xx").is_none(), "letters make it a different question");
    }

    #[test]
    fn a_tampered_envelope_fails_instead_of_weakening_the_kdf() {
        let dir = temporary_dir("tampered");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let raw = fs::read_to_string(&path).expect("read");
        for replacement in [
            raw.replace("\"m\": 65536", "\"m\": 8"),
            raw.replace("\"t\": 3", "\"t\": 1"),
            raw.replace("\"p\": 1", "\"p\": 4"),
        ] {
            assert_ne!(replacement, raw, "the fixture did not contain what this test edits");
            fs::write(&path, &replacement).expect("write");
            assert!(
                matches!(unlock(&path, SECRET), Err(VaultError::WrongSecret)),
                "edited KDF parameters must not produce a key that opens the vault"
            );
        }
    }

    #[test]
    fn a_truncated_or_foreign_file_is_corrupt_not_a_crash() {
        let dir = temporary_dir("corrupt");
        let path = dir.join(VAULT_FILE);
        fs::write(&path, b"{ this is not json").expect("write");
        assert!(matches!(unlock(&path, SECRET), Err(VaultError::Corrupt(_))));

        create(&path, SECRET, entries()).expect("create");
        let mut bytes = fs::read(&path).expect("read");
        bytes.truncate(bytes.len() / 2);
        fs::write(&path, &bytes).expect("write");
        assert!(matches!(unlock(&path, SECRET), Err(VaultError::Corrupt(_))));

        fs::write(&path, b"{\"v\":99,\"kdf\":{\"id\":\"argon2id\",\"m\":1,\"t\":1,\"p\":1,\"salt\":\"\"},\"aead\":{\"id\":\"xchacha20poly1305\",\"nonce\":\"\",\"ct\":\"\"}}").expect("write");
        match unlock(&path, SECRET) {
            Err(VaultError::Corrupt(detail)) => assert!(detail.contains("version 99"), "{}", detail),
            other => panic!("expected a version complaint, got {:?}", other.map(|_| ())),
        }
    }

    #[test]
    fn a_missing_file_is_missing_not_corrupt() {
        let dir = temporary_dir("missing");
        assert!(
            matches!(unlock(&dir.join(VAULT_FILE), SECRET), Err(VaultError::Missing)),
            "no vault is not a corrupt vault"
        );
    }

    #[test]
    fn saving_and_forgetting_rewrites_the_vault() {
        let dir = temporary_dir("mutate");
        let path = dir.join(VAULT_FILE);
        let mut vault = create(&path, SECRET, entries()).expect("create");
        vault.remember("http://192.168.1.42".to_string(), "esp32".to_string(), "lan-pass".to_string());
        save(&path, &vault).expect("save");

        let reopened = unlock(&path, SECRET).expect("unlock");
        assert_eq!(reopened.summaries().len(), 2);
        assert_eq!(
            reopened.credential_for("http://192.168.1.42").map(|entry| entry.user.as_str()),
            Some("esp32")
        );

        let mut vault = reopened;
        assert!(vault.forget("https://personal.lithic.uk"));
        assert!(!vault.forget("https://personal.lithic.uk"), "forgetting twice is not a change");
        save(&path, &vault).expect("save");
        assert_eq!(unlock(&path, SECRET).expect("unlock").summaries().len(), 1);
    }

    #[test]
    fn rotating_the_secret_re_encrypts_everything() {
        let dir = temporary_dir("rotate");
        let path = dir.join(VAULT_FILE);
        let mut vault = create(&path, SECRET, entries()).expect("create");
        rotate(&path, &mut vault, "a-much-longer-secret").expect("rotate");
        assert!(
            matches!(unlock(&path, SECRET), Err(VaultError::WrongSecret)),
            "the old secret must stop working"
        );
        let opened = unlock(&path, "a-much-longer-secret").expect("unlock with the new secret");
        assert_eq!(
            opened.credential_for("https://personal.lithic.uk").map(|entry| entry.password.as_str()),
            Some(FIXTURE_PASSWORD)
        );
        // The rotated vault is still the same vault: the manager stays open through
        // it, and the next save writes under the new key.
        vault.remember("http://192.168.1.42".to_string(), "esp32".to_string(), "lan-pass".to_string());
        save(&path, &vault).expect("save after rotate");
        assert_eq!(unlock(&path, "a-much-longer-secret").expect("reopen").summaries().len(), 2);
    }

    #[test]
    fn coverage_answers_while_locked_and_costs_no_key() {
        let dir = temporary_dir("coverage");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let asked = vec![
            "https://personal.lithic.uk".to_string(),
            "https://other.example".to_string(),
        ];
        // No secret appears anywhere in this call: that is the point of the index.
        assert_eq!(coverage(&path, &asked), vec!["https://personal.lithic.uk".to_string()]);
        assert_eq!(stored_count(&path), 1);

        let mut vault = unlock(&path, SECRET).expect("unlock");
        vault.remember("https://other.example".to_string(), "keeper".to_string(), "pw".to_string());
        save(&path, &vault).expect("save");
        assert_eq!(coverage(&path, &asked).len(), 2, "the index is derived at write time, so it cannot lag a save");
        assert_eq!(stored_count(&path), 2);

        vault.forget("https://other.example");
        save(&path, &vault).expect("save");
        assert_eq!(coverage(&path, &asked), vec!["https://personal.lithic.uk".to_string()]);
        assert_eq!(stored_count(&path), 1);
    }

    #[test]
    fn a_missing_or_corrupt_vault_covers_nothing() {
        let dir = temporary_dir("nocoverage");
        let path = dir.join(VAULT_FILE);
        let asked = vec!["https://personal.lithic.uk".to_string()];
        assert!(coverage(&path, &asked).is_empty(), "no file, nothing covered");
        assert_eq!(stored_count(&path), 0);
        fs::write(&path, b"{ this is not json").expect("write");
        assert!(coverage(&path, &asked).is_empty(), "an unreadable file covers nothing rather than claiming a login");
        assert_eq!(stored_count(&path), 0);
    }

    #[test]
    fn the_index_is_bound_to_the_ciphertext() {
        let dir = temporary_dir("indexedit");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let raw = fs::read_to_string(&path).expect("read");
        let asked = vec!["https://personal.lithic.uk".to_string()];

        // Swapping one hash for another must not be a way to make the vault claim
        // a login it does not have, or to hide one it does.
        let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        let origins = value["index"]["origins"].as_array_mut().expect("index origins");
        assert_eq!(origins.len(), 1, "the fixture has exactly one entry to edit");
        let original = origins[0].as_str().expect("hash").to_string();
        let first = original.chars().next().expect("hash is not empty");
        let swapped = if first == '0' { '1' } else { '0' };
        let tampered = format!("{}{}", swapped, &original[first.len_utf8()..]);
        assert_ne!(tampered, original, "the edit has to actually change a byte");
        assert_eq!(tampered.len(), original.len(), "and keep it a well-formed hash");
        origins[0] = serde_json::Value::String(tampered);
        fs::write(&path, serde_json::to_vec_pretty(&value).expect("serialise")).expect("write");
        assert!(
            matches!(unlock(&path, SECRET), Err(VaultError::WrongSecret)),
            "an edited index must fail the tag rather than answering from it"
        );
        assert!(coverage(&path, &asked).is_empty(), "and an edited index must not colour a control green");

        // Deleting the field is the same attack with fewer keystrokes: the bytes the
        // tag was made over included the index, so this is no longer that file.
        fs::write(&path, &raw).expect("restore");
        let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        value.as_object_mut().expect("an object").remove("index");
        fs::write(&path, serde_json::to_vec_pretty(&value).expect("serialise")).expect("write");
        assert!(
            matches!(unlock(&path, SECRET), Err(VaultError::WrongSecret)),
            "removing the index must not quietly open the vault"
        );
    }

    #[test]
    fn a_vault_written_before_the_index_still_opens() {
        let dir = temporary_dir("legacy");
        let path = dir.join(VAULT_FILE);
        // Byte for byte the shape this build used to write: no index, and therefore
        // the older additional data, which is what has to keep opening.
        let salt = random_bytes(SALT_BYTES).expect("salt");
        let params = (M_COST_KIB, T_COST, P_COST);
        let key = derive_key(SECRET, &salt, params).expect("key");
        let envelope = encrypt_with(&key, salt, params, &entries(), None).expect("encrypt");
        fs::write(&path, serde_json::to_vec_pretty(&envelope).expect("serialise")).expect("write");
        assert!(
            !fs::read_to_string(&path).expect("read").contains("\"index\""),
            "the fixture has to be the old shape"
        );

        let mut opened = unlock(&path, SECRET).expect("an older vault still opens");
        assert_eq!(
            opened.credential_for("https://personal.lithic.uk").map(|entry| entry.user.as_str()),
            Some("admin")
        );
        assert!(coverage(&path, &["https://personal.lithic.uk".to_string()]).is_empty(), "an unindexed vault says nothing");
        assert_eq!(stored_count(&path), 0);
        // The next write is a modern one, so a single edit upgrades the file.
        opened.remember("https://other.example".to_string(), "keeper".to_string(), "pw".to_string());
        save(&path, &opened).expect("save");
        assert_eq!(
            coverage(&path, &["https://other.example".to_string()]),
            vec!["https://other.example".to_string()]
        );
        assert_eq!(stored_count(&path), 2, "and carries the entries it already had");
    }

    #[test]
    fn a_grant_is_for_one_origin_expires_and_hides_its_password() {
        let grant = Grant::new(
            "https://personal.lithic.uk".to_string(),
            "admin".to_string(),
            FIXTURE_PASSWORD.to_string(),
        );
        assert_eq!(grant.credential_for("https://personal.lithic.uk"), Some(("admin", FIXTURE_PASSWORD)));
        assert_eq!(grant.credential_for("https://evil-lithic.uk"), None, "a grant covers its own origin only");
        assert_eq!(grant.credential_for("http://personal.lithic.uk"), None, "and the scheme is part of that");
        assert!(grant.is_live(), "a grant outlives the navigation it was made for");
        assert_eq!(grant.origin(), "https://personal.lithic.uk");
        let rendered = format!("{:?}", grant);
        assert!(!rendered.contains(FIXTURE_PASSWORD), "a Debug of a grant must not carry the password: {}", rendered);
        assert!(rendered.contains("<redacted>"));

        // Expiry without a sleep: a grant made with no life left has none.
        let expired = Grant::with_ttl(
            "https://personal.lithic.uk".to_string(),
            "admin".to_string(),
            FIXTURE_PASSWORD.to_string(),
            Duration::ZERO,
        );
        assert!(!expired.is_live());
        assert_eq!(expired.credential_for("https://personal.lithic.uk"), None);
    }

    #[test]
    fn destroying_the_vault_is_idempotent() {
        let dir = temporary_dir("destroy");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        destroy(&path).expect("destroy");
        destroy(&path).expect("destroy again");
        assert!(matches!(unlock(&path, SECRET), Err(VaultError::Missing)));
    }

    #[test]
    fn origins_normalise_to_the_scope_basic_auth_applies_to() {
        for (input, expected) in [
            ("https://personal.lithic.uk", "https://personal.lithic.uk"),
            ("https://personal.lithic.uk/", "https://personal.lithic.uk"),
            ("https://personal.lithic.uk/?lithic-from=x&mode=self-host", "https://personal.lithic.uk"),
            ("https://PERSONAL.Lithic.uk/sync/", "https://personal.lithic.uk"),
            ("https://personal.lithic.uk:443/", "https://personal.lithic.uk"),
            ("http://192.168.1.42:8080/sync/", "http://192.168.1.42:8080"),
            ("http://192.168.1.42:80/", "http://192.168.1.42"),
            ("personal.lithic.uk", "https://personal.lithic.uk"),
            ("  https://personal.lithic.uk  ", "https://personal.lithic.uk"),
        ] {
            assert_eq!(normalize_origin(input).as_deref(), Some(expected), "input: {}", input);
        }
        for rejected in ["", "   ", "ftp://host/", "javascript:alert(1)", "https://", "https://user@host/"] {
            assert_eq!(normalize_origin(rejected), None, "should be refused: {}", rejected);
        }
    }

    #[test]
    fn an_origin_never_covers_a_neighbour() {
        // The scope has to be exact: otherwise a credential saved for one host
        // would be offered to another that merely shares a suffix.
        assert_ne!(normalize_origin("https://lithic.uk"), normalize_origin("https://evil-lithic.uk"));
        assert_ne!(normalize_origin("https://personal.lithic.uk"), normalize_origin("https://lithic.uk"));
        assert_ne!(normalize_origin("http://host"), normalize_origin("https://host"));
    }

    #[test]
    fn basic_header_is_the_documented_encoding() {
        assert_eq!(basic_header("admin", "secret"), "Basic YWRtaW46c2VjcmV0");
        assert_eq!(basic_header("Aladdin", "open sesame"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    }

    #[test]
    fn errors_never_carry_a_credential() {
        let dir = temporary_dir("errortext");
        let path = dir.join(VAULT_FILE);
        create(&path, SECRET, entries()).expect("create");
        let rendered = [
            VaultError::WrongSecret.to_string(),
            VaultError::Missing.to_string(),
            unlock(&path, "nope-nope").unwrap_err().to_string(),
        ]
        .join(" ");
        assert!(!rendered.contains(FIXTURE_PASSWORD));
        assert!(!rendered.contains(SECRET));
    }

    #[test]
    fn the_vault_prefers_the_executable_folder_but_falls_back() {
        let beside = temporary_dir("beside");
        assert_eq!(vault_path(Some(beside.clone()), Some(PathBuf::from("/appdata"))), beside.join(VAULT_FILE));
        // No executable folder at all (mobile, or an unresolvable path).
        assert_eq!(
            vault_path(None, Some(PathBuf::from("/appdata"))),
            PathBuf::from("/appdata").join(VAULT_FILE)
        );
    }
}
