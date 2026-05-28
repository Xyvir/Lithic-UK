# Self-Hosting Lithic

Lithic is a TiddlyWiki-powered PKMS that stores your data in `.lith` files. The self-hosted server bundles a custom **Caddy** binary with a **WebDAV** plugin, providing a static file server for the Lithic UI and a WebDAV sync endpoint for your data — all protected by BasicAuth.

## Quick Start

### Method A: Railway (One-Click)

Deploy Lithic to Railway with a single click. Railway will build the Caddy+WebDAV server from source and provision a persistent volume automatically.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/lithic-remote)

> **Note:** After creating the template in the Railway dashboard, set these environment variables:
> - `LITHIC_USER` — your username
> - `LITHIC_PASSWORD` — use `${{secret()}}` in the template to auto-generate a secure password, please don't change this as 2fa is not provided.

### Method B: Docker

```bash
docker run -d --name lithic \
  -p 8080:8080 \
  -e LITHIC_USER=admin \
  -e LITHIC_PASSWORD=your-secret-password \
  -v lithic-data:/data \
  ghcr.io/xyvir/lithic:latest
```

Or build from source:

```bash
docker build -t lithic -f deploy/Dockerfile .
docker run -d --name lithic \
  -p 8080:8080 \
  -e LITHIC_USER=admin \
  -e LITHIC_PASSWORD=your-secret-password \
  -v lithic-data:/data \
  lithic
```

### Method C: Proxmox LXC (One-Liner)

Run this inside a Debian/Ubuntu LXC container. You have two options:

**Option 1: Interactive Setup**
This will prompt you for your backend choice (Caddy/Lighttpd), FQDN, and credentials. If you leave the password blank, a secure one will be auto-generated for you.
```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Xyvir/Lithic/main/deploy/install-lxc.sh)"
```

**Option 2: Fully Automated Setup**
Bypass the prompts by providing the variables inline. This will automatically set up Caddy, request an SSL certificate for your domain, and auto-generate a secure password.
```bash
curl -fsSL https://raw.githubusercontent.com/Xyvir/Lithic/main/deploy/install-lxc.sh | sudo SERVER_BACKEND=caddy LITHIC_FQDN=lithic.example.com LITHIC_USER=your_username bash
```

### Method D: Manual Install

1. Download the latest `lithic-server.tar.gz` from [GitHub Releases](https://github.com/Xyvir/Lithic/releases).
2. Extract it:
   ```bash
   mkdir -p /app
   tar -xzf lithic-server.tar.gz -C /
   mkdir -p /data
   ```
3. Run it:
   ```bash
   LITHIC_USER=admin LITHIC_PASSWORD=your-secret-password /app/entrypoint.sh
   ```

---

## Configuration

The server is configured entirely through environment variables:

| Variable | Default | Description |
|---|---|---|
| `LITHIC_USER` | `admin` | BasicAuth username |
| `LITHIC_PASSWORD` | `changeme` | BasicAuth password |
| `LITHIC_PORT` | `8080` | HTTP listen port |

For the LXC install, these are stored in `/etc/default/lithic`.

---

## Architecture

```
:8080
├── /              → Static file server (Lithic Launcher + Engine)
├── /sync/*        → WebDAV endpoint (your .lith files)
└── BasicAuth      → Protects everything
```

- **`/`** — Serves the Lithic Launcher UI. The launcher automatically detects WebDAV mode and shows your remote `.lith` files.
- **`/sync/`** — A WebDAV directory backed by the `/data` volume. All `.lith` files are stored here. The launcher uses `PROPFIND`, `PUT`, and `DELETE` to manage files.
- **`/data`** — Persistent volume mount point. Back this up to protect your data.

---

## Managing Your Wikis

Once the server is running, open your browser and navigate to:

**`http://YOUR_SERVER_IP:8080`**

The Lithic Launcher will appear in **WebDAV mode** with the following features:

- **Upload a Lith** — Upload an existing `.lith` file to the server.
- **New Blank Lith** — Create a new wiki with a name you choose.
- **Open** — Click any listed file to load it in the Lithic engine. Changes auto-save back to the server via WebDAV.
- **Delete** — Remove a `.lith` file from the server (with confirmation).
- **Search** — Full-text search across cached files.

---

## Reverse Proxy

The server listens on HTTP (no TLS) by default, designed to sit behind your existing reverse proxy. Example Caddy reverse proxy config:

```caddyfile
lithic.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Example Nginx:

```nginx
server {
    listen 443 ssl;
    server_name lithic.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Backups

Your data lives in the `/data` directory (Docker volume or `/opt/lithic/data` on LXC). Back up this directory to preserve your wikis.

```bash
# Docker
docker cp lithic:/data ./lithic-backup

# LXC
cp -r /opt/lithic/data ~/lithic-backup
```

---

## Updating

### Docker
```bash
docker pull ghcr.io/xyvir/lithic:latest
docker stop lithic && docker rm lithic
# Re-run the docker run command above
```

### LXC
Re-run the installer — it will download the latest release and restart the service:
```bash
curl -fsSL https://raw.githubusercontent.com/Xyvir/Lithic/main/deploy/install-lxc.sh | bash
```

### Automatic Updates (LXC)
Lithic includes a built-in autoupdate utility that pulls the latest `lithic.html` and `launcher.html` UI files from the GitHub repository to keep the front-end up to date. It is designed to operate offline, checking connectivity before making request attempts and failing gracefully if the server has no internet access.

By default, the daily autoupdate checker is **disabled**. You can manage it using the `lithic-autoupdate` helper command from your server's SSH environment:

*   **Enable daily updates:** `lithic-autoupdate enable` (creates and starts a systemd timer to check once a day)
*   **Disable daily updates:** `lithic-autoupdate disable`
*   **Check status:** `lithic-autoupdate status` (shows if the timer is active and compares local files with GitHub)
*   **Run manually:** `lithic-autoupdate run` (or simply `lithic-autoupdate`) to update immediately

---

## Service Management (LXC)

```bash
sudo systemctl status lithic      # Check status
sudo systemctl restart lithic     # Restart
sudo systemctl stop lithic        # Stop
journalctl -u lithic -f           # View logs
```
