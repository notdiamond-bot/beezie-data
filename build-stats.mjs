// Counts every pull on Beezie's Solana claws and writes the Data tab's numbers.
//
//   node build-stats.mjs
//
// The counting is the site's own (api/_stats.js), run against files instead of a
// database. Each claw keeps a mark — the newest pull counted — so a run only adds
// pulls it hasn't counted; finished days are never touched again. Totals per UTC
// day live in kv/, the finished periods the Data tab shows in data/.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchAllClaws, CHAIN_KEYS } from './src/chains.js';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { FEED_CHAINS, recentClawPulls } from './api/_pulls.js';
import { addPulls, catchUp, readDays, readMarks, summariseDays } from './api/_stats.js';

import { existsSync, readFileSync } from 'node:fs';

// This runs on every collector run (every ten minutes) but only does its work
// about once an hour, which keeps this repo's history small. FORCE=1 overrides.
const FRESH_MS = 55 * 60_000;
const last = new URL('./data/summary-24h.json', import.meta.url);
if (!process.env.FORCE && existsSync(last)) {
  const age = Date.now() - (JSON.parse(readFileSync(last, 'utf8')).updatedAt || 0);
  if (age < FRESH_MS) {
    console.log(`numbers are ${Math.round(age / 60000)} minutes old; not counting again yet`);
    process.exit(0);
  }
}

const started = Date.now();
const { claws } = await fetchAllClaws({
  chainKeys: CHAIN_KEYS.filter((key) => FEED_CHAINS.includes(key)),
  headers: BEEZIE_HEADERS,
});
if (!claws.length) {
  console.log('Beezie returned no claws; nothing counted this time');
  process.exit(0);
}

// A first run backfills a few claws at a time, so go round until all are counted.
const LIMIT_MS = 20 * 60_000;
for (let pass = 1; pass <= 40 && Date.now() - started < LIMIT_MS; pass += 1) {
  const { pending, errors } = await catchUp(claws);
  console.log(`pass ${pass}: ${pending} claws still to count${errors?.length ? `, errors: ${errors.join('; ')}` : ''}`);
  if (!pending) break;
}

const marks = await readMarks();
const registry = Object.values(marks?.claws || {});
const retired = registry.filter((claw) => claw.retired).map((claw) => claw.key);
const paused = registry.filter((claw) => claw.paused).map((claw) => claw.key);

const DAY = 86_400_000;
const now = Date.now();
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const today = Date.parse(dayOf(now));
mkdirSync(new URL('./data/', import.meta.url), { recursive: true });

const write = (name, body) => writeFileSync(new URL(`./data/${name}`, import.meta.url), JSON.stringify(body));

// The calendar periods: the last N UTC days, today so far included.
for (const days of [1, 7, 30, 91, 182, 365]) {
  const fromAt = today - (days - 1) * DAY;
  const found = await readDays(fromAt, today);
  write(`summary-${days}.json`, {
    days,
    from: dayOf(fromAt),
    to: dayOf(today),
    updatedAt: now,
    caughtUpAt: marks?.caughtUpAt || now,
    backfillPending: 0,
    first: found[0]?.day || null,
    rolling: false,
    snapshot: true,
    summary: summariseDays(found, retired, paused),
  });
}

// The last 24 hours as they ran, read straight from each claw's feed.
const since = now - DAY;
const daysMap = {};
await Promise.all(
  registry
    .filter((claw) => FEED_CHAINS.includes(claw.blockchain) && (marks[claw.key]?.at || 0) >= since)
    .map(async (claw) => {
      let pulls = null;
      for (const size of [2000, 6000, 20_000]) {
        pulls = await recentClawPulls(claw, size, now).catch(() => null);
        if (!pulls || pulls.length < size || pulls[pulls.length - 1].at <= since) break;
      }
      if (pulls) addPulls(daysMap, claw, pulls.filter((pull) => pull.at >= since));
    })
);
const rolling = Object.keys(daysMap).sort().map((day) => ({ day, ...daysMap[day] }));
write('summary-24h.json', {
  days: 1,
  from: dayOf(since),
  to: dayOf(now),
  updatedAt: now,
  caughtUpAt: now,
  backfillPending: 0,
  first: rolling[0]?.day || null,
  rolling: true,
  snapshot: true,
  summary: summariseDays(rolling, retired, paused),
});
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(0);
