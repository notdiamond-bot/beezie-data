// What players actually paid for their claw plays, promos and discounts included.
//
//   HELIUS_RPC_URL=<solana rpc> node paid.mjs
//
// Every Solana claw play opens with a "commit" transaction on Beezie's claw
// program, in which the player sends USDC to Beezie's play wallet. That amount is
// the real price of the play: the claw's list price, or less with a promo. Beezie's
// pull feed only knows the list price, so the Data tab and the Claw Log used to
// assume it for every play.
//
// Each run reads the payments that landed since the last run (one signature list
// call per thousand, one transaction read each: about 4,000 credits a day), matches
// each to the play it paid for in Beezie's feed (same wallet and claw, a few
// seconds before the slabs came out), and keeps, per UTC day:
//   - every play whose price differed from list, and
//   - per-claw totals of list price and actual price for the plays matched.
// Files: kv/paid/<day>.json, kv/paid_state.json. The summaries step reads them.
//
// Without HELIUS_RPC_URL it does nothing, so the workflow runs as before.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchAllClaws, CHAIN_KEYS } from './src/chains.js';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { recentClawPulls } from './api/_pulls.js';
import { readPlayTx } from './src/verify.js';

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) {
  console.log('HELIUS_RPC_URL not set; skipping actual prices');
  process.exit(0);
}

// Beezie's USDC account that receives claw play payments.
const PAY_ACCOUNT = '4GwfrCbTqFq6fGGbunX5jcxTdb2M2EoPYBcU5HZYuJ6Z';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// A first run looks back this far; after that, only what is new.
const FIRST_LOOKBACK_S = 6 * 3600;
// A payment waits this long for its play to show in the feed before it is dropped.
const PENDING_FOR_S = 8 * 3600;
// The slabs come out within this many seconds after the payment.
const MATCH_BEFORE_S = 300;
const MATCH_AFTER_S = 15;
const MAX_TX_READS = 1500; // per run, so a long gap catches up over a few runs
const REQUESTS_PER_SECOND = 8; // under the plan's 10

const STATE = new URL('./kv/paid_state.json', import.meta.url);
const DAY_DIR = new URL('./kv/paid/', import.meta.url);
mkdirSync(DAY_DIR, { recursive: true });
const readJson = (url, fallback) => (existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : fallback);
const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

let credits = 0;
let lastAt = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = lastAt + 1000 / REQUESTS_PER_SECOND - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    credits += 1;
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  throw new Error(`${method}: the node kept refusing`);
}

const state = readJson(STATE, { lastSig: null, pending: [], recent: {} });
state.recent ||= {};
const started = Date.now();

// 1. New payment signatures, newest first, back to the last one handled.
const sigs = [];
let before;
for (let page = 0; page < 20; page += 1) {
  const batch = await rpc('getSignaturesForAddress', [
    PAY_ACCOUNT,
    { limit: 1000, ...(before ? { before } : {}), ...(state.lastSig ? { until: state.lastSig } : {}) },
  ]);
  if (!batch.length) break;
  sigs.push(...batch.filter((s) => !s.err));
  before = batch[batch.length - 1].signature;
  if (!state.lastSig && batch[batch.length - 1].blockTime < Date.now() / 1000 - FIRST_LOOKBACK_S) break;
  if (batch.length < 1000) break;
}
const firstCutoff = state.lastSig ? 0 : Date.now() / 1000 - FIRST_LOOKBACK_S;
// Oldest first; a long gap is worked through over several runs.
const todo = sigs.filter((s) => s.blockTime >= firstCutoff).reverse().slice(0, MAX_TX_READS);

// 2. Read each: a claw commit, and what reached Beezie's account.
const payments = [];
for (const s of todo) {
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  const play = readPlayTx(s.signature, tx);
  if (play?.kind === 'commit') {
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta?.loadedAddresses?.writable || []),
      ...(tx.meta?.loadedAddresses?.readonly || []),
    ];
    const at = (balances) => balances.find((b) => keys[b.accountIndex] === PAY_ACCOUNT && b.mint === USDC);
    const pre = Number(at(tx.meta.preTokenBalances || [])?.uiTokenAmount.amount || 0);
    const post = Number(at(tx.meta.postTokenBalances || [])?.uiTokenAmount.amount || 0);
    const paid = (post - pre) / 1e6;
    if (paid > 0) payments.push({ wallet: play.player, machine: play.machine, t: play.time, paid });
  }
  state.lastSig = s.signature;
}

// 3. Match payments (new and still waiting) to plays in Beezie's feed.
const { claws } = await fetchAllClaws({ chainKeys: CHAIN_KEYS.filter((k) => k === 'solana'), headers: BEEZIE_HEADERS });
const byMachine = Object.fromEntries(claws.filter((c) => c.contractAddress).map((c) => [c.contractAddress, c]));
const waiting = [...state.pending, ...payments].filter((p) => p.t > Date.now() / 1000 - PENDING_FOR_S);
const wanted = [...new Set(waiting.map((p) => p.machine))].filter((m) => byMachine[m]);

// The feed's plays: one per wallet and moment, with how many slabs.
const playsByMachine = {};
await Promise.all(
  wanted.map(async (machine) => {
    const claw = byMachine[machine];
    const pulls = (await recentClawPulls(claw, 2000).catch(() => null)) || [];
    const plays = new Map();
    for (const p of pulls) {
      const id = `${p.wallet}|${p.at}`;
      if (!plays.has(id)) plays.set(id, { wallet: p.wallet, at: p.at, n: 0 });
      plays.get(id).n += 1;
    }
    playsByMachine[machine] = [...plays.values()];
  })
);

const days = {};
const dayFile = (day) => (days[day] ||= readJson(new URL(`${day}.json`, DAY_DIR), { claws: {}, plays: {} }));
// Plays already paired with a payment (kept a few hours, which is all a match can span).
const used = new Set(Object.keys(state.recent));
const stillWaiting = [];
const why = { noClaw: 0, noFeed: 0, noPlay: 0 };
let matched = 0;
let discounted = 0;
for (const pay of waiting.sort((a, b) => a.t - b.t)) {
  const claw = byMachine[pay.machine];
  const plays = playsByMachine[pay.machine];
  if (!claw || !plays) {
    why[claw ? 'noFeed' : 'noClaw'] += 1;
    stillWaiting.push(pay);
    continue;
  }
  const candidates = plays
    .filter((p) => p.wallet === pay.wallet && p.at / 1000 >= pay.t - MATCH_AFTER_S && p.at / 1000 <= pay.t + MATCH_BEFORE_S)
    .sort((a, b) => a.at - b.at);
  const day = dayOf(pay.t);
  const file = dayFile(day);
  const play = candidates.find((p) => !used.has(`${claw.key}|${p.wallet}|${p.at}`));
  if (!play) {
    why.noPlay += 1;
    stillWaiting.push(pay);
    continue;
  }
  const id = `${claw.key}|${play.wallet}|${play.at}`;
  used.add(id);
  state.recent[id] = play.at;
  matched += 1;
  const list = play.n * (claw.priceUsd || 0);
  const totals = (file.claws[claw.key] ||= { plays: 0, list: 0, paid: 0 });
  totals.plays += 1;
  totals.list += list;
  totals.paid += pay.paid;
  // Only the plays that differ from list are kept one by one; the rest are in the totals.
  if (Math.abs(list - pay.paid) > 0.005) {
    file.plays[id] = [Math.round(pay.paid * 100) / 100, list, play.n];
    discounted += 1;
  }
}

for (const [day, file] of Object.entries(days)) writeFileSync(new URL(`${day}.json`, DAY_DIR), JSON.stringify(file));
state.pending = stillWaiting;
const keepSince = Date.now() - 8 * 3_600_000;
state.recent = Object.fromEntries(Object.entries(state.recent).filter(([, at]) => at > keepSince));
writeFileSync(STATE, JSON.stringify(state));
console.log(
  `actual prices: ${todo.length} payments read (${payments.length} plays), ${matched} matched, ${discounted} below list, ` +
    `${stillWaiting.length} waiting ${JSON.stringify(why)}; ${credits} credits, ${Math.round((Date.now() - started) / 1000)}s`
);
