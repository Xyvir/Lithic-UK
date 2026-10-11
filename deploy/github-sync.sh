#!/bin/bash
# ==============================================================================
# Lithic GitHub Sync — API Handler (CGI) V3
# Handles OAuth Device Flow, Repo Listing, and Git Initialization
# ==============================================================================

# CGI Headers
echo "Content-Type: application/json"
echo ""

DATA_DIR="/data"
DEFAULT_CLIENT_ID="Iv23lippjEJMp4KLlLKI"
LOCK_FILE="${DATA_DIR}/.git/github-sync.lock"

# Diagnostic logging to stderr (visible in Railway/Docker logs)
echo "[CGI] Request: $REQUEST_METHOD $REQUEST_URI" >&2
echo "[CGI] Query: $QUERY_STRING" >&2


CLIENT_ID="${GITHUB_CLIENT_ID:-$DEFAULT_CLIENT_ID}"
REQUEST_URI="${REQUEST_URI:-}"
QUERY_STRING="${QUERY_STRING:-}"
METHOD="${REQUEST_METHOD:-GET}"

# Helper: Extract value from JSON-like strings
extract_json_val() {
    local key=$1
    local input=$2
    echo "$input" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

# Simple Routing
if [[ "$REQUEST_URI" == */device-code* ]]; then
    RESPONSE=$(curl -s -X POST https://github.com/login/device/code \
        -H "Accept: application/json" \
        -d "client_id=${CLIENT_ID}&scope=repo")
    if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
        echo '{"error":"network_error","error_description":"Failed to reach GitHub."}'
    else
        echo "$RESPONSE"
    fi

elif [[ "$REQUEST_URI" == */poll* ]]; then
    DEVICE_CODE=$(echo "$QUERY_STRING" | sed -n 's/.*device_code=\([^&]*\).*/\1/p')
    RESPONSE=$(curl -s -X POST https://github.com/login/oauth/access_token \
        -H "Accept: application/json" \
        -d "client_id=${CLIENT_ID}&device_code=${DEVICE_CODE}&grant_type=urn:ietf:params:oauth:grant-type:device_code")
    echo "$RESPONSE"

elif [[ "$REQUEST_URI" == */list-repos* ]]; then
    TOKEN=$(echo "$QUERY_STRING" | sed -n 's/.*token=\([^&]*\).*/\1/p')
    if [ -z "$TOKEN" ]; then
        echo '{"error":"missing_token"}'
        exit 0
    fi
    # Fetch user repositories (type=owner to prevent listing every public repo they contributed to)
    RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/user/repos?type=owner&sort=updated&per_page=100")
    echo "$RESPONSE"

elif [[ "$REQUEST_URI" == */create-repo* ]] && [[ "$METHOD" == "POST" ]]; then
    read -r PAYLOAD
    TOKEN=$(extract_json_val "token" "$PAYLOAD")
    REPO_NAME=$(extract_json_val "name" "$PAYLOAD")
    
    # Generate a random ID only if no name was provided
    if [ -z "$REPO_NAME" ] || [ "$REPO_NAME" == "null" ]; then
        RAND_ID=$(head /dev/urandom | tr -dc A-Z0-9 | head -c 4)
        REPO_NAME="lithic-sync-$RAND_ID"
    fi
    
    RESPONSE=$(curl -s -X POST "https://api.github.com/user/repos" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        -d "{\"name\":\"$REPO_NAME\",\"private\":true,\"description\":\"Lithic Automated Sync\"}")
    echo "$RESPONSE"

elif [[ "$REQUEST_URI" == */setup* ]] && [[ "$METHOD" == "POST" ]]; then
    # Ensure .git exists before lock check
    mkdir -p "${DATA_DIR}/.git"

    # --- Acquire Lock ---
    while [ -f "$LOCK_FILE" ]; do
        # Check if lock is stale (older than 1 minute)
        if [ "$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE") ))" -gt 60 ]; then
            rm -f "$LOCK_FILE"
        else
            sleep 1
        fi
    done
    touch "$LOCK_FILE"

    read -r PAYLOAD
    TOKEN=$(extract_json_val "token" "$PAYLOAD")
    REPO_NAME=$(extract_json_val "repo" "$PAYLOAD")

    if [ -z "$TOKEN" ] || [ -z "$REPO_NAME" ]; then
        echo '{"error":"missing_params"}'
        rm -f "$LOCK_FILE"
        exit 0
    fi

    # Setup remote (Delay token write to prevent watcher race condition)
    git -C "${DATA_DIR}" remote remove origin >/dev/null 2>&1
    git -C "${DATA_DIR}" remote add origin "https://oauth2:${TOKEN}@github.com/${REPO_NAME}.git"

    # Ensure local branch is named 'main'
    git -C "${DATA_DIR}" branch -M main > /dev/null 2>&1

    # Ensure there is an initial commit if local is empty (required for pull/push)
    if ! git -C "${DATA_DIR}" rev-parse HEAD >/dev/null 2>&1; then
        git -C "${DATA_DIR}" add .
        git -C "${DATA_DIR}" commit -m "Initial Sync: $(date)" >/dev/null 2>&1
    fi

    # 1. Fetch from remote (safe, no merges yet)
    git -C "${DATA_DIR}" fetch origin main > "${DATA_DIR}/.git/git_sync.log" 2>&1 || true
    
    # 2. Graceful Rescue: Download any liths we don't have locally, and the instance's
    # own icon with them. `favicon.conf` and the icons are not Liths, so an extension
    # filter alone would leave them behind and a restored server would come back with its
    # wikis and the shipped mark — the icon its owner picked is lost. `custom.ico` is in the
    # list because it is both the 512px render and the file boot applies (`watcher.sh
    # --apply-custom-icon`), and because its arrival is the watcher's cue to copy the set
    # into the public directory.
    if git -C "${DATA_DIR}" rev-parse origin/main >/dev/null 2>&1; then
        git -C "${DATA_DIR}" ls-tree -r --name-only origin/main \
            | grep -E '\.(lith|json)$|^(favicon\.conf|custom\.ico|favicon\.ico|favicon-16x16\.png|favicon-32x32\.png|mstile-150x150\.png|android-chrome-192x192\.png|android-chrome-512x512\.png|apple-touch-icon\.png)$' \
            | while IFS= read -r file; do
            if [ ! -f "${DATA_DIR}/$file" ]; then
                git -C "${DATA_DIR}" checkout origin/main -- "$file" >> "${DATA_DIR}/.git/git_sync.log" 2>&1
            fi
        done
    fi
    
    # 3. DEFINITIVE PURGE
    git -C "${DATA_DIR}" add .gitignore >/dev/null 2>&1
    git -C "${DATA_DIR}" rm -r --cached . >/dev/null 2>&1
    git -C "${DATA_DIR}" add . >/dev/null 2>&1
    git -C "${DATA_DIR}" commit -m "System: Finalizing sync and .gitignore enforcement" >/dev/null 2>&1

    # 4. Force Push to establish tracking and update remote with unified clean state
    git -C "${DATA_DIR}" push -f -u origin main >> "${DATA_DIR}/.git/git_sync.log" 2>&1
    
    if [ $? -eq 0 ]; then
        # Setup successful: Enable Watcher
        echo "$TOKEN" > "${DATA_DIR}/.git/backup_token"
        echo "last_sync=$(date +%s)" > "${DATA_DIR}/.git/backup_status"
        echo "{\"status\":\"success\",\"repo\":\"$REPO_NAME\"}"
    else
        LOG=$(cat "${DATA_DIR}/.git/git_sync.log" | tr '\n' ' ' | sed 's/"/\\"/g')
        echo "{\"status\":\"error\",\"message\":\"$LOG\"}"
    fi
    
    # --- Release Lock ---
    rm -f "$LOCK_FILE"

elif [[ "$REQUEST_URI" == */history* ]]; then
    # The trail: this server's own commits, a local read. Offered whether or not a GitHub backup
    # is connected, because the commits are there either way, and a self-host instance with local
    # git and no remote is exactly the case the launcher's own dialog now draws.
    if [ ! -d "${DATA_DIR}/.git" ]; then
        echo '{"error":"no_repo"}'
        exit 0
    fi
    LIMIT=$(echo "$QUERY_STRING" | sed -n 's/.*limit=\([0-9]*\).*/\1/p')
    if [ -z "$LIMIT" ]; then LIMIT=10; fi
    if [ "$LIMIT" -lt 1 ] 2>/dev/null; then LIMIT=10; fi
    if [ "$LIMIT" -gt 50 ] 2>/dev/null; then LIMIT=50; fi
    # One line per commit, fields separated by an unlikely delimiter so a subject with commas,
    # colons or pipes in it survives. `%at` is the author time in epoch seconds, which is the
    # unit the launcher formats for every date it draws.
    COMMITS=""
    while IFS=$'\x1f' read -r SHORT HASH WHEN SUBJECT; do
        [ -z "$HASH" ] && continue
        SUBJECT=$(printf '%s' "$SUBJECT" | sed 's/\\/\\\\/g; s/"/\\"/g')
        [ -n "$COMMITS" ] && COMMITS="${COMMITS},"
        COMMITS="${COMMITS}{\"hash\":\"${HASH}\",\"short\":\"${SHORT}\",\"time\":${WHEN},\"summary\":\"${SUBJECT}\"}"
    done <<< "$(git -C "${DATA_DIR}" log -n "$LIMIT" --format='%h%x1f%H%x1f%at%x1f%s' 2>/dev/null)"
    echo "{\"commits\":[${COMMITS}]}"

elif [[ "$REQUEST_URI" == */revert* ]] && [[ "$METHOD" == "POST" ]]; then
    mkdir -p "${DATA_DIR}/.git"

    # --- Acquire Lock ---
    while [ -f "$LOCK_FILE" ]; do
        if [ "$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE") ))" -gt 60 ]; then
            rm -f "$LOCK_FILE"
        else
            sleep 1
        fi
    done
    touch "$LOCK_FILE"

    read -r PAYLOAD
    COMMIT=$(extract_json_val "commit" "$PAYLOAD")

    if [ ! -d "${DATA_DIR}/.git" ] || [ -z "$COMMIT" ]; then
        echo '{"status":"error","message":"missing_commit"}'
        rm -f "$LOCK_FILE"
        exit 0
    fi
    if ! git -C "${DATA_DIR}" rev-parse --verify --quiet "${COMMIT}^{commit}" >/dev/null 2>&1; then
        echo '{"status":"error","message":"unknown_commit"}'
        rm -f "$LOCK_FILE"
        exit 0
    fi

    # 1. The server's own uncommitted work goes in first, so a revert can never discard a change
    #    git was never given. Untracked files are not the backup's to carry, which is the rule the
    #    launcher's own pre-revert commit keeps (`git add -u` stages tracked paths only).
    SAVED_FIRST=false
    PUSH_ERROR=""
    if [ -n "$(git -C "${DATA_DIR}" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        git -C "${DATA_DIR}" add -u >/dev/null 2>&1
        if git -C "${DATA_DIR}" commit -m "Save before revert" >/dev/null 2>&1; then
            SAVED_FIRST=true
        fi
    fi

    # 2. How much of the instance this moves, measured before anything is written.
    CHANGES=$(git -C "${DATA_DIR}" diff --name-only "$COMMIT" HEAD 2>/dev/null | wc -l | tr -d ' ')

    # 3. The tree, then the commit. `read-tree --reset -u` is the plumbing `git reset --hard`
    #    uses: it makes the index and the working tree match the target, including removing a file
    #    the target does not have. The branch is deliberately not moved, so the commits this goes
    #    back over stay in the history and the revert is undone by reverting to them.
    if ! git -C "${DATA_DIR}" read-tree --reset -u "$COMMIT" >/dev/null 2>&1; then
        echo '{"status":"error","message":"read_tree_failed"}'
        rm -f "$LOCK_FILE"
        exit 0
    fi
    TARGET=$(git -C "${DATA_DIR}" rev-parse --short "$COMMIT" 2>/dev/null)
    # `--allow-empty`, so going back to where the branch already is is recorded as the act it was
    # rather than as a silent no-op. The launcher's own commit does the same.
    git -C "${DATA_DIR}" commit --allow-empty -m "Revert to ${TARGET}" >/dev/null 2>&1
    SHORT=$(git -C "${DATA_DIR}" rev-parse --short HEAD 2>/dev/null)

    # 4. Publish, when this instance has a backup at all. A server with local git and no GitHub
    #    connection keeps its trail where it is, which is the case the route is offered for.
    if [ -f "${DATA_DIR}/.git/backup_token" ]; then
        # A push that fails does not fail the revert: the instance is back at the target either
        # way, and the dialog says the backup did not upload rather than implying it did. Only
        # the last line is carried, which is the one git failed on.
        if ! git -C "${DATA_DIR}" push origin main >> "${DATA_DIR}/.git/git_sync.log" 2>&1; then
            PUSH_ERROR=$(tail -n 1 "${DATA_DIR}/.git/git_sync.log" | tr -d '\r' | tr '"' "'")
        fi
        echo "last_sync=$(date +%s)" > "${DATA_DIR}/.git/backup_status"
    fi

    # The watcher commits and pushes on its own timer, so it is told about this commit the way it
    # is told about a patch save: by finding the work already done. Nothing to do here.
    # `short` is the commit this added and `target` the one it went back to, which are the field
    # names the desktop app's command answers with: the dialog reads one shape from three prongs.
    ERROR_JSON="null"
    [ -n "$PUSH_ERROR" ] && ERROR_JSON="\"${PUSH_ERROR}\""
    echo "{\"status\":\"success\",\"short\":\"${SHORT}\",\"target\":\"${TARGET}\",\"changes\":${CHANGES:-0},\"saved_first\":${SAVED_FIRST},\"error\":${ERROR_JSON}}"

    # --- Release Lock ---
    rm -f "$LOCK_FILE"

elif [[ "$REQUEST_URI" == */status* ]]; then
    if [ ! -f "${DATA_DIR}/.git/backup_token" ]; then
        echo '{"connected":false}'
    else
        REPO=$(git -C "${DATA_DIR}" remote get-url origin | sed -E 's|.*github\.com/(.*)\.git|\1|')
        LAST_SYNC=0
        if [ -f "${DATA_DIR}/.git/backup_status" ]; then
            LAST_SYNC=$(grep "last_sync=" "${DATA_DIR}/.git/backup_status" | cut -d= -f2)
        fi
        if [ -z "$LAST_SYNC" ]; then
            LAST_SYNC=0
        fi
        echo "{\"connected\":true,\"repo\":\"$REPO\",\"last_sync\":$LAST_SYNC}"
    fi

elif [[ "$REQUEST_URI" == */disconnect* ]]; then
    # --- Acquire Lock ---
    touch "$LOCK_FILE"
    # Wipe credentials and status for a clean reconnect
    rm -f "${DATA_DIR}/.git/backup_token"
    rm -f "${DATA_DIR}/.git/backup_status"
    echo '{"status":"disconnected"}'
    # --- Release Lock ---
    rm -f "$LOCK_FILE"

else
    echo "{\"error\":\"route_not_found\",\"uri\":\"$REQUEST_URI\"}"
fi
