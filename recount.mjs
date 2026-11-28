// Run once, by build-stats.mjs: rebuild the stored days from Nov 12 2026.
//
// From that day the job counted pulls within minutes of their landing, while
// Beezie still listed many as kept that were swapped soon after (a player has 15
// minutes to choose). Beezie's feed keeps every claw's history with each slab's
// final status, so the days are counted again from it. Everything is worked out
// and checked before anything is written; `done` is recorded so it never repeats.

import { fetchClawPulls } from './api/_pulls.js';
import { MARK_KEY, SETTLE_MS, addPulls, dayKey, dayOf } from './api/_stats.js';
import { readMany, readState, writeState } from './api/_store.js';

export const RECOUNT_FROM = Date.parse('2026-11-12T00:00:00Z');
const DONE_KEY = 'beezie:recount:2026-11-12';
const DAY_MS = 86_400_000;
const SIZES = [10_000, 50_000, 100_000, 150_000];

// A claw's feed back past RECOUNT_FROM, or an error: half a history must not be stored.
async function history(claw, read) {
  for (const size of SIZES) {
    const feed = await read(claw, size);
    if (!feed) throw new Error(`${claw.key}: feed not read`);
    if (feed.length < size || feed[feed.length - 1].at < RECOUNT_FROM) return feed;
  }
  throw new Error(`${claw.key}: the feed does not reach back far enough`);
}

/** Resolves to { days, slabs }, or null when there is nothing left to do. */
export async function recountSettled(now = Date.now(), read = fetchClawPulls) {
  if (await readState(DONE_KEY, null)) return null;
  const marks = await readState(MARK_KEY, null);
  if (!marks) return null;

  const names = [];
  for (let at = RECOUNT_FROM; at <= now; at += DAY_MS) names.push(dayOf(at));
  const stored = await readMany(names.map(dayKey), null);
  // Every claw that has anything in those days (a platform's rows share its claw's feed).
  const keys = [...new Set(stored.flatMap((day) => Object.keys(day?.claws || {}).map((key) => key.split('@')[0])))];

  const days = {};
  const dropped = {}; // 'day|claw' -> slabs counted before they had settled, left for the next catch-up
  const moved = {};
  let slabs = 0;
  for (const key of keys) {
    const claw = marks.claws?.[key];
    const mark = marks[key];
    if (!claw || !mark) throw new Error(`${key}: stored days but no record of the claw`);
    const feed = await history(claw, read);
    // What was counted before, less anything still too new to be final.
    const end = Math.min(mark.at, now - SETTLE_MS);
    const mine = feed.filter((pull) => pull.at >= RECOUNT_FROM && pull.at <= end);
    addPulls(days, claw, mine);
    slabs += mine.length;
    for (const pull of feed) {
      if (pull.at > end && pull.at <= mark.at) {
        const id = `${dayOf(pull.at)}|${key}`;
        dropped[id] = (dropped[id] || 0) + 1;
      }
    }
    const newest = feed.find((pull) => pull.at <= end);
    if (newest) {
      moved[key] = { ...mark, at: newest.at, ids: feed.filter((pull) => pull.at === newest.at).map((pull) => pull.tokenId) };
    }
  }

  // No claw's day may come out with fewer slabs than it had.
  const count = (day, key) =>
    Object.entries(day?.claws || {}).reduce((n, [k, c]) => (k.split('@')[0] === key ? n + c.slabs : n), 0);
  names.forEach((name, i) => {
    for (const key of keys) {
      const had = count(stored[i], key);
      const has = count(days[name], key) + (dropped[`${name}|${key}`] || 0);
      if (has < had) throw new Error(`${name} ${key}: ${has} slabs read, ${had} stored`);
    }
  });

  let written = 0;
  for (let i = 0; i < names.length; i += 1) {
    const fresh = days[names[i]];
    if (!fresh && !stored[i]) continue;
    const partial = (stored[i]?.partial || []).filter((key) => !keys.includes(key));
    await writeState(dayKey(names[i]), { ...(fresh || { claws: {}, players: {}, names: {} }), partial });
    written += 1;
  }
  await writeState(MARK_KEY, { ...marks, ...moved });
  await writeState(DONE_KEY, { at: now, days: written, slabs });
  return { days: written, slabs };
}
