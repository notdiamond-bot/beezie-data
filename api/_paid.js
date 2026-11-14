// Actual prices (see paid.mjs) laid over the counted summaries.
//
// The counting assumes every pull cost the claw's list price. paid.mjs keeps,
// per UTC day, each play whose real price differed. Here those differences are
// taken off revenue: the period's total, each day's (and its chain's share), each
// claw's, and the take and margin that follow from them. Players' own spend is
// left as counted; a player's discount is shown on the Claw Log.

import { existsSync, readFileSync } from 'node:fs';
import { SPECULATE_WALLET, ARENA_WALLET } from '../src/speculate.js';

const DIR = new URL('../kv/paid/', import.meta.url);

/** The day's file, or null where actual prices weren't being read yet. */
export function readPaidDay(day) {
  const file = new URL(`${day}.json`, DIR);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// Speculate's and Dev.Fun's plays are counted as their own chain and claw rows.
const sideOf = (wallet) => (wallet === SPECULATE_WALLET ? 'elysium' : wallet === ARENA_WALLET ? 'devfun' : null);

/**
 * Every play below (or above) list across `days` (UTC day strings), as
 * { id, key, rowKey, chain, wallet, at, paid, list, n, day }, optionally only those
 * at or after `since` (ms).
 */
export function paidPlays(days, since = 0) {
  const out = [];
  for (const day of days) {
    const file = readPaidDay(day);
    if (!file) continue;
    for (const [id, [paid, list, n]] of Object.entries(file.plays || {})) {
      const [key, wallet, atText] = id.split('|');
      const at = Number(atText);
      if (at < since) continue;
      const side = sideOf(wallet);
      out.push({ id, key, rowKey: side ? `${key}@${side}` : key, chain: side || key.split(':')[0], wallet, at, paid, list, n, day });
    }
  }
  return out;
}

/** The first of `days` with actual prices read, or null. */
export const paidSince = (days) => days.find((day) => readPaidDay(day)) || null;

/** Apply the differences to a summary (as summariseDays returns it), in place. */
export function applyPaid(summary, plays) {
  if (!plays.length) return summary;
  let total = 0;
  for (const p of plays) {
    const less = p.list - p.paid;
    total += less;
    const row = summary.daily?.find((d) => d.day === p.day);
    if (row) {
      row.revenue -= less;
      row.byChain[p.chain] = (row.byChain[p.chain] || 0) - less;
    }
    const hour = summary.hourly?.find((h) => p.at >= h.at && p.at < h.at + 3_600_000);
    if (hour) {
      hour.revenue -= less;
      hour.byChain[p.chain] = (hour.byChain[p.chain] || 0) - less;
    }
    const claw = summary.claws?.find((c) => c.key === p.rowKey);
    if (claw) claw.revenue -= less;
  }
  summary.revenue -= total;
  summary.take = summary.revenue - summary.paid;
  summary.margin = summary.revenue ? summary.take / summary.revenue : NaN;
  summary.arpu = summary.players ? summary.revenue / summary.players : NaN;
  summary.discounts = { plays: plays.length, amount: Math.round(total * 100) / 100 };
  return summary;
}
