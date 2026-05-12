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
INSTALL_DIR="/opt/lithic"
DATA_DIR="/opt/lithic/data"
ENV_FILE="/etc/default/lithic"
SERVICE_NAME="lithic"

echo "============================================"
echo "  Lithic Server — LXC Installer"
echo "============================================"
echo ""

# --- Check dependencies ---
for cmd in curl tar jq; do
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

# The tarball contains app/{caddy, entrypoint.sh, public/}
# After strip-components=1, we get caddy, entrypoint.sh, public/ in INSTALL_DIR
chmod +x "${INSTALL_DIR}/caddy" "${INSTALL_DIR}/entrypoint.sh"

# --- Create data directory ---
mkdir -p "${DATA_DIR}"

# --- Create environment file ---
if [ ! -f "${ENV_FILE}" ]; then
  echo "Creating environment file at ${ENV_FILE}..."
  cat > "${ENV_FILE}" <<EOF
# Lithic Server Configuration
# Edit these values and restart the service: systemctl restart ${SERVICE_NAME}
LITHIC_USER=admin
LITHIC_PASSWORD=changeme
LITHIC_PORT=8080
EOF
  echo "Created ${ENV_FILE} with default credentials."
else
  echo "Environment file ${ENV_FILE} already exists, skipping."
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

# Override paths for the non-Docker layout
Environment="APP_DIR=${INSTALL_DIR}"
Environment="DATA_DIR=${DATA_DIR}"

ExecStart=${INSTALL_DIR}/entrypoint.sh
Restart=always
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

# Removed start.sh wrapper; entrypoint.sh handles variable paths natively now.

# --- Enable and start ---
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

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
echo "  ⚠  IMPORTANT: Edit your credentials!"
echo "     sudo nano ${ENV_FILE}"
echo "     sudo systemctl restart ${SERVICE_NAME}"
echo ""
echo "  Access:   http://$(hostname -I | awk '{print $1}'):8080"
echo "============================================"
