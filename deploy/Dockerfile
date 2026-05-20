# ==============================================================================
# Lithic Server — Dockerfile
# ==============================================================================

FROM alpine:latest

# Basic dependencies
RUN apk add --no-cache bash sed curl ca-certificates git inotify-tools lighttpd lighttpd-mod_webdav lighttpd-mod_auth

# Force Lighttpd as the backend
ENV SERVER_BACKEND=lighttpd

# App structure
RUN mkdir -p /app/public/src /app/scripts /data /app/public/_icon-defaults

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
