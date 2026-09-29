#!/bin/bash
set -euo pipefail

# Lithic server language pin.
#
# Pins this deployment's launcher to one language for every visitor who never said which
# they wanted, so a self-hoster can run a Spanish instance without rebuilding the
# launcher. The artifact the server hands out is the same bytes every deployment ships,
# so the pin is written into the two files that belong to a deployment rather than to the
# release: the redirector that sends `/` on to the launcher gains a default language for
# the visits that brought none, and the install manifest's start URL carries it, so an
# installed PWA opens in it too.
#
#   LITHIC_LOCALE=es pin-launcher-locale.sh /app/public
#
# Nothing set is nothing done, which is the path every deployment with no opinion takes.
# The launcher document itself is never touched, which is what makes the pin survive the
# autoupdate that replaces it, and keeps the served launcher byte for byte as released.
#
# The honest edge of it: a link that points straight at `src/launcher.html` and carries no
# query of its own is not pinned, and neither is a browser that took the launcher offline
# before the pin existed, since the service worker answers an offline navigation from its
# own cache. Language that must hold everywhere is what the build pin is for
# (`VITE_LAUNCHER_LOCALE`), at the cost of being fixed when the artifact is built.

PUBLIC_DIR="${1:-}"

if [ -z "${PUBLIC_DIR}" ]; then
  echo "pin-launcher-locale: no public directory given" >&2
  exit 2
fi

if [ -z "${LITHIC_LOCALE:-}" ]; then
  exit 0
fi

# A language tag and nothing else. This value is written into a document and a JSON file,
# so a stray quote or a newline would be a broken page rather than a wrong language.
case "${LITHIC_LOCALE}" in
  *[!A-Za-z-]*)
    echo "pin-launcher-locale: refusing '${LITHIC_LOCALE}', which is not a language tag" >&2
    exit 2
    ;;
esac

WANTED="${LITHIC_LOCALE}"
INDEX="${PUBLIC_DIR}/index.html"
MANIFEST="${PUBLIC_DIR}/manifest.json"
PINNED=0

# The redirector already forwards whatever query the visitor brought, so this only gives it
# one to bring when the visitor brought none. A plain visit, and the bookmark made from it,
# both arrive at the launcher in the pinned language, and a handover that carries `q` or
# `mode` is still forwarded untouched.
if [ -f "${INDEX}" ]; then
  if grep -q 'window.location.search + window.location.hash' "${INDEX}"; then
    sed -i "s#window.location.search + window.location.hash#(window.location.search || '?lang=${WANTED}') + window.location.hash#" "${INDEX}"
    PINNED=1
  elif grep -q "window.location.search || '?lang=" "${INDEX}"; then
    # Already pinned, by an earlier boot against this same document. A container gets a
    # fresh copy of the deployment's files every time it starts, but a server on a
    # persistent disk does not, and running this twice must be uneventful either way.
    PINNED=1
  else
    echo "pin-launcher-locale: ${INDEX} carries no redirect to pin" >&2
  fi
else
  echo "pin-launcher-locale: ${INDEX} is missing" >&2
fi

if [ -f "${MANIFEST}" ]; then
  if grep -q '"start_url": "src/launcher.html"' "${MANIFEST}"; then
    sed -i "s#\"start_url\": \"src/launcher.html\"#\"start_url\": \"src/launcher.html?lang=${WANTED}\"#" "${MANIFEST}"
    PINNED=1
  elif grep -q '"start_url": "src/launcher.html?lang=' "${MANIFEST}"; then
    PINNED=1
  else
    echo "pin-launcher-locale: ${MANIFEST} carries no start_url to pin" >&2
  fi
fi

if [ "${PINNED}" = "1" ]; then
  echo "pin-launcher-locale: this instance speaks ${WANTED}"
else
  echo "pin-launcher-locale: nothing was pinned for ${WANTED}" >&2
  exit 1
fi
