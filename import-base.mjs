// One-time import of Base's pulls, for the claws that are finished (98, 99, 100, 101,
// 104). Beezie's feed no longer lists Base pulls, but its play records still exist
// for these claws:
//
//   value        Beezie's play record  GET /claw/v3/play/<claw>/<play>  (slab ids, swap
//                value and item value of every slab the play won)
//   when, who    the claim transaction on Base: its block gives the time (Base makes a
//                block every two seconds, checked against real block times below) and
//                the Transfer logs name the wallet each slab went to
//   name         Beezie's wallet lookup, so a player on Base and on Solana is one person
//
// Every slab is counted as swapped (about 98% are, by Beezie's own figures), so the
// "kept" figures from this import are zero and "paid out" is an estimate.
//
// Saved as one file per day in base-days/ — once. Claws 72–97 (Jan–Jul) never had
// play records and cannot be imported. Resumable: what it has fetched is kept in
// base-work/ (not committed), and kv/base_import_done.json stops it running twice.
//
//   node import-base.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { RETIRED_CLAWS, addPulls } from './api/_stats.js';
import { readState, writeState } from './api/_store.js';

const DONE = 'beezie:base_import_done';
if ((await readState(DONE, null)) && !process.env.FORCE) {
  console.log('Base was already imported; nothing to do (FORCE=1 overrides — it would count twice).');
  process.exit(0);
}

const WORK = new URL('./base-work/', import.meta.url);
mkdirSync(WORK, { recursive: true });
const API = 'https://api.beezie.com';
const RPC = 'https://mainnet.base.org';
const RPC_BACKUP = 'https://base.drpc.org';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CLAWS = { 98: 91000, 99: 50000, 100: 30000, 101: 30000, 104: 30000 }; // generous ceilings to bisect under
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Beezie's API sits behind Cloudflare's rate limit. Requests here are spaced out, and
// when it answers 429 EVERY request waits out its Retry-After before going on.
let pausedUntil = 0;
const GAP_MS = Number(process.env.GAP_MS || 160); // between requests, across all workers
let lastSent = 0;
async function politely() {
  for (;;) {
    const now = Date.now();
    const wait = Math.max(pausedUntil - now, lastSent + GAP_MS - now);
    if (wait <= 0) break;
    await sleep(wait);
  }
  lastSent = Date.now();
}

async function getJson(url, init = {}, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    await politely();
    try {
      const res = await fetch(url, { ...init, headers: { ...BEEZIE_HEADERS, ...(init.headers || {}) } });
      if (res.status === 404) return null;
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after')) || 60;
        pausedUntil = Date.now() + (after + 5) * 1000;
        log(`rate limited; everything waits ${after + 5}s`);
        continue;
      }
      if (res.status >= 500 || res.status === 403) {
        await sleep(2000 * (i + 1));
        continue;
      }
      const text = await res.text();
      return text.trim().startsWith('{') || text.trim().startsWith('[') ? JSON.parse(text) : text;
    } catch {
      await sleep(1000 * (i + 1));
    }
  }
  return undefined; // gave up
}

// A pool: `n` tasks at a time over a list.
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        await fn(items[i], i);
      }
    })
  );
}

// ---- 1. the claws -----------------------------------------------------------
// Prices, fee and tier bands, taken from the retired-claw list at the same price, as
// the site's own history does (see api/_stats.js): Wildcard $30, Gold TCG $250,
// Silver $50. No call to Beezie is needed, which matters while it is rate limiting.
const sameAs = (price) => RETIRED_CLAWS.find((c) => c.blockchain === 'base' && c.priceUsd === price && c.priceRanges);
const meta = {
  98: { ...sameAs(30), key: 'base:98', id: 98, name: 'Wildcard', label: undefined, retired: false },
  99: RETIRED_CLAWS.find((c) => c.key === 'base:99'),
  100: { ...sameAs(250), key: 'base:100', id: 100, name: 'Gold TCG', label: undefined, retired: false },
  101: RETIRED_CLAWS.find((c) => c.key === 'base:101'),
  104: { ...sameAs(50), key: 'base:104', id: 104, name: 'Silver', label: undefined, retired: false },
};
for (const [id, claw] of Object.entries(meta)) if (!claw?.priceRanges) throw new Error(`no details for base:${id}`);
log('claws', Object.values(meta).map((c) => `${c.key} ${c.name} $${c.priceUsd}`).join(' | '));

// ---- 2. the play records ----------------------------------------------------
const claimed = async (c, p) => (await getJson(`${API}/claw/v3/play/${c}/${p}`))?.status === 'claimed';
const plays = {};
for (const [id, ceiling] of Object.entries(CLAWS)) {
  const file = new URL(`plays-${id}.ndjson`, WORK);
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const tried = new Set(rows.map((r) => r.p));
  const metaFile = new URL(`newest-${id}.json`, WORK);
  let newest;
  if (existsSync(metaFile)) {
    newest = JSON.parse(readFileSync(metaFile, 'utf8')).newest;
  } else {
    let lo = 1;
    let hi = 2;
    while (hi < ceiling && (await claimed(id, hi))) {
      lo = hi;
      hi *= 2;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await claimed(id, mid)) lo = mid;
      else hi = mid;
    }
    newest = lo + 40; // slack for a few left pending near the end
    writeFileSync(metaFile, JSON.stringify({ newest }));
  }
  const todo = [];
  for (let p = 1; p <= newest; p += 1) if (!tried.has(p)) todo.push(p);
  log(`claw ${id}: plays 1..${newest}, ${tried.size} already read, ${todo.length} to read`);
  let done = 0;
  let buffer = [];
  const flush = () => {
    if (buffer.length) appendFileSync(file, buffer.map((r) => JSON.stringify(r)).join('\n') + '\n');
    buffer = [];
  };
  await pool(todo, 4, async (p) => {
    const rec = await getJson(`${API}/claw/v3/play/${id}/${p}`);
    if (rec === undefined) return; // gave up: read again on resume
    if (rec && rec.status === 'claimed' && rec.claimTxHash) {
      const row = { p, tx: rec.claimTxHash, tokens: rec.tokenIds.map(String), swap: rec.swapValues, item: rec.itemValues };
      buffer.push(row);
      rows.push(row);
    } else {
      buffer.push({ p, none: true });
    }
    done += 1;
    if (done % 200 === 0) flush();
    if (done % 2000 === 0) log(`  claw ${id}: ${done}/${todo.length}`);
  });
  flush();
  plays[id] = rows.filter((r) => !r.none).sort((a, b) => a.p - b.p);
  log(`claw ${id}: ${plays[id].length} claimed plays`);
}

// ---- 3. the claim transactions: block and recipients -------------------------
const receiptsFile = new URL('receipts.json', WORK);
const receipts = existsSync(receiptsFile) ? JSON.parse(readFileSync(receiptsFile, 'utf8')) : {};
const hashes = [...new Set(Object.values(plays).flat().map((p) => p.tx))].filter((h) => !receipts[h]);
log(`receipts: ${Object.keys(receipts).length} cached, ${hashes.length} to fetch`);
const BATCH = 20; // under Base's node's 25-requests-a-second cap, counting every call in a batch
const batches = [];
for (let i = 0; i < hashes.length; i += BATCH) batches.push(hashes.slice(i, i + BATCH));
let fetched = 0;
for (const group of batches) {
  const body = group.map((h, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getTransactionReceipt', params: [h] }));
  let replies = null;
  for (let attempt = 0; attempt < 14 && !replies; attempt += 1) {
    // After a few failures, try a second public node, then come back.
    const node = attempt >= 3 && attempt % 2 === 1 ? RPC_BACKUP : RPC;
    try {
      const res = await fetch(node, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const json = await res.json();
      if (Array.isArray(json) && json.length === body.length && json.every((r) => !r.error)) replies = json;
      else await sleep(Math.min(1500 * (attempt + 1), 20000));
    } catch {
      await sleep(Math.min(1500 * (attempt + 1), 20000));
    }
  }
  if (!replies) throw new Error('Base node would not answer; run again to resume');
  for (const r of replies) {
    const rec = r.result;
    if (!rec) continue;
    const to = {};
    for (const logEntry of rec.logs) {
      if (logEntry.topics.length === 4 && logEntry.topics[0] === TRANSFER) {
        const token = BigInt(logEntry.topics[3]).toString();
        if (!to[token]) to[token] = `0x${logEntry.topics[2].slice(-40)}`;
      }
    }
    receipts[group[r.id]] = { b: parseInt(rec.blockNumber, 16), to };
  }
  fetched += group.length;
  if ((fetched / BATCH) % 50 === 0) {
    log(`  receipts ${fetched}/${hashes.length}`);
    writeFileSync(receiptsFile, JSON.stringify(receipts));
  }
  await sleep(1000);
}
writeFileSync(receiptsFile, JSON.stringify(receipts));
log(`receipts done: ${Object.keys(receipts).length}`);

// ---- 4. block times ----------------------------------------------------------
const blocks = Object.values(receipts).map((r) => r.b);
const lowB = Math.min(...blocks);
const highB = Math.max(...blocks);
const stamp = async (n) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] }) });
  return parseInt((await res.json()).result.timestamp, 16);
};
const t0 = await stamp(lowB);
const probes = [Math.round(lowB + (highB - lowB) * 0.5), highB];
for (const b of probes) {
  const expected = t0 + (b - lowB) * 2;
  const real = await stamp(b);
  log(`block ${b}: real ${real}, 2s-per-block gives ${expected} (off by ${real - expected}s)`);
  if (Math.abs(real - expected) > 10) throw new Error('block times are not a steady two seconds; refusing to guess');
  await sleep(300);
}
const timeOf = (b) => (t0 + (b - lowB) * 2) * 1000;

// ---- 5. who they are ---------------------------------------------------------
const namesFile = new URL('names.json', WORK);
const names = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : {};
const wallets = [...new Set(Object.values(receipts).flatMap((r) => Object.values(r.to)))].filter((w) => names[w] === undefined);
log(`names: ${Object.keys(names).length} cached, ${wallets.length} wallets to look up`);
let looked = 0;
await pool(wallets, 12, async (w) => {
  const res = await getJson(`${API}/user/by-walletAddress/${w}`);
  names[w] = res && typeof res === 'object' ? res.user?.username || '' : res === undefined ? undefined : '';
  looked += 1;
  if (looked % 1000 === 0) {
    log(`  names ${looked}/${wallets.length}`);
    writeFileSync(namesFile, JSON.stringify(names));
  }
});
writeFileSync(namesFile, JSON.stringify(names));

// ---- 6. count it -------------------------------------------------------------
const days = {};
let slabs = 0;
let skipped = 0;
for (const [id, list] of Object.entries(plays)) {
  const pulls = [];
  for (const play of list) {
    const rec = receipts[play.tx];
    if (!rec) {
      skipped += 1;
      continue;
    }
    const at = timeOf(rec.b);
    play.tokens.forEach((token, i) => {
      const wallet = rec.to[token] || null;
      pulls.push({
        tokenId: token,
        name: null,
        at,
        wallet,
        player: (wallet && names[wallet]) || null,
        status: 'swapped',
        swapValue: Number(play.swap[i]) || 0,
        itemValue: Number(play.item[i]) || 0,
      });
    });
  }
  addPulls(days, meta[id], pulls);
  slabs += pulls.length;
  log(`claw ${id}: ${pulls.length} slabs counted`);
}
// Base is finished, so it is saved on its own — one file per day in base-days/ — and
// merged in only when the summaries are built (build-stats.mjs). It never touches the
// day files in kv/ that the hourly count keeps adding Solana pulls to.
mkdirSync(new URL('./base-days/', import.meta.url), { recursive: true });
for (const [day, batch] of Object.entries(days)) {
  writeFileSync(new URL(`./base-days/${day}.json`, import.meta.url), JSON.stringify(batch));
}
await writeState(DONE, { at: Date.now(), slabs, plays: Object.fromEntries(Object.entries(plays).map(([k, v]) => [k, v.length])), skipped });
log(`imported ${slabs} slabs over ${Object.keys(days).length} days (${skipped} plays without a receipt)`);
process.exit(0);
