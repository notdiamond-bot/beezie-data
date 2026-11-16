// The Claw Log's labels file, by itself: every play from the last eight days whose
// real price differed from list or that was paid with Beezie credits, as
// { '<claw>|<wallet>|<at>': [paid, list, slabs, credits?] } in data/paid-recent.json.
//
// build-stats.mjs writes the same file with the summaries; this writes only it, in
// a moment, so the workflow can publish it after every read of the payments
// (paid.mjs) rather than once a run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { paidPlays, paidSince } from './api/_paid.js';

const DAY = 86_400_000;
const now = Date.now();
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const recentDays = Array.from({ length: 8 }, (_, i) => dayOf(now - i * DAY));

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('./data/paid-recent.json', import.meta.url),
  JSON.stringify({
    updatedAt: now,
    from: paidSince([...recentDays].reverse()),
    plays: Object.fromEntries(paidPlays(recentDays).map((p) => [p.id, [p.paid, p.list, p.n, ...(p.credits ? [p.credits] : [])]])),
  })
);
