# ==============================================================================
# Lithic Server — Dockerfile (Resilient Build)
#
# Two-path Caddy acquisition strategy:
#   Fast Path:  Downloads a pre-compiled Caddy binary via the Caddy API (~10s).
#   Fallback:   If the API is rate-limited or times out, uses a binary compiled
#               by xcaddy in Stage 0. Docker caches Stage 0, so after the first
#               build the fallback is also instant.
#
# ==============================================================================

# =============================================================================
# Stage 0: Pre-build Caddy with xcaddy (cached fallback)
# Docker layer-caches this stage. It only re-runs if the plugin list changes.
# =============================================================================
FROM caddy:2-builder AS caddy-builder

RUN xcaddy build \
    --with github.com/mholt/caddy-webdav \
    --with github.com/aksdb/caddy-cgi/v2 \
    --output /usr/bin/caddy

# =============================================================================
# Stage 1: Final Image
# =============================================================================
FROM alpine:latest

# Basic dependencies
RUN apk add --no-cache bash sed curl ca-certificates git inotify-tools imagemagick lighttpd lighttpd-mod_webdav lighttpd-mod_auth

# ARG for backend (caddy or lighttpd)
ARG SERVER_BACKEND=lighttpd
ENV SERVER_BACKEND=${SERVER_BACKEND}

# App structure
RUN mkdir -p /app/public/src /app/scripts /data /app/public/_icon-defaults

# Stage the xcaddy-built fallback binary (always available, cached after first build)
COPY --from=caddy-builder /usr/bin/caddy /app/caddy-fallback

# Acquire Caddy: try the fast API download first (45s timeout).
# If it fails or is rate-limited, fall back to the pre-built xcaddy binary.
RUN if [ "$SERVER_BACKEND" = "caddy" ]; then \
      if curl --max-time 45 --retry 1 -fsSL \
         -o /app/caddy \
         "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/mholt/caddy-webdav&p=github.com/aksdb/caddy-cgi/v2"; then \
        echo "✓ Caddy acquired via API download"; \
      else \
        echo "⚠ Caddy API unavailable or rate-limited — using pre-built xcaddy binary"; \
        cp /app/caddy-fallback /app/caddy; \
      fi \
      && chmod +x /app/caddy; \
    fi \
    && rm -f /app/caddy-fallback

# Copy entrypoint
COPY deploy/entrypoint.sh /app/entrypoint.sh
COPY deploy/watcher.sh /app/watcher.sh
COPY deploy/github-sync.sh /app/scripts/github-sync.sh
RUN chmod +x /app/entrypoint.sh /app/watcher.sh /app/scripts/github-sync.sh

# Copy Lithic UI files
COPY index.html              /app/public/index.html
COPY src/launcher.html       /app/public/src/launcher.html
COPY src/lithic.html         /app/public/src/lithic.html

# Static assets (non-fatal if missing)
COPY favicon.ico              /app/public/favicon.ico
COPY favicon-16x16.png        /app/public/favicon-16x16.png
COPY favicon-32x32.png        /app/public/favicon-32x32.png
COPY mstile-150x150.png       /app/public/mstile-150x150.png
COPY android-chrome-192x192.png /app/public/android-chrome-192x192.png
COPY android-chrome-512x512.png /app/public/android-chrome-512x512.png
COPY apple-touch-icon.png     /app/public/apple-touch-icon.png
COPY manifest.json            /app/public/manifest.json
COPY site.webmanifest         /app/public/site.webmanifest
COPY offline-service-worker.js /app/public/offline-service-worker.js
COPY intro.html               /app/public/intro.html
COPY intro.lith               /app/public/intro.lith
COPY 404.html                 /app/public/404.html
COPY src/mstile-150x150.png   /app/public/src/mstile-150x150.png
COPY src/app-icon.png         /app/public/src/app-icon.png

EXPOSE 8080

ENV LITHIC_USER=admin
ENV LITHIC_PASSWORD=changeme
ENV LITHIC_PORT=8080

ENTRYPOINT ["/app/entrypoint.sh"]
