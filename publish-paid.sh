#!/usr/bin/env bash
# Publishes data/paid-recent.json (and data/log-window.json) as ONE commit on the `paid` branch, replaced each
# time (no history). Needs TOKEN and GITHUB_REPOSITORY, as the workflow gives them.
set -euo pipefail
rm -rf /tmp/paid && mkdir -p /tmp/paid/data
node paid-recent.mjs /tmp/paid/data/paid-recent.json
# The Claw Log's 24-hour window and last-played times (log-window.mjs): rebuilt
# when older than WINDOW_EVERY_S (default two minutes), published every time.
WIN=/tmp/log-window.json
if [ ! -f "$WIN" ] || [ $(( $(date +%s) - $(stat -c %Y "$WIN") )) -ge "${WINDOW_EVERY_S:-120}" ]; then
  node log-window.mjs "$WIN.tmp" && mv "$WIN.tmp" "$WIN" || true
fi
[ -f "$WIN" ] && cp "$WIN" /tmp/paid/data/log-window.json
cd /tmp/paid
git init -q -b paid
git config user.name "beezie-data[bot]"
git config user.email "beezie-data@users.noreply.github.com"
git add data
git commit -qm "paid $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git" paid
