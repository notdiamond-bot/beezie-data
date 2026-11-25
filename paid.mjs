// What players actually paid for their claw plays, promos and discounts included.
//
//   HELIUS_RPC_URL=<solana rpc> node paid.mjs
//
// Every Solana claw play opens with a "commit" transaction on Beezie's claw
// program, which pays Beezie's play wallet the claw's list price. With a promo,
// Beezie's promo wallet pays part (a $30 Wildcard: $7.50 from the promo wallet,
// $22.50 from the player) or all of it (a free play). Plays paid with Beezie
// credits come from Beezie's credits wallet instead (a RedeemCredits step): those
// credits were bought, so they count as the full price. The real price of a play
// is what reached Beezie's play account less the promo wallet's share. Beezie's pull feed only knows the list price, so
// the Data tab and the Claw Log used to assume it for every play.
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
//
// PAID_BACKFILL_FROM=<ISO time>: where a fresh start begins reading (otherwise six
// hours back). A long stretch is read 500 payments a run, oldest first, until
// caught up; each payment is read once.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fetchAllClaws, CHAIN_KEYS } from './src/chains.js';
import { BEEZIE_HEADERS } from './api/_headers.js';
import { recentClawPulls } from './api/_pulls.js';
import { readPlayTx } from './src/verify.js';
import { findNewPayAccounts } from './payAccounts.mjs';
import { entryFor, pairPays } from './matchPays.mjs';

// Written beside the file and moved into place, so the summaries step (running at
// the same time) never reads half a file.
const writeWhole = (url, text) => {
  const tmp = new URL(`${url.href}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, url);
};

const RPC = process.env.HELIUS_RPC_URL;
if (!RPC) {
  console.log('HELIUS_RPC_URL not set; skipping actual prices');
  process.exit(0);
}

// Beezie's USDC account that receives claw play payments.
const OLD_PAY_ACCOUNT = '4GwfrCbTqFq6fGGbunX5jcxTdb2M2EoPYBcU5HZYuJ6Z';
// Beezie's USDC accounts that receive claw play payments, each with when it began
// (unix seconds): the first was used until about 16:49 UTC on Nov 16, 2026, when
// payments moved to the second. Each is read from its own last signature, and a
// new one from its start. Any further move is found by itself (see below) and
// kept in the state file; it can be written in here afterwards.
const PAY_ACCOUNTS = [
  { account: OLD_PAY_ACCOUNT, since: 0 },
  { account: '7WNczFwEYSrQSG7nWfDyJnVTSy3wB8PG8Ky99f4DReva', since: Date.parse('2026-11-16T16:40:00Z') / 1000 },
];
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Beezie's promo wallet: money from it is a discount.
const PROMO_WALLETS = new Set(['4WdHzBgh7NbpyZKoYVAEyNr9wvf2vDvCnrgoFsKDDUuZ']);
// Its credits wallet pays for plays bought with Beezie credits: not a discount,
// but noted, so the Claw Log can mark the play as paid with credits.
const CREDITS_WALLET = '9vLHQPNqwXYA98ExNHgRHSHUxXQZuRD3VCEhUEAqKZXh';
// A first run looks back this far; after that, only what is new.
const FIRST_LOOKBACK_S = 6 * 3600;
const BACKFILL_FROM = process.env.PAID_BACKFILL_FROM ? Date.parse(process.env.PAID_BACKFILL_FROM) / 1000 : null;
// Bumped when what is measured changes: the state and day files are then rebuilt.
// 2: the player's own payment (promos), not what reached Beezie's account.
// 3: only Beezie's promo wallet counts as a discount; credits are full price.
const STATE_VERSION = 3;
// A payment waits this long for its play to show in the feed before it is dropped.
const PENDING_FOR_S = 8 * 3600;
// Per run. A run must finish well inside the five minutes between runs (about two
// minutes at this size), or the next run starts from progress not yet saved.
const MAX_TX_READS = 500;
const READ_LAG_S = 20;
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

const stored = readJson(STATE, null);
const fresh = !stored || stored.version !== STATE_VERSION;
const state = fresh ? { version: STATE_VERSION, lastSig: null, pending: [], recent: {}, from: null } : stored;
state.recent ||= {};
// The last signature handled, per payment account (the old state kept one, for
// the first account).
state.lastSigs ||= state.lastSig ? { [OLD_PAY_ACCOUNT]: state.lastSig } : {};
delete state.lastSig;

// 0. Has Beezie moved its payments again? When no payment has landed for ten
// minutes (and once an hour regardless), read a few of the newest plays on the
// claw program and see where their money went. An account not known yet is read
// from then on, from when the known ones went quiet. About ten credits a check.
state.payAccounts ||= [];
const accounts = () => [...PAY_ACCOUNTS, ...state.payAccounts];
{
  const nowS = Date.now() / 1000;
  const sinceCheck = nowS - (state.payCheckAt || 0);
  const quiet = nowS - (state.lastPaymentAt || 0) > 600;
  if ((quiet && sinceCheck > 600) || sinceCheck > 3600) {
    state.payCheckAt = Math.round(nowS);
    const known = new Set(accounts().map((p) => p.account));
    const { commits, found } = await findNewPayAccounts(rpc, known, { notOwners: new Set([...PROMO_WALLETS, CREDITS_WALLET]) }).catch((e) => {
      console.log(`payment account check failed: ${e.message}`);
      return { commits: 0, found: [] };
    });
    for (const f of found) {
      const since = Math.round(Math.min(f.firstAt, state.lastPaymentAt || f.firstAt) - 600);
      state.payAccounts.push({ account: f.account, owner: f.owner, since, foundAt: state.payCheckAt });
      console.log(`NEW PAYMENT ACCOUNT ${f.account} (owner ${f.owner}), seen in ${f.seen} of ${commits} recent plays; reading it from ${new Date(since * 1000).toISOString()}`);
    }
    if (!found.length) console.log(`payment accounts checked: ${commits} recent plays, all to known accounts`);
  }
}
const PAYS = new Set(accounts().map((p) => p.account));
// A fresh start reads from PAID_BACKFILL_FROM (or six hours back).
if (fresh) state.from = BACKFILL_FROM || Math.round(Date.now() / 1000 - FIRST_LOOKBACK_S);
const started = Date.now();

// 1. New payment signatures on each account, back to the last one handled there
// (or, for an account not read before, to when it began).
const sigs = [];
for (const { account, since } of accounts()) {
  const last = state.lastSigs[account] || null;
  const from = Math.max(state.from || 0, since);
  let before;
  for (let page = 0; page < 20; page += 1) {
    const batch = await rpc('getSignaturesForAddress', [
      account,
      { limit: 1000, ...(before ? { before } : {}), ...(last ? { until: last } : {}) },
    ]);
    if (!batch.length) break;
    sigs.push(...batch.filter((s) => !s.err && (last || s.blockTime >= from)).map((s) => ({ ...s, account })));
    before = batch[batch.length - 1].signature;
    if (!last && batch[batch.length - 1].blockTime < from) break;
    if (batch.length < 1000) break;
  }
}
// Oldest first across the accounts; a long gap is worked through over several runs.
const todo = sigs.sort((a, b) => a.blockTime - b.blockTime).slice(0, MAX_TX_READS);
// Every payment up to here has been read (bar the node's own lag): a play later than
// this may belong to a payment not read yet, so it waits for the next run.
const readThrough = sigs.length > todo.length ? todo[todo.length - 1].blockTime : started / 1000 - READ_LAG_S;

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
    // USDC change on the accounts matching `pick`, in dollars.
    const change = (pick) => {
      let total = 0;
      for (const b of tx.meta.postTokenBalances || []) {
        if (b.mint !== USDC || !pick(b)) continue;
        const before = (tx.meta.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
        total += Number(b.uiTokenAmount.amount) - Number(before?.uiTokenAmount.amount || 0);
      }
      return total / 1e6;
    };
    // The play's price is what reached Beezie's play account, less the promo
    // wallet's share (part of it for a promo, all of it for a free play).
    const toBeezie = change((b) => PAYS.has(keys[b.accountIndex]));
    const fromPromo = -change((b) => PROMO_WALLETS.has(b.owner));
    const paid = Math.max(0, Math.round((toBeezie - Math.max(0, fromPromo)) * 1e6) / 1e6);
    const list = Math.round(toBeezie * 1e6) / 1e6;
    // A free play is still a play: kept at $0.
    const credits = Math.max(0, Math.round(-change((b) => b.owner === CREDITS_WALLET) * 100) / 100);
    if (toBeezie > 0) payments.push({ wallet: play.player, machine: play.machine, t: play.time, paid, list, ...(credits ? { credits } : {}) });
  }
  state.lastSigs[s.account] = s.signature;
}
// When a payment last landed on a known account: what the check above watches.
for (const p of payments) state.lastPaymentAt = Math.max(state.lastPaymentAt || 0, p.t);

// 3. Match payments (new and still waiting) to plays in Beezie's feed.
const { claws } = await fetchAllClaws({ chainKeys: CHAIN_KEYS.filter((k) => k === 'solana'), headers: BEEZIE_HEADERS });
const byMachine = Object.fromEntries(claws.filter((c) => c.contractAddress).map((c) => [c.contractAddress, c]));
// While catching up from far back, a payment may be older than the usual wait.
// (back to where reading began, but never more than a day).
const now = Date.now() / 1000;
const waitSince = Math.min(now - PENDING_FOR_S, Math.max(state.from || 0, now - 26 * 3600));
const waiting = [...state.pending, ...payments].filter((p) => p.t > waitSince);
const oldest = Math.min(...waiting.map((p) => p.t), Date.now() / 1000);
// The busiest claw needs a deep page to reach back most of a day.
const feedSize = Date.now() / 1000 - oldest > 3 * 3600 ? 8000 : 2000;
const wanted = [...new Set(waiting.map((p) => p.machine))].filter((m) => byMachine[m]);

// The feed's plays: one per wallet and moment, with how many slabs.
const playsByMachine = {};
await Promise.all(
  wanted.map(async (machine) => {
    const claw = byMachine[machine];
    const pulls = (await recentClawPulls(claw, feedSize).catch(() => null)) || [];
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
const dayFile = (day) =>
  (days[day] ||= fresh ? { claws: {}, plays: {} } : readJson(new URL(`${day}.json`, DAY_DIR), { claws: {}, plays: {} }));
// Plays already paired with a payment (kept a few hours, which is all a match can span).
const used = new Set(Object.keys(state.recent));
const stillWaiting = [];
const why = { noClaw: 0, noFeed: 0, noPlay: 0 };
let matched = 0;
let discounted = 0;
let withCredits = 0;
const playFor = new Map();
for (const machine of wanted) {
  const claw = byMachine[machine];
  const free = (playsByMachine[machine] || []).filter((p) => p.at / 1000 <= readThrough && !used.has(`${claw.key}|${p.wallet}|${p.at}`));
  const pays = waiting.filter((p) => p.machine === machine);
  for (const [pay, play] of pairPays(pays, free, claw.priceUsd || 0)) playFor.set(pay, play);
}
for (const pay of waiting.sort((a, b) => a.t - b.t)) {
  const claw = byMachine[pay.machine];
  if (!claw || !playsByMachine[pay.machine]) {
    why[claw ? 'noFeed' : 'noClaw'] += 1;
    stillWaiting.push(pay);
    continue;
  }
  const day = dayOf(pay.t);
  const file = dayFile(day);
  const play = playFor.get(pay);
  if (!play) {
    why.noPlay += 1;
    stillWaiting.push(pay);
    continue;
  }
  const id = `${claw.key}|${play.wallet}|${play.at}`;
  used.add(id);
  state.recent[id] = play.at;
  matched += 1;
  // What reached Beezie's account, so the only difference is what its promo wallet paid.
  const list = pay.list ?? play.n * (claw.priceUsd || 0);
  const totals = (file.claws[claw.key] ||= { plays: 0, list: 0, paid: 0 });
  totals.plays += 1;
  totals.list += list;
  totals.paid += pay.paid;
  // Only the plays that differ from list, or were paid with credits (a fourth
  // figure: how much), are kept one by one; the rest are in the totals.
  const below = Math.abs(list - pay.paid) > 0.005;
  if (below || pay.credits) {
    file.plays[id] = entryFor({ ...pay, list }, play.n);
    if (below) discounted += 1;
    if (pay.credits) withCredits += 1;
  }
}

if (fresh) {
  for (let t = state.from; t <= Date.now() / 1000; t += 86400) dayFile(dayOf(t));
  dayFile(dayOf(Date.now() / 1000));
}
for (const [day, file] of Object.entries(days)) writeWhole(new URL(`${day}.json`, DAY_DIR), JSON.stringify(file));
state.pending = stillWaiting;
const keepSince = Date.now() - 26 * 3_600_000;
state.recent = Object.fromEntries(Object.entries(state.recent).filter(([, at]) => at > keepSince));
writeWhole(STATE, JSON.stringify(state));
console.log(
  `actual prices: ${todo.length} payments read (${payments.length} plays), ${matched} matched, ${discounted} below list, ${withCredits} with credits, ` +
    `${stillWaiting.length} waiting ${JSON.stringify(why)}; ${credits} credits, ${Math.round((Date.now() - started) / 1000)}s`
);
