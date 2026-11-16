#!/usr/bin/env bash
# Publishes data/paid-recent.json as ONE commit on the `paid` branch, replaced each
# time (no history). Needs TOKEN and GITHUB_REPOSITORY, as the workflow gives them.
set -euo pipefail
node paid-recent.mjs
rm -rf /tmp/paid && mkdir -p /tmp/paid/data && cp data/paid-recent.json /tmp/paid/data/
cd /tmp/paid
git init -q -b paid
git config user.name "beezie-data[bot]"
git config user.email "beezie-data@users.noreply.github.com"
git add data
git commit -qm "paid $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git" paid
