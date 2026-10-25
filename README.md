# beezie-data

Samples of Grail Hunter's public claw numbers, taken every 10 minutes from
`https://beezie-bot.vercel.app/api/claws` by a GitHub Actions job, and kept as one
JSON file per UTC day in `samples/`. Public numbers only; nothing is signed in.

Each file is columnar: `t` is the sample times (ms), and each claw has an array per
figure aligned with `t` (`null` where there was no live reading):
`stock`, `avg` (Beezie average value, $), `ev` (expected return per pull, $),
`hit` (hit chance, %), `left` (hits remaining), `hv` (their value), `top` (top hit),
`swap` (net swap rate, %), `st` (0 paused, 1 active, 2 restocking).
`samples/index.json` lists the days.

## The Data tab's numbers

`build-stats.mjs` (run by the same workflow, every ten minutes; the periods longer than a day are rewritten hourly) counts every pull on
Beezie's Solana claws using the site's own counting code in `api/`, against files in
`kv/` instead of a database. It only adds pulls it hasn't counted, so finished days
are saved once and kept. It then writes the periods the Data tab shows to `data/`:
`summary-1.json` (today, UTC), `-7`, `-30`, `-91`, `-182`, `-365` (calendar days, today
so far included) and `summary-24h.json` (the last 24 hours as they ran).

Base's history from before Beezie's migration is not here: Beezie's feed no longer lists
it, so it can only be imported from the site's old store.
