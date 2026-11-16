#!/usr/bin/env bash
# The fast loop: read the payments and publish the labels file every PAID_EVERY_S
# seconds, until /tmp/paid-stop appears. The workflow starts it in the background
# beside the summaries step (which can take minutes) and stops it before saving.
every="${PAID_EVERY_S:-60}"
while [ ! -f /tmp/paid-stop ]; do
  next=$(( $(date +%s) + every ))
  while [ "$(date +%s)" -lt "$next" ] && [ ! -f /tmp/paid-stop ]; do sleep 1; done
  [ -f /tmp/paid-stop ] && break
  node paid.mjs || true
  ./publish-paid.sh || true
done
touch /tmp/paid-done
