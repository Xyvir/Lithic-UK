#!/bin/bash
set -euo pipefail

# ==============================================================================
# Lithic Server — Proxmox LXC Installer
#
# Designed for Debian/Ubuntu LXC containers.
# Fetches the latest release from GitHub Releases and sets up a systemd service.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Xyvir/Lithic/main/deploy/install-lxc.sh | bash
# ==============================================================================

REPO="${LITHIC_REPO:-Xyvir/Lithic}"
INSTALL_DIR="/app"
DATA_DIR="/data"
ENV_FILE="/etc/default/lithic"
SERVICE_NAME="lithic"

echo "============================================"
echo "  Lithic Server — LXC Installer"
echo "============================================"
echo ""

# --- Check dependencies ---
for cmd in curl tar jq git; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Installing missing dependency: ${cmd}..."
    apt-get update -qq && apt-get install -y -qq "$cmd"
  fi
done

# --- Install lighttpd dependencies ---
if ! command -v lighttpd &> /dev/null; then
  echo "Installing lighttpd..."
  apt-get update -qq && apt-get install -y -qq lighttpd lighttpd-mod-webdav 2>/dev/null || apt-get install -y -qq lighttpd
fi

# --- Fetch latest release URL ---
echo "Fetching latest release from GitHub..."
RELEASE_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | jq -r '.assets[] | select(.name == "lithic-server.tar.gz") | .browser_download_url')

if [ -z "${RELEASE_URL}" ] || [ "${RELEASE_URL}" = "null" ]; then
  echo "ERROR: Could not find lithic-server.tar.gz in the latest release."
  echo "       Check https://github.com/${REPO}/releases"
  exit 1
fi

echo "Found: ${RELEASE_URL}"

# --- Download and extract ---
echo "Downloading and installing to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL "${RELEASE_URL}" | tar -xz -C "${INSTALL_DIR}" --strip-components=1

# The tarball contains app/{entrypoint.sh, public/} and maybe caddy
# After strip-components=1, we get entrypoint.sh, public/ in INSTALL_DIR
chmod +x "${INSTALL_DIR}/entrypoint.sh"
[ -f "${INSTALL_DIR}/watcher.sh" ] && chmod +x "${INSTALL_DIR}/watcher.sh"
[ -f "${INSTALL_DIR}/scripts/github-sync.sh" ] && chmod +x "${INSTALL_DIR}/scripts/github-sync.sh"
[ -f "${INSTALL_DIR}/caddy" ] && chmod +x "${INSTALL_DIR}/caddy"

# --- Create data directory ---
mkdir -p "${DATA_DIR}"

# --- Create environment file ---
if [ ! -f "${ENV_FILE}" ]; then
  echo "Creating environment file at ${ENV_FILE}..."

  CONF_BACKEND="${SERVER_BACKEND:-lighttpd}"
  CONF_USER="${LITHIC_USER:-admin}"
  if [ -n "${LITHIC_PASSWORD:-}" ] && [ "${LITHIC_PASSWORD}" != "changeme" ]; then
    CONF_PASS="${LITHIC_PASSWORD}"
  else
    # Generate a 32-char disambiguous base32 password (excludes 0, 1, I, O)
    CONF_PASS=$(tr -dc '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' < /dev/urandom | head -c 32 || true)
  fi
  CONF_PORT="${LITHIC_PORT:-8080}"
  CONF_FQDN="${LITHIC_FQDN:-}"

  # Interactive setup if running on a TTY
  if [ -t 0 ]; then
    echo ""
    echo "--- Interactive Setup ---"
    read -p "Backend (caddy/lighttpd) [${CONF_BACKEND}]: " input; CONF_BACKEND="${input:-${CONF_BACKEND}}"
    read -p "Admin Username [${CONF_USER}]: " input; CONF_USER="${input:-${CONF_USER}}"
    read -p "Admin Password [${CONF_PASS}]: " input; CONF_PASS="${input:-${CONF_PASS}}"
    read -p "HTTP Port [${CONF_PORT}]: " input; CONF_PORT="${input:-${CONF_PORT}}"
    
    if [ "${CONF_BACKEND}" = "caddy" ]; then
      read -p "Public FQDN for Auto-HTTPS (e.g. example.com) [none]: " input; CONF_FQDN="${input:-${CONF_FQDN}}"
    fi
    echo "-------------------------"
    echo ""
  fi

  cat > "${ENV_FILE}" <<EOF
# Lithic Server Configuration
# Edit these values and restart the service: systemctl restart ${SERVICE_NAME}
LITHIC_USER=${CONF_USER}
LITHIC_PASSWORD=${CONF_PASS}
LITHIC_PORT=${CONF_PORT}
SERVER_BACKEND=${CONF_BACKEND}
LITHIC_FQDN=${CONF_FQDN}
EOF
  echo "Created ${ENV_FILE} with specified credentials."
else
  echo "Environment file ${ENV_FILE} already exists, loading values."
  source "${ENV_FILE}"
  CONF_BACKEND="${SERVER_BACKEND:-lighttpd}"
fi

# --- Ensure Caddy Binary Exists if Selected ---
if [ "${CONF_BACKEND}" = "caddy" ] && [ ! -f "${INSTALL_DIR}/caddy" ]; then
  echo "Downloading Caddy with required plugins (webdav, cgi)..."
  curl -fsSL -o "${INSTALL_DIR}/caddy" "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/mholt/caddy-webdav&p=github.com/aksdb/caddy-cgi/v2"
  chmod +x "${INSTALL_DIR}/caddy"
fi


# --- Create systemd service ---
echo "Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Lithic Server
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment="HOME=${INSTALL_DIR}"
WorkingDirectory=${INSTALL_DIR}

ExecStart=${INSTALL_DIR}/entrypoint.sh
Restart=always
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

# Removed start.sh wrapper; entrypoint.sh handles variable paths natively now.

# --- Enable and start ---
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

# Source the env file to get the final values for the summary
source "${ENV_FILE}"

echo ""
echo "============================================"
echo "  ✅  Lithic Server installed!"
echo "============================================"
echo ""
echo "  Service:  systemctl status ${SERVICE_NAME}"
echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
echo "  Config:   ${ENV_FILE}"
echo "  Data:     ${DATA_DIR}"
echo ""
echo "  Credentials:"
echo "     User:     ${LITHIC_USER}"
echo "     Password: ${LITHIC_PASSWORD}"
echo ""

if [ -n "${LITHIC_FQDN:-}" ] && [ "${SERVER_BACKEND}" = "caddy" ]; then
echo "  Access:   https://${LITHIC_FQDN}"
else
echo "  Access:   http://$(hostname -I | awk '{print $1}'):${LITHIC_PORT}"
fi
echo "============================================"
