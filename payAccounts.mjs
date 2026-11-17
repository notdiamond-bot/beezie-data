// Finding where Beezie's claw play payments land, from the plays themselves.
//
// paid.mjs reads the payments on Beezie's receiving accounts. Beezie can move
// them to a new account at any time (it did on Nov 16, 2026, and every label
// stopped). This reads the newest plays on the claw program and, for each
// commit (the transaction that pays for a play), finds the USDC account that
// received the money: the one gaining the most that belongs to neither the
// player nor Beezie's promo and credits wallets. An account seen in at least two
// of them and not yet known is a new receiving account.

import { PROGRAM, readPlayTx } from './src/verify.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** The USDC account that received a commit's payment, or null. */
export function receiverOf(tx, { notOwners = new Set() } = {}) {
  const play = readPlayTx('', tx);
  if (play?.kind !== 'commit') return null;
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable || []),
    ...(tx.meta?.loadedAddresses?.readonly || []),
  ];
  let best = null;
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.mint !== USDC || b.owner === play.player || notOwners.has(b.owner)) continue;
    const before = (tx.meta.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
    const gain = Number(b.uiTokenAmount.amount) - Number(before?.uiTokenAmount.amount || 0);
    if (gain > 0 && (!best || gain > best.gain)) best = { account: keys[b.accountIndex], owner: b.owner, gain, time: tx.blockTime };
  }
  return best;
}

/**
 * Receiving accounts seen in the newest plays that are not in `known`:
 * [{ account, owner, seen, firstAt }]. `rpc(method, params)` is the caller's.
 * Reads up to `look` of the program's newest transactions, stopping after `want`
 * commits.
 */
export async function findNewPayAccounts(rpc, known, { notOwners = new Set(), look = 30, want = 6 } = {}) {
  const sigs = (await rpc('getSignaturesForAddress', [PROGRAM, { limit: look }])).filter((s) => !s.err);
  const seen = new Map();
  let commits = 0;
  for (const s of sigs) {
    if (commits >= want) break;
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const got = tx && receiverOf(tx, { notOwners });
    if (!got) continue;
    commits += 1;
    if (known.has(got.account)) continue;
    const entry = seen.get(got.account) || { account: got.account, owner: got.owner, seen: 0, firstAt: got.time };
    entry.seen += 1;
    entry.firstAt = Math.min(entry.firstAt, got.time);
    seen.set(got.account, entry);
  }
  return { commits, found: [...seen.values()].filter((e) => e.seen >= 2) };
}
