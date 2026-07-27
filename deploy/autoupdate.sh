#!/bin/bash
set -euo pipefail

# Lithic Autoupdate Utility
# Pulls the latest lithic.html and launcher.html from GitHub if they differ.
# Handles systemd timer setup for scheduled updates.

APP_DIR="/app"
PUBLIC_DIR="${APP_DIR}/public"
LITHIC_HTML="${PUBLIC_DIR}/src/lithic.html"
LAUNCHER_HTML="${PUBLIC_DIR}/src/launcher.html"

# Load config if present
if [ -f "/etc/default/lithic" ]; then
    # shellcheck source=/dev/null
    source "/etc/default/lithic"
fi

REPO="${LITHIC_REPO:-Xyvir/Lithic}"
BRANCH="${LITHIC_BRANCH:-main}"

# Check systemd availability
HAS_SYSTEMD=0
if [ -d /run/systemd/system ]; then
    HAS_SYSTEMD=1
fi

check_internet() {
    curl -s --head --request GET "https://raw.githubusercontent.com" --connect-timeout 5 >/dev/null
}

run_systemctl() {
    if [ "$(id -u)" -eq 0 ]; then
        systemctl "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo systemctl "$@"
    else
        echo "ERROR: This command requires root privileges, but sudo is not installed and you are not root."
        exit 1
    fi
}

run_update() {
    if ! check_internet; then
        echo "[Autoupdate] No internet connection or GitHub is unreachable. Skipping update check."
        exit 0
    fi

    echo "[Autoupdate] Checking for updates from https://github.com/${REPO} on branch '${BRANCH}'..."

    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    # Fetch latest launcher.html and lithic.html
    if ! curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/launcher.html?t=$(date +%s)" -o "$TEMP_DIR/launcher.html"; then
        echo "[Autoupdate] ERROR: Failed to download launcher.html"
        exit 1
    fi
    if ! curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/lithic.html?t=$(date +%s)" -o "$TEMP_DIR/lithic.html"; then
        echo "[Autoupdate] ERROR: Failed to download lithic.html"
        exit 1
    fi

    local updated=0
    for file_name in "launcher.html" "lithic.html"; do
        local_file="${PUBLIC_DIR}/src/${file_name}"
        remote_file="${TEMP_DIR}/${file_name}"

        if [ ! -f "$local_file" ]; then
            echo "[Autoupdate] $file_name does not exist locally. Installing..."
            mkdir -p "$(dirname "$local_file")"
            cp "$remote_file" "$local_file"
            updated=1
        else
            local_hash=$(sha256sum "$local_file" | awk '{print $1}')
            remote_hash=$(sha256sum "$remote_file" | awk '{print $1}')

            if [ "$local_hash" != "$remote_hash" ]; then
                echo "[Autoupdate] Update found for $file_name. Updating..."
                cp "$remote_file" "$local_file"
                updated=1
            fi
        fi
    done

    if [ "$updated" -eq 1 ]; then
        echo "[Autoupdate] Bumping local manifest version to invalidate client cache..."
        NEW_VERSION="autoupdate-$(date +%s)"
        
        if [ -f "${PUBLIC_DIR}/manifest.json" ]; then
            sed -i -E 's/"version": "[^"]+"/"version": "'"$NEW_VERSION"'"/' "${PUBLIC_DIR}/manifest.json"
        fi
        
        if [ -f "${PUBLIC_DIR}/offline-service-worker.js" ]; then
            sed -i -E "s/const VERSION = '[^']+';/const VERSION = '$NEW_VERSION';/" "${PUBLIC_DIR}/offline-service-worker.js"
        fi

        echo "[Autoupdate] Updates applied successfully. Manifest version bumped to $NEW_VERSION."
    else
        echo "[Autoupdate] All files are up to date."
    fi

    # Update Ephemeral API if it is installed
    if [ "$HAS_SYSTEMD" -eq 1 ] && run_systemctl is-enabled ephemeral-api.service >/dev/null 2>&1; then
        echo "[Autoupdate] Ephemeral API is installed. Updating..."
        TMP_EPH_DIR=$(mktemp -d)
        if git clone https://github.com/Xyvir/Ephemeral.exe.git "$TMP_EPH_DIR" >/dev/null 2>&1; then
            cd "$TMP_EPH_DIR" || exit
            chmod +x install.sh
            ./install.sh
            cd - > /dev/null || exit
            echo "[Autoupdate] Ephemeral API updated successfully."
        else
            echo "[Autoupdate] ERROR: Failed to clone Ephemeral.exe repository for update."
        fi
        rm -rf "$TMP_EPH_DIR"
    fi
}

enable_timer() {
    if [ "$HAS_SYSTEMD" -eq 1 ]; then
        echo "[Autoupdate] Enabling and starting lithic-autoupdate.timer..."
        run_systemctl enable --now lithic-autoupdate.timer
        echo "[Autoupdate] Daily autoupdate is now ENABLED."
    else
        echo "[Autoupdate] ERROR: systemd not detected. Cannot enable daily timer."
        echo "Please add a cron job to run this script daily:"
        echo "0 0 * * * /app/autoupdate.sh"
        exit 1
    fi
}

disable_timer() {
    if [ "$HAS_SYSTEMD" -eq 1 ]; then
        echo "[Autoupdate] Disabling and stopping lithic-autoupdate.timer..."
        run_systemctl disable --now lithic-autoupdate.timer
        echo "[Autoupdate] Daily autoupdate is now DISABLED."
    else
        echo "[Autoupdate] ERROR: systemd not detected. Cannot disable daily timer."
        exit 1
    fi
}

show_status() {
    echo "Lithic Autoupdate Status"
    echo "========================"
    if [ "$HAS_SYSTEMD" -eq 1 ]; then
        if run_systemctl is-active --quiet lithic-autoupdate.timer; then
            echo "Daily Timer: ENABLED"
            # Show next trigger and details
            run_systemctl status lithic-autoupdate.timer | grep -E "Trigger:|Active:" || true
        else
            echo "Daily Timer: DISABLED"
        fi
    else
        echo "Daily Timer: Unsupported (systemd not running)"
    fi

    echo ""
    echo "File Status:"
    if check_internet; then
        TEMP_DIR=$(mktemp -d)
        trap 'rm -rf "$TEMP_DIR"' EXIT
        
        if curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/launcher.html?t=$(date +%s)" -o "$TEMP_DIR/launcher.html" 2>/dev/null && \
           curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/src/lithic.html?t=$(date +%s)" -o "$TEMP_DIR/lithic.html" 2>/dev/null; then
            for file_name in "launcher.html" "lithic.html"; do
                local_file="${PUBLIC_DIR}/src/${file_name}"
                remote_file="${TEMP_DIR}/${file_name}"
                if [ -f "$local_file" ]; then
                    local_hash=$(sha256sum "$local_file" | awk '{print $1}')
                    remote_hash=$(sha256sum "$remote_file" | awk '{print $1}')
                    if [ "$local_hash" != "$remote_hash" ]; then
                        echo "  $file_name: OUTDATED (updates available)"
                    else
                        echo "  $file_name: UP TO DATE"
                    fi
                else
                    echo "  $file_name: MISSING LOCALLY"
                fi
            done
        else
            echo "  Could not fetch remote files for comparison."
        fi
    else
        echo "  Offline (cannot compare with GitHub)"
    fi
}

# Parse commands
CMD="${1:-update}"

case "$CMD" in
    run|update)
        run_update
        ;;
    enable)
        enable_timer
        ;;
    disable)
        disable_timer
        ;;
    status)
        show_status
        ;;
    *)
        echo "Usage: $0 {run|update|enable|disable|status}"
        exit 1
        ;;
esac
