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

// When each claw restocked, kept here because the site's own store keeps
// nothing between instances. A Wildcard or Gold claw is emptied and refilled:
// Beezie marks it restocking meanwhile, and its stock jumps back up. A Grail+
// claw (reusable) takes swapped slabs back in, so it never restocks.
//
// The refill is over when the restocking mark clears with stock well above the
// lowest it reached beforehand. Measured from that low, not from the last
// reading: on 24 Nov Wildcard reopened at 1,235 and was down to 1,233 by the
// next check, which a comparison with the last reading missed.
const RESTOCKS = new URL('./kv/restocks.json', import.meta.url);
const RISE = 10;
const HISTORY_MS = 8 * 86_400_000;
const restockState = existsSync(RESTOCKS) ? JSON.parse(readFileSync(RESTOCKS, 'utf8')) : { seen: {}, last: {} };
restockState.history ||= {};
restockState.dating ||= {};
const landed = {};
for (const claw of live) {
  if (claw.reusable) continue;
  const before = restockState.seen[claw.key];
  const now_ = { stock: claw.clawStockCount, restocking: Boolean(claw.restockStartedAt) };
  // The lowest stock since the last refill; held through a restock, when the count climbs.
  const low = Math.min(before?.low ?? before?.stock ?? now_.stock, now_.restocking ? Infinity : now_.stock);
  now_.low = Number.isFinite(low) ? low : now_.stock;
  // When the refill's slabs were first seen in stock. Not restockStartedAt: the
  // mark goes on while the machine is still empty, and a pull can follow it.
  if (now_.restocking && now_.stock - now_.low >= RISE) now_.landedAt = before?.landedAt ?? now;
  if (before && !now_.restocking && now_.stock - (before.low ?? before.stock) >= RISE) {
    // Dated by when its slabs were first seen (checks are a minute or two apart).
    // If no check caught that, by the first play after the earlier check, below.
    const at = before.landedAt ?? null;
    restockState.last[claw.key] = at ?? now;
    restockState.history[claw.key] = [...(restockState.history[claw.key] || []), at ?? now];
    if (at === null) restockState.dating[claw.key] = before.at || now - 10 * 60_000;
    now_.low = now_.stock;
    console.log(`restock: ${claw.key} ${before.low ?? before.stock} -> ${now_.stock}`);
  }
  // Slabs are in but the restocking mark is still on: published now, not a check or
  // more later when it clears. The time is the one recorded then.
  if (now_.restocking && now_.landedAt) landed[claw.key] = now_.landedAt;
  now_.at = now;
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
  if (Number.isFinite(first)) {
    // The provisional time in the history becomes the first play's.
    const provisional = restockState.last[key];
    restockState.history[key] = (restockState.history[key] || []).map((t) => (t === provisional ? first : t));
    restockState.last[key] = first;
  }
  if (Number.isFinite(first) || now - after > 3_600_000) delete restockState.dating[key];
}
for (const key of Object.keys(restockState.history)) {
  restockState.history[key] = [...new Set(restockState.history[key])].filter((t) => t > now - HISTORY_MS).sort((a, b) => a - b);
}
writeFileSync(RESTOCKS, JSON.stringify(restockState));
const shownHistory = { ...restockState.history };
const shownLast = { ...restockState.last };
for (const [key, at] of Object.entries(landed)) {
  shownHistory[key] = [...(shownHistory[key] || []), at];
  shownLast[key] = at;
}
writeFileSync(out, JSON.stringify({ updatedAt: now, since, hours: HOURS, claws: live.map((c) => c.key), pulls, last, restocks: shownLast, restockHistory: shownHistory, failed }));
console.log(`log window: ${pulls.length} pulls over ${live.length} claws${failed.length ? `, failed ${failed.join(',')}` : ''}, ${Math.round((Date.now() - now) / 1000)}s`);
