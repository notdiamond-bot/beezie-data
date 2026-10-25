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
