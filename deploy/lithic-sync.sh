#!/bin/bash
# ==============================================================================
# Lithic Patch Sync — API Handler (CGI)
#
# Git-backed save path for the self-hosted launcher.
#
# The legacy launcher re-serialized the whole wiki and PUT the entire `.lith`
# over WebDAV on every save. Here the client instead diffs the text it loaded
# against the text it now has, and sends only the patch. This handler checks the
# patch is against the revision the client actually loaded, applies it with
# `git apply`, and commits it — so git is the source of truth for wiki history
# and rollback, while the on-disk `.lith` keeps its plain-text form. WebDAV
# access, VS Code, `cp -r /data` backups, the sync watcher and GitHub restore
# therefore all keep working untouched.
#
# Routes (all under /api/lithic/):
#   GET  ping                     -> capability probe; older servers 404 here
#   GET  file?file=X.lith         -> raw text + X-Lithic-Digest / X-Lithic-Rev
#   POST apply                    -> body: "<file>\n<base digest>\n<patch>"
#   GET  log?file=X.lith&limit=N  -> commit list for the rollback UI
#   POST restore                  -> body: "<file>\n<rev>" (checkout + commit)
#
# Why the request bodies are line-oriented instead of JSON: this CGI runs on an
# alpine image that ships bash/sed/curl/git and no JSON tooling, and a patch is
# made of quotes, tabs and newlines. Handing it to sed-based JSON parsing would
# corrupt it, so a patch body is framed as two header lines plus the patch
# remainder — the same shape as an HTTP message, trivially and losslessly
# splittable by `read`.
# ==============================================================================

DATA_DIR="${DATA_DIR:-/data}"
REQUEST_URI="${REQUEST_URI:-/}"
QUERY_STRING="${QUERY_STRING:-}"
METHOD="${REQUEST_METHOD:-GET}"
ROUTE="${REQUEST_URI%%\?*}"
LOCK_FILE="${DATA_DIR}/.git/lithic-apply.lock"
MAX_LOG_ENTRIES=200

# --- Response helpers ---
json_headers() {
    echo "Content-Type: application/json"
    echo "Cache-Control: no-store"
    echo ""
}

fail() { # status, error-token
    echo "Status: $1"
    json_headers
    printf '{"error":"%s"}\n' "$2"
    exit 0
}

urldecode() { # percent-decoding for query values
    local s="${1//+/ }"
    printf '%b' "${s//%/\\x}"
}

query_val() { # first value of the named query parameter
    printf '%s' "$QUERY_STRING" | tr '&' '\n' | sed -n "s/^$1=//p" | head -1
}

# Only ever touch a plain file directly under the WebDAV root. Rejects path
# traversal, subdirectories, hidden files and anything that is not a wiki.
valid_name() {
    case "$1" in
        ''|*/*|*\\*|.*|*..*) return 1 ;;
        *.lith|*.json) return 0 ;;
        *) return 1 ;;
    esac
}

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'
}

git_commit() { # message, path
    git -C "$DATA_DIR" \
        -c user.email="sync@lithic.uk" \
        -c user.name="Lithic Sync" \
        commit -q -m "$1" -- "$2" >/dev/null 2>&1
}

respond_ok() { # digest
    local rev
    rev="$(git -C "$DATA_DIR" rev-parse HEAD 2>/dev/null)"
    json_headers
    printf '{"status":"ok","digest":"%s","rev":"%s"}\n' "$1" "$rev"
}

# --- Capability probe -------------------------------------------------------
# The launcher probes this first: an instance without the patch API (an older
# deployment, or a plain WebDAV server) answers 404 and the client falls back to
# serializing and PUTing the whole file.
if [ "$ROUTE" = "/api/lithic/ping" ]; then
    json_headers
    printf '{"service":"lithic-sync","version":1,"git":true}\n'
    exit 0
fi

# --- Read a wiki ------------------------------------------------------------
if [ "$ROUTE" = "/api/lithic/file" ]; then
    FILE="$(urldecode "$(query_val file)")"
    valid_name "$FILE" || fail "400 Bad Request" "invalid_file_name"
    [ -f "${DATA_DIR}/${FILE}" ] || fail "404 Not Found" "file_not_found"

    DIGEST="$(git -C "$DATA_DIR" hash-object --no-filters "$FILE" 2>/dev/null)"
    REV="$(git -C "$DATA_DIR" rev-parse HEAD 2>/dev/null)"
    echo "Content-Type: text/plain; charset=utf-8"
    echo "X-Lithic-Digest: ${DIGEST}"
    echo "X-Lithic-Rev: ${REV}"
    echo "Cache-Control: no-store"
    echo ""
    cat "${DATA_DIR}/${FILE}"
    exit 0
fi

# --- Apply a patch ----------------------------------------------------------
if [ "$ROUTE" = "/api/lithic/apply" ] && [ "$METHOD" = "POST" ]; then
    # Serialize applies per instance so two saves can never interleave a
    # check-then-write window. Best effort: busybox usually provides flock.
    if command -v flock >/dev/null 2>&1; then
        exec 9>"${LOCK_FILE}" 2>/dev/null
        flock -w 20 9 2>/dev/null || fail "503 Service Unavailable" "busy"
    fi

    IFS= read -r FILE
    IFS= read -r BASE
    PATCH="$(cat)"

    valid_name "$FILE" || fail "400 Bad Request" "invalid_file_name"
    [ -n "$BASE" ] || fail "400 Bad Request" "missing_base"
    [ -n "$PATCH" ] || fail "400 Bad Request" "empty_patch"
    [ -f "${DATA_DIR}/${FILE}" ] || fail "404 Not Found" "file_not_found"

    CURRENT="$(git -C "$DATA_DIR" hash-object --no-filters "$FILE" 2>/dev/null)"
    if [ "$CURRENT" != "$BASE" ]; then
        # Optimistic concurrency: the file moved on (another device saved, or a
        # GitHub sync landed). Hand back the fresh digest so the caller can
        # re-read and retry rather than clobbering the newer content.
        echo "Status: 409 Conflict"
        json_headers
        printf '{"error":"stale","digest":"%s"}\n' "$CURRENT"
        exit 0
    fi

    PATCH_FILE="$(mktemp)"
    printf '%s\n' "$PATCH" > "$PATCH_FILE"
    APPLY_ERR="$(git -C "$DATA_DIR" apply --whitespace=nowarn "$PATCH_FILE" 2>&1)"
    APPLY_STATUS=$?
    rm -f "$PATCH_FILE"

    if [ "$APPLY_STATUS" -ne 0 ]; then
        DETAIL="$(printf '%s' "$APPLY_ERR" | tr '\n' ' ' | tr -d '"' | cut -c1-300)"
        fail "422 Unprocessable Entity" "patch_failed: ${DETAIL}"
    fi

    NEW_DIGEST="$(git -C "$DATA_DIR" hash-object --no-filters "$FILE" 2>/dev/null)"
    if [ "$NEW_DIGEST" = "$BASE" ]; then
        # Applied cleanly but the content is identical: nothing to record.
        respond_ok "$NEW_DIGEST"
        exit 0
    fi

    git -C "$DATA_DIR" add -- "$FILE" >/dev/null 2>&1
    if git -C "$DATA_DIR" diff --cached --quiet -- "$FILE" 2>/dev/null; then
        respond_ok "$NEW_DIGEST"
        exit 0
    fi
    if ! git_commit "Save ${FILE}" "$FILE"; then
        fail "500 Internal Server Error" "commit_failed"
    fi
    respond_ok "$NEW_DIGEST"
    exit 0
fi

# --- Commit history for one wiki --------------------------------------------
if [ "$ROUTE" = "/api/lithic/log" ]; then
    FILE="$(urldecode "$(query_val file)")"
    valid_name "$FILE" || fail "400 Bad Request" "invalid_file_name"
    LIMIT="$(query_val limit)"
    case "$LIMIT" in
        ''|*[!0-9]*) LIMIT=30 ;;
    esac
    [ "$LIMIT" -gt "$MAX_LOG_ENTRIES" ] && LIMIT="$MAX_LOG_ENTRIES"
    [ "$LIMIT" -lt 1 ] && LIMIT=1

    json_headers
    printf '{"file":"%s","versions":[' "$(json_escape "$FILE")"
    FIRST=1
    while IFS=$'\x1f' read -r HASH TS AUTHOR SUBJECT; do
        [ -n "$HASH" ] || continue
        if [ "$FIRST" = 1 ]; then FIRST=0; else printf ','; fi
        printf '{"rev":"%s","ts":%s,"author":"%s","subject":"%s"}' \
            "$HASH" "$TS" "$(json_escape "$AUTHOR")" "$(json_escape "$SUBJECT")"
    done < <(git -C "$DATA_DIR" log --follow --format='%H%x1f%ct%x1f%an%x1f%s' -n "$LIMIT" -- "$FILE" 2>/dev/null)
    printf ']}\n'
    exit 0
fi

# --- Restore a wiki to an earlier commit ------------------------------------
if [ "$ROUTE" = "/api/lithic/restore" ] && [ "$METHOD" = "POST" ]; then
    if command -v flock >/dev/null 2>&1; then
        exec 9>"${LOCK_FILE}" 2>/dev/null
        flock -w 20 9 2>/dev/null || fail "503 Service Unavailable" "busy"
    fi

    IFS= read -r FILE
    IFS= read -r REV

    valid_name "$FILE" || fail "400 Bad Request" "invalid_file_name"
    case "$REV" in
        ''|*[!0-9a-f]*) fail "400 Bad Request" "invalid_rev" ;;
    esac
    [ "${#REV}" -ge 7 ] && [ "${#REV}" -le 40 ] || fail "400 Bad Request" "invalid_rev"
    git -C "$DATA_DIR" cat-file -e "${REV}^{commit}" 2>/dev/null || fail "404 Not Found" "unknown_rev"
    [ -f "${DATA_DIR}/${FILE}" ] || fail "404 Not Found" "file_not_found"

    RESTORE_ERR="$(git -C "$DATA_DIR" checkout "$REV" -- "$FILE" 2>&1)"
    if [ $? -ne 0 ]; then
        fail "422 Unprocessable Entity" "restore_failed: $(printf '%s' "$RESTORE_ERR" | tr '\n' ' ' | cut -c1-300)"
    fi

    git -C "$DATA_DIR" add -- "$FILE" >/dev/null 2>&1
    if ! git -C "$DATA_DIR" diff --cached --quiet -- "$FILE" 2>/dev/null; then
        git_commit "Restore ${FILE} to ${REV}" "$FILE" || fail "500 Internal Server Error" "commit_failed"
    fi
    respond_ok "$(git -C "$DATA_DIR" hash-object --no-filters "$FILE" 2>/dev/null)"
    exit 0
fi

fail "404 Not Found" "route_not_found"
