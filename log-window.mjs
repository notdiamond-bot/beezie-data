// The Claw Log's opening window, built here instead of by the site's Vercel
// function: every pull of the last 24 hours on each live Solana claw, in the same
// shape /api/log sends, plus when each claw was last played.
//
//   node log-window.mjs <out.json>
//
// The site reads it from the `paid` branch (published with the labels), and asks
// Vercel only for what is newer, so this costs the site nothing. Base is left
// out: Beezie has no live claws there.

import { writeFileSync } from 'node:fs';
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
writeFileSync(out, JSON.stringify({ updatedAt: now, since, hours: HOURS, claws: live.map((c) => c.key), pulls, last, failed }));
console.log(`log window: ${pulls.length} pulls over ${live.length} claws${failed.length ? `, failed ${failed.join(',')}` : ''}, ${Math.round((Date.now() - now) / 1000)}s`);
