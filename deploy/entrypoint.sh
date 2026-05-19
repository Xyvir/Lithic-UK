#!/bin/bash
set -euo pipefail

# ==============================================================================
# Lithic Server — Entrypoint
# Generates a Caddyfile from environment variables and boots Caddy.
# ==============================================================================

APP_DIR="${APP_DIR:-/app}"
PUBLIC_DIR="${PUBLIC_DIR:-${APP_DIR}/public}"
DATA_DIR="${DATA_DIR:-/data}"
CADDYFILE="${APP_DIR}/Caddyfile"

# --- Environment Variables ---
LITHIC_USER="${LITHIC_USER:-admin}"
LITHIC_PASSWORD="${LITHIC_PASSWORD:-changeme}"
LITHIC_PORT="${PORT:-${LITHIC_PORT:-8080}}"

echo "============================================"
echo "  Lithic Server"
echo "============================================"
echo "  User:  ${LITHIC_USER}"
echo "  Port:  ${LITHIC_PORT}"
echo "  Data:  ${DATA_DIR}"
echo "============================================"

# --- Validate ---
if [ "${LITHIC_PASSWORD}" = "changeme" ]; then
  echo ""
  echo "  ⚠  WARNING: Using default password!"
  echo "  Set LITHIC_PASSWORD to secure your instance."
  echo ""
fi

# --- Ensure data directory and .gitignore exist ---
mkdir -p "${DATA_DIR}"
if [ ! -f "${DATA_DIR}/.gitignore" ]; then
  printf "*.lock\nlighttpd.user\n" > "${DATA_DIR}/.gitignore"
else
  grep -q "lighttpd.user" "${DATA_DIR}/.gitignore" || echo "lighttpd.user" >> "${DATA_DIR}/.gitignore"
fi

# --- Backup default icons (once, at first boot) ---
ICON_DEFAULTS_DIR="${PUBLIC_DIR}/_icon-defaults"
mkdir -p "${ICON_DEFAULTS_DIR}"
for icon in favicon.ico favicon-16x16.png favicon-32x32.png mstile-150x150.png \
             android-chrome-192x192.png android-chrome-512x512.png apple-touch-icon.png; do
  if [ -f "${PUBLIC_DIR}/${icon}" ] && [ ! -f "${ICON_DEFAULTS_DIR}/${icon}" ]; then
    cp "${PUBLIC_DIR}/${icon}" "${ICON_DEFAULTS_DIR}/${icon}"
  fi
done

# --- Apply custom icon if one was persisted from a previous session ---
if [ -f "${DATA_DIR}/custom.ico" ]; then
  echo "Applying persisted custom.ico..."
  /app/watcher.sh --apply-custom-icon "${DATA_DIR}/custom.ico" "${PUBLIC_DIR}" || true
fi


# --- Ensure Git is installed ---
if ! command -v git &> /dev/null; then
  echo "Git is not installed. Attempting to install git..."
  if command -v apk &> /dev/null; then
    apk add --no-cache git
  elif command -v apt-get &> /dev/null; then
    apt-get update -qq && apt-get install -y -qq git
  else
    echo "WARNING: Could not find apk or apt-get to install git. Git sync may fail."
  fi
fi

# --- Initialize Git if not present ---
if [ ! -d "${DATA_DIR}/.git" ]; then
  echo "Initializing Git repository in ${DATA_DIR}..."
  git -C "${DATA_DIR}" init
  git -C "${DATA_DIR}" config user.email "sync@lithic.uk"
  git -C "${DATA_DIR}" config user.name "Lithic Sync"
  git -C "${DATA_DIR}" branch -M main > /dev/null 2>&1

  # Ensure .gitignore is the VERY first thing committed to set the rules
  if [ ! -f "${DATA_DIR}/.gitignore" ]; then
    printf "*.lock\nlighttpd.user\n" > "${DATA_DIR}/.gitignore"
  fi
  git -C "${DATA_DIR}" add .gitignore >/dev/null 2>&1
  git -C "${DATA_DIR}" commit -m "System: Initialize .gitignore" >/dev/null 2>&1

  # Initial commit if files exist (will now strictly follow .gitignore)
  if ! git -C "${DATA_DIR}" rev-parse HEAD >/dev/null 2>&1; then
      git -C "${DATA_DIR}" add .
      git -C "${DATA_DIR}" commit -m "Initial Sync: $(date)" >/dev/null 2>&1
  fi
fi

# --- Purge Orphaned / Stale Lock Files ---
echo "Scanning for orphaned and stale lock files..."
orphaned=0
stale=0
now_epoch=$(date +%s)
lock_max_age_seconds=120  # 2 minutes — heartbeat is every 30s, so anything older is dead

while IFS= read -r lockfile; do
  # Derive the corresponding .lith path (strip trailing .lock)
  lithfile="${lockfile%.lock}"

  # Case 1: Orphaned — no matching .lith file
  if [ ! -f "${lithfile}" ]; then
    echo "  Removing orphaned lock (no matching .lith): ${lockfile}"
    rm -f "${lockfile}"
    orphaned=$((orphaned + 1))
    continue
  fi

  # Case 2: Stale — lock file's mtime is older than the heartbeat window
  file_mtime=$(stat -c %Y "${lockfile}" 2>/dev/null || echo 0)
  age=$(( now_epoch - file_mtime ))
  if [ "${age}" -gt "${lock_max_age_seconds}" ]; then
    echo "  Removing stale lock (age=${age}s): ${lockfile}"
    rm -f "${lockfile}"
    stale=$((stale + 1))
  fi
done < <(find "${DATA_DIR}" -maxdepth 1 -name "*.lock" -type f 2>/dev/null)

echo "  Purge complete: ${orphaned} orphaned, ${stale} stale lock(s) removed."

# --- Start Watcher ---
echo "Starting sync watcher..."
/app/watcher.sh &

# --- Hash the password & Start Server ---
SERVER_BACKEND="${SERVER_BACKEND:-lighttpd}"

if [ "$SERVER_BACKEND" = "caddy" ]; then
    echo "Generating password hash..."
    # Jane's Note: Passing plaintext passwords in CLI args can leak to process lists (`ps`).
    # In a transient Docker container, we'll tolerate it, but keep it in mind.
    HASHED_PASSWORD=$("${APP_DIR}/caddy" hash-password --plaintext "${LITHIC_PASSWORD}")
    echo "Password hash generated."

    # --- Write Caddyfile ---
    echo "Writing Caddyfile..."
    
    CADDY_SITE_ADDRESS=":${LITHIC_PORT}"
    CADDY_GLOBAL_BLOCK="auto_https off"
    
    if [ -n "${LITHIC_FQDN:-}" ]; then
        echo "Using FQDN: ${LITHIC_FQDN}. Auto-HTTPS is enabled."
        CADDY_SITE_ADDRESS="${LITHIC_FQDN}"
        CADDY_GLOBAL_BLOCK="# auto_https enabled by FQDN"
    fi

    cat > "${CADDYFILE}" <<EOF
{
    ${CADDY_GLOBAL_BLOCK}
    order webdav last
    order cgi last
}

${CADDY_SITE_ADDRESS} {
    # 1. Protection Rules
    # Authenticate everything EXCEPT the PWA installation assets and healthcheck
    @protected {
        not path /manifest.json /site.webmanifest /offline-service-worker.js /android-chrome-* /apple-touch-icon.png /favicon* /health
    }

    basic_auth @protected {
        ${LITHIC_USER} ${HASHED_PASSWORD}
    }

    # 2. GitHub Sync API (CGI)
    handle /api/github/* {
        cgi * /app/scripts/github-sync.sh
    }

    # 3. WebDAV Sync
    handle /sync/* {
        # Ensure .lith files are served with explicit UTF-8 encoding
        # so clients (e.g. VS Code WebDAV) decode the triple-asterism ⁂ correctly.
        @lithFiles path *.lith
        header @lithFiles Content-Type "text/plain; charset=utf-8"

        webdav {
            root ${DATA_DIR}
            prefix /sync
        }
    }

    # 4. Web Server 
    # Serves all public assets. If a request made it past basic_auth, it lands here.
    handle * {
        file_server {
            root ${PUBLIC_DIR}
        }
    }
}
EOF

    echo "Caddyfile written to ${CADDYFILE}"
    echo ""
    echo "Starting Caddy..."
    exec "${APP_DIR}/caddy" run --config "${CADDYFILE}"

else
    # --- Write Lighttpd Config ---
    LIGHTTPD_CONF="${APP_DIR}/lighttpd.conf"
    LIGHTTPD_USER_FILE="${DATA_DIR}/lighttpd.user"
    
    echo "Writing Lighttpd config..."
    echo "${LITHIC_USER}:${LITHIC_PASSWORD}" > "${LIGHTTPD_USER_FILE}"
    chmod 600 "${LIGHTTPD_USER_FILE}"
    
    cat > "${LIGHTTPD_CONF}" <<EOF
server.modules = (
    "mod_access",
    "mod_auth",
    "mod_authn_file",
    "mod_alias",
    "mod_webdav",
    "mod_cgi",
    "mod_setenv",
    "mod_rewrite"
)

server.document-root = "${PUBLIC_DIR}"
server.port = ${LITHIC_PORT}
server.bind = "0.0.0.0"

# Fix for Lithic UI and paths
index-file.names = ( "index.html" )
mimetype.assign = (
    ".html" => "text/html",
    ".css"  => "text/css",
    ".js"   => "application/javascript",
    ".json" => "application/json",
    ".png"  => "image/png",
    ".ico"  => "image/x-icon",
    ".webmanifest" => "application/manifest+json",
    ".lith" => "text/plain; charset=utf-8"
)

# Authentication
auth.backend = "plain"
auth.backend.plain.userfile = "${LIGHTTPD_USER_FILE}"
auth.require = ( "" => (
    "method" => "basic",
    "realm" => "Lithic Server",
    "require" => "valid-user"
))

# Exclude public assets from auth
\$HTTP["url"] =~ "^/(manifest\.json|site\.webmanifest|offline-service-worker\.js|android-chrome-.*|apple-touch-icon\.png|favicon.*|health)$" {
    auth.require = ()
}

# CGI for GitHub Sync
alias.url += ( "/api/github" => "/app/scripts/github-sync.sh" )
\$HTTP["url"] =~ "^/api/github" {
    cgi.assign = ( ".sh" => "" )
}


# WebDAV Sync
alias.url += ( "/sync/" => "${DATA_DIR}/" )
\$HTTP["url"] =~ "^/sync/" {
    webdav.activate = "enable"
    webdav.is-readonly = "disable"
    setenv.add-response-header = ( "Content-Type" => "text/plain; charset=utf-8" )
}
EOF
    
    echo "Lighttpd config written to ${LIGHTTPD_CONF}"
    echo ""
    echo "Starting Lighttpd..."
    exec lighttpd -D -f "${LIGHTTPD_CONF}"
fi