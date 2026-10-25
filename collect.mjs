// Saves one row per claw from Grail Hunter's public /api/claws, into one file per
// UTC day: samples/YYYY-MM-DD.json. Each file is columnar — `t` is the sample
// times, and each claw has one array per figure, aligned with `t` (null where a
// claw wasn't there or its figures weren't live). samples/index.json lists the days.
//
//   node collect.mjs
//
// Only public numbers are read; nothing is signed in and no cookies are sent.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const SOURCE = process.env.SOURCE || 'https://beezie-bot.vercel.app/api/claws';
const DIR = new URL('./samples/', import.meta.url);
mkdirSync(DIR, { recursive: true });

const FIELDS = {
  stock: (c) => c.clawStockCount,
  avg: (c) => c.averageValue, // Beezie's average slab value, dollars
  ev: (c) => c.actualEV, // expected return per pull, dollars
  hit: (c) => c.hitWinProbability, // chance of a hit, percent
  left: (c) => c.hitsRemaining,
  hv: (c) => c.hitsValue,
  top: (c) => c.topHit,
  swap: (c) => c.swapRateNetPct, // net swap rate, percent
  st: (c) => (c.status !== 'active' ? 0 : c.isRestocking ? 2 : 1), // 0 paused, 1 active, 2 restocking
};
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

const res = await fetch(SOURCE, { headers: { 'User-Agent': 'beezie-data-collector', Accept: 'application/json' } });
if (!res.ok) {
  console.log(`source answered ${res.status}; nothing saved this time`);
  process.exit(0);
}
const body = await res.json();
if (!Array.isArray(body.claws) || !body.claws.length) {
  console.log('no claws in the response; nothing saved this time');
  process.exit(0);
}

const at = Number(body.updatedAt) || Date.now();
const day = new Date(at).toISOString().slice(0, 10);
const file = new URL(`${day}.json`, DIR);
const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { day, t: [], claws: {} };

// The same response twice (served from cache) is one sample.
if (doc.t.length && doc.t[doc.t.length - 1] >= at) {
  console.log('already have this sample');
  process.exit(0);
}

const index = doc.t.length;
doc.t.push(at);
const live = new Map(body.claws.filter((c) => !c.stale).map((c) => [c.key, c]));

// A claw new to this file is padded with gaps up to now; one missing now gets a gap.
for (const [key, claw] of live) {
  if (!doc.claws[key]) {
    doc.claws[key] = { name: claw.name, chain: claw.blockchain, price: num(claw.priceUsd), series: {} };
    for (const f of Object.keys(FIELDS)) doc.claws[key].series[f] = Array(index).fill(null);
  }
  doc.claws[key].name = claw.name;
  doc.claws[key].price = num(claw.priceUsd);
}
for (const [key, entry] of Object.entries(doc.claws)) {
  const claw = live.get(key);
  for (const [f, read] of Object.entries(FIELDS)) entry.series[f].push(claw ? num(read(claw)) : null);
}

writeFileSync(file, JSON.stringify(doc));
const days = readdirSync(DIR)
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
  .map((n) => n.slice(0, 10))
  .sort();
writeFileSync(new URL('index.json', DIR), JSON.stringify({ days, updatedAt: at }));
console.log(`${day}: sample ${doc.t.length} saved, ${live.size} claws`);
