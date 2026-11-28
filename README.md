# beezie-data

The numbers behind Grail Hunter's Data tab, counted by a GitHub Actions job every
five minutes. Public numbers only; nothing is signed in.

(The five-minute samples of each claw's figures that fed the old Graphs tab were
switched off in Nov 2026; they remain in this repository's history.)

## The Data tab's numbers

`build-stats.mjs` (run by the workflow every five minutes) counts every pull on
Beezie's Solana claws using the site's own counting code in `api/`, against files in
`kv/` instead of a database. It only adds pulls it hasn't counted, so finished days
are saved once and kept. It then writes the periods the Data tab shows to `data/`, published each run as a single replaced commit on the `snapshots` branch (so no history builds up):
`summary-1.json` (today, UTC), `-7`, `-30`, `-91`, `-182`, `-365` (calendar days, today
so far included) and `summary-24h.json` (the last 24 hours as they ran, with hourly buckets).

A player has 15 minutes to keep a slab or swap it, and Beezie lists it as kept until they
swap. So a pull is only saved to `kv/` once it is 20 minutes old; newer ones are added to
the summaries as the feed has them now and counted afresh next run. `recount.mjs` ran once
to rebuild the days from Nov 12 2026, which had been saved too early.

Base's history from before Beezie's migration is not here: Beezie's feed no longer lists
it, so it can only be imported from the site's old store.
