#!/usr/bin/env bash
# Runs a pinned answer-me-with-html CLI (QingYunA/answer-me-with-html, MIT).
# Fetches the bundle once, checks its sha256, caches it outside the repo.
set -euo pipefail
AM_SHA=9642ad61c2320536637c41abef831cd09d992bb7  # v0.4.7
AM_SHA256=501247f7b02d629f861283fc0be27ee62f8d148f5f2c739219ed4a0310f462bb
cache="${XDG_CACHE_HOME:-$HOME/.cache}/dev-team-am/am-${AM_SHA}.mjs"
if [ ! -f "$cache" ]; then
  mkdir -p "$(dirname "$cache")"
  curl -fsSL "https://raw.githubusercontent.com/QingYunA/answer-me-with-html/${AM_SHA}/skills/answer-me-with-html/scripts/am.mjs" -o "$cache.tmp"
  echo "${AM_SHA256}  $cache.tmp" | shasum -a 256 -c - >/dev/null || { rm -f "$cache.tmp"; echo "am.sh: sha256 mismatch" >&2; exit 1; }
  mv "$cache.tmp" "$cache"
fi
# Pinned on purpose: no update check, no hint to upgrade.
AM_NO_UPDATE_CHECK=1 exec node "$cache" "$@"
