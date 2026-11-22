// One-off: promo and free plays from before paid.mjs began reading (Nov 13, 08:00
// UTC), back to Beezie's first promo payment (Oct 22). Written into the same day
// files paid.mjs keeps (kv/paid/<day>.json), so the summaries take them off revenue.
//
//   node backfill-promo.mjs [fromISO] [toISO]
//
// Every promo or free play draws on Beezie's promo wallet, so only its USDC
// account's history is read (a couple of thousand payments), not every play. Each
// commit's list price is what reached Beezie's play account; what the player paid
// is that less the promo wallet's share. The play's id uses the commit's time (the
// feed's slab time is seconds later); the summaries only need its day, hour and claw.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fetchAllClaws } from './src/chains.js';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { readPlayTx } from './src/verify.js';

const RPC = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROMO_OWNER = '4WdHzBgh7NbpyZKoYVAEyNr9wvf2vDvCnrgoFsKDDUuZ';
const PROMO_USDC = '5fLHyxGhwQ1qTtB5TMY8pC1YVaU9mD44pBnuRM9KvdqG';
const PAYS = new Set(['4GwfrCbTqFq6fGGbunX5jcxTdb2M2EoPYBcU5HZYuJ6Z', '7WNczFwEYSrQSG7nWfDyJnVTSy3wB8PG8Ky99f4DReva']);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FROM = Date.parse(process.argv[2] || '2026-10-22T00:00:00Z') / 1000;
const TO = Date.parse(process.argv[3] || '2026-11-13T08:00:00Z') / 1000;
const DIR = new URL('./kv/paid/', import.meta.url);
mkdirSync(DIR, { recursive: true });

let lastAt = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const wait = lastAt + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw new Error(`${method}: the node kept refusing`);
}

const { claws } = await fetchAllClaws({ chainKeys: ['solana'], headers: BEEZIE_HEADERS });
const byMachine = Object.fromEntries(claws.filter((c) => c.contractAddress).map((c) => [c.contractAddress, c]));

// 1. The promo account's signatures inside the window.
const sigs = [];
let before;
for (;;) {
  const batch = await rpc('getSignaturesForAddress', [PROMO_USDC, { limit: 1000, ...(before ? { before } : {}) }]);
  if (!batch.length) break;
  sigs.push(...batch.filter((s) => !s.err && s.blockTime >= FROM && s.blockTime < TO));
  before = batch[batch.length - 1].signature;
  if (batch[batch.length - 1].blockTime < FROM || batch.length < 1000) break;
}
console.log(`${sigs.length} promo-account transactions to read`);

// 2. Read each commit.
const days = {};
const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const why = { notCommit: 0, noClaw: 0, noDiscount: 0 };
let kept = 0;
let i = 0;
for (const s of sigs) {
  if (++i % 200 === 0) console.log(`  ${i}/${sigs.length}`);
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  const play = tx && readPlayTx(s.signature, tx);
  if (play?.kind !== 'commit') {
    why.notCommit += 1;
    continue;
  }
  const claw = byMachine[play.machine];
  if (!claw) {
    why.noClaw += 1;
    continue;
  }
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const change = (pick) => {
    let total = 0;
    for (const b of tx.meta.postTokenBalances || []) {
      if (b.mint !== USDC || !pick(b)) continue;
      const pre = (tx.meta.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
      total += Number(b.uiTokenAmount.amount) - Number(pre?.uiTokenAmount.amount || 0);
    }
    return total / 1e6;
  };
  const list = Math.round(change((b) => PAYS.has(keys[b.accountIndex])) * 100) / 100;
  const fromPromo = -change((b) => b.owner === PROMO_OWNER);
  const paid = Math.max(0, Math.round((list - Math.max(0, fromPromo)) * 100) / 100);
  if (!(list > 0) || list - paid < 0.005) {
    why.noDiscount += 1;
    continue;
  }
  const n = Math.max(1, Math.round(list / (claw.priceUsd || list)));
  const day = dayOf(play.time);
  (days[day] ||= {})[`${claw.key}|${play.player}|${play.time * 1000}`] = [paid, list, n];
  kept += 1;
}

// 3. Merge into the day files (a day paid.mjs already has keeps its own plays).
for (const [day, plays] of Object.entries(days)) {
  const url = new URL(`${day}.json`, DIR);
  const file = existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : { claws: {}, plays: {}, backfilled: true };
  file.plays = { ...plays, ...file.plays };
  writeFileSync(url, JSON.stringify(file));
}
const total = Object.values(days).flatMap(Object.values).reduce((t, [p, l]) => t + l - p, 0);
console.log(`kept ${kept} discounted plays over ${Object.keys(days).length} days, $${total.toFixed(2)} off list`, why);
for (const d of Object.keys(days).sort()) console.log(' ', d, Object.keys(days[d]).length);
