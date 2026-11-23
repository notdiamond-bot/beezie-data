// The Claw Log's opening window, built here instead of by the site's Vercel
// function: every pull of the last 24 hours on each live Solana claw, in the same
// shape /api/log sends, plus when each claw was last played.
//
//   node log-window.mjs <out.json>
//
// The site reads it from the `paid` branch (published with the labels), and asks
// Vercel only for what is newer, so this costs the site nothing. Base is left
// out: Beezie has no live claws there.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchAllClaws } from './src/chains.js';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { recentClawPulls } from './api/_pulls.js';

const HOURS = 24;
// Page sizes tried until a page reaches back past the window (a busy Wildcard day
// is several thousand pulls).
const SIZES = [2000, 6000, 20_000];
const out = process.argv[2] || 'log-window.json';
const now = Date.now();
const since = now - HOURS * 3_600_000;

// The site leaves out a picture that is the slab's usual address (it rebuilds it).
const usualImage = (blockchain, tokenId) => `https://images.beezie.com/${blockchain}/${tokenId}/4/original.webp`;

const { claws } = await fetchAllClaws({ chainKeys: ['solana'], headers: BEEZIE_HEADERS });
// Every Solana claw, paused or not: Beezie pauses a claw while it restocks, and
// its day of pulls must not vanish from the log meanwhile.
const live = claws || [];

// When each claw last restocked, kept here because the site's own store keeps
// nothing between instances. A Wildcard or Gold claw is emptied and refilled:
// Beezie marks it restocking meanwhile, and its stock jumps back up. A Grail+
// claw (reusable) takes swapped slabs back in, so it never restocks.
const RESTOCKS = new URL('./kv/restocks.json', import.meta.url);
const RISE = 10;
const restockState = existsSync(RESTOCKS) ? JSON.parse(readFileSync(RESTOCKS, 'utf8')) : { seen: {}, last: {} };
for (const claw of live) {
  if (claw.reusable) continue;
  const before = restockState.seen[claw.key];
  const now_ = { stock: claw.clawStockCount, restocking: Boolean(claw.restockStartedAt) };
  if (before && !now_.restocking && (before.restocking || now_.stock - before.stock >= RISE) && now_.stock > before.stock) {
    // Noticed now, but it reopened since the last check: dated below from the
    // first play after that check (or now, if nobody has played yet).
    restockState.last[claw.key] = now;
    (restockState.dating ||= {})[claw.key] = before.at || now - 10 * 60_000;
    console.log(`restock: ${claw.key} ${before.stock} -> ${now_.stock}`);
  }
  now_.at = now;
  // Mid-restock the count climbs as slabs go in; the cycle starts when it ends.
  restockState.seen[claw.key] = now_;
}
const pulls = [];
const last = {};
const failed = [];
for (const claw of live) {
  let feed = null;
  for (const size of SIZES) {
    feed = await recentClawPulls(claw, size, now, { paused: claw.isPaused }).catch(() => null);
    if (!feed || feed.length < size || feed[feed.length - 1].at <= since) break;
  }
  if (!feed) {
    failed.push(claw.key);
    continue;
  }
  if (feed.length) last[claw.key] = Math.max(...feed.map((p) => p.at));
  for (const p of feed) {
    if (p.at < since) continue;
    const row = { key: claw.key, tokenId: p.tokenId, name: p.name, image: p.image, at: p.at, wallet: p.wallet, player: p.player, status: p.status, swapValue: p.swapValue, itemValue: p.itemValue };
    if (row.image === usualImage('solana', row.tokenId)) delete row.image;
    pulls.push(row);
  }
}
pulls.sort((a, b) => b.at - a.at);
// Date each restock still waiting by the first play after it reopened; it keeps
// waiting (an hour at most) until someone plays.
for (const [key, after] of Object.entries(restockState.dating || {})) {
  const first = pulls.filter((p) => p.key === key && p.at > after).reduce((m, p) => Math.min(m, p.at), Infinity);
  if (Number.isFinite(first)) restockState.last[key] = first;
  if (Number.isFinite(first) || now - after > 3_600_000) delete restockState.dating[key];
}
writeFileSync(RESTOCKS, JSON.stringify(restockState));
writeFileSync(out, JSON.stringify({ updatedAt: now, since, hours: HOURS, claws: live.map((c) => c.key), pulls, last, restocks: restockState.last, failed }));
console.log(`log window: ${pulls.length} pulls over ${live.length} claws${failed.length ? `, failed ${failed.join(',')}` : ''}, ${Math.round((Date.now() - now) / 1000)}s`);
