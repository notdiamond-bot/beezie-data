// Daily totals for the Data tab, built from Beezie's pull feed.
//
// Every pull the feed lists — every tier, with its player, market value, swap
// value and whether it was kept — is counted once into the day it happened, per
// claw. Each UTC day is its own small key (`beezie:stats:v2:2026-10-18`), so a
// poll that sees new pulls rewrites a few kilobytes at most and the Data tab
// reads only the days it shows.
//
// A pull is counted once: per claw we keep a mark — the newest pull counted,
// the slabs at that exact moment, and how far back counting reaches (`from`) —
// and only what lies outside that window goes in.
//
// Beezie's feed keeps a claw's whole history and serves it as one page of
// whatever size is asked for, so nothing has to be missed:
//   - the first time a claw is seen, its last BACKFILL_DAYS are read in one go;
//   - the shared poll counts new pulls as it sees them, and when it finds it
//     has been away long enough that its page no longer reaches the mark, it
//     reads further back until it does;
//   - only a gap too deep even for that flags its days as partial.

// Revenue is slabs x claw price (each slab is one paid pull). What went back to
// players is the swap payout after Beezie's fee for a swapped slab, and the
// slab's market value for a kept one. The difference is an estimate of Beezie's
// take: it prices a kept slab at market value, not at what Beezie paid for it.

import { tierOf } from '../src/chains.js';
import { FEED_CHAINS, fetchClawPulls } from './_pulls.js';
import { readMany, readState, readStateStrict, writeState } from './_store.js';

// Where pulls are read from. Swapped out by the tests.
let reader = fetchClawPulls;
export const __setReader = (fn) => (reader = fn || fetchClawPulls);

// Claws Beezie has retired. Its claw list only carries live machines, so these
// vanished from the site the day they closed — but the feed keeps their
// history, and in the month to 18 Oct 2026 they took in about $4.9M, more than
// the live claws. Found by probing claw ids; Solana prices, fees and tiers are
// from each claw's own page, Base prices from its on-chain payments (fee and
// tiers taken from the live Base claw at the same price). Each was replaced the
// day its successor opened. Solana #11, an internal test claw, is left out.
//
// Claws that retire from now on are remembered automatically (see `catchUp`),
// so this list should not need to grow.
const SILVER_50_RANGES = { fromBase: 25, fromLow: 51, fromMedium: 101, fromHigh: 251, fromGrails: 751 };
const SILVER_100_RANGES = { fromBase: 50, fromLow: 101, fromMedium: 301, fromHigh: 601, fromGrails: 1201 };
const PLATINUM_500_RANGES = { fromBase: 250, fromLow: 501, fromMedium: 1501, fromHigh: 5001, fromGrails: 8001 };
// For old Base claws: the name and tier ranges of today's claw at each price.
const OLD_NAMES = { 30: 'Wildcard', 50: 'Silver', 250: 'Gold TCG', 500: 'Platinum' };
const WILDCARD_30_RANGES = { fromBase: 17, fromLow: 31, fromMedium: 61, fromHigh: 100, fromGrails: 200 };
const GOLD_250_RANGES = { fromBase: 140, fromLow: 251, fromMedium: 501, fromHigh: 1001, fromGrails: 3501 };
const OLD_RANGES = { 30: WILDCARD_30_RANGES, 50: SILVER_50_RANGES, 250: GOLD_250_RANGES, 500: PLATINUM_500_RANGES };

export const RETIRED_CLAWS = [
  { key: 'solana:8', id: 8, name: 'Silver TCG', label: 'Silver TCG (old)', blockchain: 'solana', priceUsd: 100, swapFeePct: 6, priceRanges: SILVER_100_RANGES },
  { key: 'solana:9', id: 9, name: 'Platinum TCG', blockchain: 'solana', priceUsd: 500, swapFeePct: 6, priceRanges: PLATINUM_500_RANGES },
  // The Solana claws Beezie replaced in the Oct 2026 migration (10->20, 13->21, 15->22, 19->23).
  { key: 'solana:10', id: 10, name: 'Wildcard', label: 'Wildcard (old)', blockchain: 'solana', priceUsd: 30, swapFeePct: 6, priceRanges: WILDCARD_30_RANGES },
  { key: 'solana:13', id: 13, name: 'Grail+ Titanium', label: 'Grail+ Titanium (old)', blockchain: 'solana', priceUsd: 100, swapFeePct: 6, priceRanges: SILVER_100_RANGES, reusable: true },
  { key: 'solana:15', id: 15, name: 'Grail+ Platinum', label: 'Grail+ Platinum (old)', blockchain: 'solana', priceUsd: 500, swapFeePct: 6, priceRanges: PLATINUM_500_RANGES, reusable: true },
  { key: 'solana:19', id: 19, name: 'Grail+ Silver', label: 'Grail+ Silver (old)', blockchain: 'solana', priceUsd: 50, swapFeePct: 6, priceRanges: SILVER_50_RANGES, reusable: true },
  { key: 'base:99', id: 99, name: 'Silver', label: 'Silver (old)', blockchain: 'base', priceUsd: 50, swapFeePct: 6, priceRanges: SILVER_50_RANGES },
  { key: 'base:101', id: 101, name: 'Platinum', blockchain: 'base', priceUsd: 500, swapFeePct: 6, priceRanges: PLATINUM_500_RANGES },
  // Base claws from January to July 2026, before any of the above. Their
  // pages carry no claw data and no play records, so each price is read from
  // what it paid back: every claw returns 97–98% of its price on average, and
  // the prices sit far apart. Named for the claw at that price today. Base
  // #75 and #88 (20 and 4 pulls) were tests and are left out.
  ...[
    [72, 30], [73, 250], [74, 50], [77, 30], [78, 50], [79, 250], [80, 50], [81, 30], [82, 50],
    [83, 250], [84, 30], [85, 50], [86, 250], [87, 500], [89, 30], [90, 50], [91, 250], [92, 500],
    [94, 30], [95, 250], [96, 500], [97, 50],
  ].map(([id, price]) => ({
    key: `base:${id}`,
    id,
    name: 'x',
    label: `${OLD_NAMES[price]} (Base #${id})`,
    blockchain: 'base',
    priceUsd: price,
    swapFeePct: 6,
    priceRanges: OLD_RANGES[price],
  })),
].map((claw) => ({ ...claw, retired: true }));

// A claw that is no longer live and has had no pulls for this long is not read
// again on every catch-up.
const DORMANT_MS = 2 * 86_400_000;

// What a claw needs to be counted, kept so it can still be after it retires.
const metaOf = (claw) => ({
  key: claw.key,
  id: claw.id,
  name: claw.name,
  label: claw.label,
  blockchain: claw.blockchain,
  priceUsd: claw.priceUsd,
  swapFeePct: claw.swapFeePct,
  priceRanges: claw.priceRanges,
  reusable: Boolean(claw.reusable),
});

// Versioned, unlike the main state key: every figure here can be rebuilt from
// Beezie's feed in one catch-up, so a change to what a day holds starts a
// fresh set of keys and backfills them rather than migrating the old ones.
// v2: each claw-day keeps its top pulls, not just the biggest.
const DAY_PREFIX = 'beezie:stats:v2:';
const MARK_KEY = 'beezie:stats:v2:mark';
// The last catch-up's start, whether it finished, and its first error, so a run
// that keeps failing can be seen from outside.
const ATTEMPT_KEY = 'beezie:stats:v2:attempt';
// The biggest pulls kept per claw per day — enough for any top-25 list.
const TOP_PER_DAY = 10;
const DAY_MS = 86_400_000;

// A short wallet id is plenty to count players apart, and keeps day keys small.
const walletId = (wallet) => String(wallet || '?').slice(0, 10);

export const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
export const dayKey = (day) => `${DAY_PREFIX}${day}`;

const emptyClaw = (claw) => ({
  name: claw.label || claw.name,
  chain: claw.blockchain,
  price: claw.priceUsd,
  grailPlus: Boolean(claw.reusable),
  slabs: 0,
  plays: 0,
  revenue: 0,
  swapPaid: 0,
  keptFmv: 0,
  fmv: 0,
  kept: 0,
  hits: { medium: 0, high: 0, grails: 0 },
  best: null, // { name, fmv, player, at }
  top: [], // the day's biggest pulls, largest first
});

/**
 * The pulls in `feed` (newest first) newer than the claw's mark, and the mark
 * moved up to the newest. `gap` is true when the page did not reach back to
 * the mark, so pulls between them are missing from it.
 */
export function newPulls(feed, mark) {
  if (!feed?.length) return { fresh: [], mark, gap: false };
  const seenAtMark = new Set(mark?.ids || []);
  const fresh = feed.filter(
    (pull) => !mark || pull.at > mark.at || (pull.at === mark.at && !seenAtMark.has(pull.tokenId))
  );
  // A mark at 0 means nothing has been counted yet — a claw first seen with an
  // empty feed — so there is no earlier point to have a gap back to.
  const gap = Boolean(mark) && mark.at > 0 && feed[feed.length - 1].at > mark.at;
  const newestAt = feed[0].at;
  const next =
    mark && mark.at > newestAt
      ? mark
      : {
          ...mark,
          at: newestAt,
          ids: feed.filter((pull) => pull.at === newestAt).map((pull) => pull.tokenId),
        };
  return { fresh, mark: next, gap };
}

// Page sizes tried in turn when reading back to a point in time. Each is one
// request; Beezie serves tens of thousands of pulls in a few seconds.
const DEEP_SIZES = [2000, 10_000, 50_000, 150_000];
// The poll reads back at most this far; anything deeper is left to catch-up.
const POLL_DEEP_MAX = 10_000;
// The first page a catch-up reads for a claw that is already counted.
const CATCH_UP_FIRST_PAGE = 200;
// How far back counting reaches: a year. Beezie's feed itself goes back to
// mid-January 2026, so today this is everything it has.
export const BACKFILL_DAYS = 365;
// A catch-up backfills claws one at a time until it has used this much of its
// run, saving each as it finishes; the next catch-up carries on. A function
// has 60 seconds, and one claw's whole history can take ten or more to read.
const BACKFILL_BUDGET_MS = 25_000;
// Reading the newest pulls of every counted claw gets this long.
const COVERED_DEADLINE_MS = 25_000;

/**
 * A claw's feed reaching back to `untilAt`, asking for bigger pages until it
 * does. `exhausted` means the page held the claw's entire history.
 */
async function readBack(claw, untilAt, maxSize, first = null, sizes = DEEP_SIZES) {
  let feed = first;
  for (const size of sizes) {
    if (size > maxSize) break;
    if (feed && (feed[feed.length - 1]?.at <= untilAt || feed.length < (feed.asked || 0))) break;
    if (feed && size <= feed.length) continue;
    const page = await reader(claw, size).catch(() => null);
    if (!page) break;
    page.asked = size;
    feed = page;
  }
  const oldest = feed?.length ? feed[feed.length - 1].at : Infinity;
  return {
    // No page could be read at all, as against a feed that is empty.
    failed: !feed,
    feed: feed || [],
    reached: oldest <= untilAt,
    exhausted: Boolean(feed) && feed.length < (feed.asked || Infinity),
  };
}

const keepTop = (pulls) => pulls.sort((a, b) => b.fmv - a.fmv).slice(0, TOP_PER_DAY);

/** Add pulls (one claw's, any days) into `days` — a map of day -> totals. */
export function addPulls(days, claw, pulls) {
  const fee = (claw.swapFeePct ?? 0) / 100;
  const plays = new Set();
  for (const pull of pulls) {
    const day = dayOf(pull.at);
    const totals = (days[day] ||= { claws: {}, players: {}, names: {}, partial: [] });
    const c = (totals.claws[claw.key] ||= emptyClaw(claw));
    const fmv = (pull.itemValue || 0) / 1e6;
    const kept = pull.status === 'claimed';
    const paid = kept ? fmv : ((pull.swapValue || 0) / 1e6) * (1 - fee);
    const tier = tierOf(fmv, claw.priceRanges);

    c.slabs += 1;
    c.revenue += claw.priceUsd || 0;
    c.fmv += fmv;
    if (kept) {
      c.kept += 1;
      c.keptFmv += fmv;
    } else {
      c.swapPaid += paid;
    }
    if (c.hits[tier] !== undefined) c.hits[tier] += 1;
    const big = { name: pull.name, fmv, player: pull.player || null, at: pull.at, tier, kept };
    if (!c.best || fmv > c.best.fmv) c.best = big;
    c.top = keepTop([...c.top, big]);

    // A play is the slabs one player won at one moment.
    const play = `${day}|${pull.wallet}|${pull.at}`;
    if (!plays.has(play)) {
      plays.add(play);
      c.plays += 1;
    }

    const id = walletId(pull.wallet);
    const player = (totals.players[id] ||= { s: 0, r: 0, p: 0 });
    player.s += 1;
    player.r += claw.priceUsd || 0;
    player.p += paid;
    if (pull.player) totals.names[id] = pull.player;
  }
}

// Counting runs one batch at a time per instance, so two overlapping polls
// can't both count the same pull.
let queue = Promise.resolve();
// A job that hangs would hold up every later one on this instance for as long as
// the instance lives, which is how counting once stopped for hours. So a job
// gets a limit, and the queue moves on whether or not it finished.
const SERIAL_LIMIT_MS = 50_000;
const serially = (work) => {
  const run = queue.then(
    () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stats job timed out')), SERIAL_LIMIT_MS);
        work().then(resolve, reject).finally(() => clearTimeout(timer));
      })
  );
  queue = run.catch(() => {});
  return run;
};

// Never more than a year and a bit of days, whatever it is asked for: a bad
// start (zero, say) must not turn into twenty thousand day keys to write.
const dayRange = (fromAt, toAt) => {
  const out = [];
  const first = Math.max(fromAt, toAt - 400 * DAY_MS);
  for (let at = Date.parse(dayOf(first)); at <= toAt; at += DAY_MS) out.push(dayOf(at));
  return out;
};

// Collects what a run adds, then writes each touched day once.
function batch() {
  return { days: {}, partial: {}, cleared: {}, added: 0 };
}

function flagDays(b, key, fromAt, toAt) {
  dayRange(fromAt, toAt).forEach((day) => (b.partial[day] ||= []).push(key));
}

async function save(b, marks, marksMoved) {
  const names = [...new Set([...Object.keys(b.days), ...Object.keys(b.partial), ...Object.keys(b.cleared)])];
  if (names.length) {
    const stored = await readMany(names.map(dayKey), null);
    await Promise.all(
      names.map((day, i) =>
        writeState(
          dayKey(day),
          mergeDay(stored[i], b.days[day] || { claws: {}, players: {}, names: {} }, b.partial[day], b.cleared[day])
        )
      )
    );
  }
  if (marksMoved || b.added) await writeState(MARK_KEY, marks);
}

/**
 * The poll's part: count what its feeds (claw key -> feed, newest first) hold
 * that is new. A claw not yet backfilled is left for `catchUp`.
 */
// The poll saves at most this often. Skipping costs nothing: the mark only
// moves when a save lands, so the next one reads back to it and counts what
// was skipped. This keeps a busy afternoon to a few hundred small writes
// rather than one every ten seconds.
const SAVE_EVERY_MS = 3 * 60_000;
let lastSave = 0;

export function recordStats(claws, feeds, { now = Date.now(), every = SAVE_EVERY_MS } = {}) {
  if (!feeds.size || now - lastSave < every) return Promise.resolve({ added: 0, untracked: [] });
  lastSave = now;
  return serially(async () => {
    const byKey = new Map(claws.map((claw) => [claw.key, claw]));
    const marks = (await readStateStrict(MARK_KEY, null)) || {};
    const b = batch();
    let moved = false;

    // Claws with pulls but no mark yet: the poll can't count them, and says so,
    // so the caller can have a catch-up backfill them.
    const untracked = [];
    for (const [key, feed] of feeds) {
      const claw = byKey.get(key);
      const mark = marks[key];
      if (claw && !mark && feed.length) untracked.push(key);
      if (!claw || !mark) continue;
      const result = await forward(claw, mark, feed, POLL_DEEP_MAX, b);
      if (result.at !== mark.at || result.ids.length !== mark.ids.length) moved = true;
      marks[key] = result;
    }

    await save(b, marks, moved);
    return { added: b.added, untracked };
  });
}

// Count a claw's pulls newer than its mark, reading further back if `feed`
// doesn't reach it. Returns the new mark.
async function forward(claw, mark, feed, maxSize, b) {
  let result = newPulls(feed, mark);
  if (result.gap) {
    const deep = await readBack(claw, mark.at, maxSize, feed);
    result = newPulls(deep.feed, mark);
    // Still short: whatever happened between the mark and this page is lost.
    if (result.gap && result.fresh.length) {
      flagDays(b, claw.key, mark.at, result.fresh[result.fresh.length - 1].at);
    }
  }
  if (result.fresh.length) {
    addPulls(b.days, claw, result.fresh);
    b.added += result.fresh.length;
  }
  return result.mark;
}

// Read a claw back to the cutoff and count everything outside what is already
// counted: older than its `from`, or newer than its mark. A claw never counted
// is read in one page as big as the feed serves; one partly counted reads
// back in growing pages from where it was.
async function backfillClaw(claw, marks, cutoff, b) {
  const key = claw.key;
  const mark = marks[key];
  const max = DEEP_SIZES[DEEP_SIZES.length - 1];
  const { feed, exhausted, failed } = await readBack(claw, cutoff, max, null, mark ? DEEP_SIZES : [max]);
  // A read that failed is tried again next time.
  if (failed) return;
  if (!feed.length) {
    // An empty feed: counted, as far as there is anything to count.
    marks[key] = { ...(mark || { at: 0, ids: [] }), from: cutoff, complete: true };
    return;
  }
  const older = feed.filter((pull) => pull.at >= cutoff && (!mark || pull.at < mark.from));
  const { fresh, mark: next } = mark ? newPulls(feed, mark) : { fresh: [], mark: null };
  const add = [...fresh, ...older];
  if (add.length) {
    addPulls(b.days, claw, add);
    b.added += add.length;
  }

  const oldest = feed[feed.length - 1].at;
  const complete = exhausted && oldest >= cutoff;
  const from = complete ? oldest : cutoff;
  // The cutoff is a UTC midnight, so every day from it on is now counted in
  // full: any partial flag on them goes.
  if (mark) dayRange(from, mark.from).forEach((day) => (b.cleared[day] ||= []).push(key));

  const newestAt = feed[0].at;
  marks[key] = {
    ...(next || {
      at: newestAt,
      ids: feed.filter((pull) => pull.at === newestAt).map((pull) => pull.tokenId),
    }),
    from,
    complete,
  };
}

/**
 * Bring every claw up to date, backfilling the last BACKFILL_DAYS for any not
 * yet counted that far back. Used by /api/stats and the daily cron.
 */
export function catchUp(claws, now = Date.now()) {
  const cutoff = Date.parse(dayOf(now - (BACKFILL_DAYS - 1) * DAY_MS));

  return serially(async () => {
    const marks = (await readStateStrict(MARK_KEY, null)) || {};
    const b = batch();

    // Every claw ever seen: the known retired ones, every claw remembered from
    // earlier catch-ups, and today's live list. A claw that drops off the live
    // list stays in here, and keeps being counted.
    // A paused claw — still on Beezie's list, not being played — is treated
    // like a retired one: counted, kept, and left alone once it goes quiet.
    const listed = claws.filter((claw) => FEED_CHAINS.includes(claw.blockchain));
    const live = listed.filter((claw) => !claw.isPaused);
    const listedKeys = new Set(listed.map((claw) => claw.key));
    const liveKeys = new Set(live.map((claw) => claw.key));
    const registry = Object.fromEntries(RETIRED_CLAWS.map((claw) => [claw.key, claw]));
    Object.assign(registry, marks.claws || {});
    listed.forEach((claw) => (registry[claw.key] = metaOf(claw)));
    Object.values(registry).forEach((claw) => {
      claw.paused = listedKeys.has(claw.key) && !liveKeys.has(claw.key);
      claw.retired = !listedKeys.has(claw.key);
    });

    const targets = Object.values(registry).filter((claw) => {
      if (!FEED_CHAINS.includes(claw.blockchain)) return false;
      const mark = marks[claw.key];
      const counted = mark && (mark.complete || mark.from <= cutoff);
      // A retired claw, fully counted and quiet for days, has nothing to add.
      return liveKeys.has(claw.key) || !counted || now - mark.at < DORMANT_MS;
    });

    const isCovered = (claw) => {
      const mark = marks[claw.key];
      return Boolean(mark && (mark.complete || mark.from <= cutoff));
    };

    // One claw failing never costs the rest: its error is noted and the run
    // carries on. A run cut off by the platform leaves `done: false` behind.
    const errors = [];
    const attempt = { at: now, done: false, error: null };
    await writeState(ATTEMPT_KEY, attempt);
    const guarded = async (claw, work) => {
      try {
        await work();
      } catch (error) {
        errors.push(`${claw.key}: ${error.message}`);
      }
    };

    // Claws already counted: just their newest pulls, all at once. The phase
    // has a deadline: a feed that hangs must not use up the run, because a run
    // the platform cuts off saves nothing at all. What was still running when
    // time ran out is named in the attempt record, and what it was doing is
    // dropped (`closed`), so the next run counts those pulls again.
    const running = new Set();
    let closed = false;
    const covered = Promise.all(
      targets.filter(isCovered).map((claw) =>
        guarded(claw, async () => {
          running.add(claw.key);
          // Start small: a claw counted minutes ago needs only its newest
          // pulls, and `forward` asks for more when this doesn't reach.
          const feed = await reader(claw, CATCH_UP_FIRST_PAGE).catch(() => null);
          if (feed) {
            const next = await forward(claw, marks[claw.key], feed, DEEP_SIZES[DEEP_SIZES.length - 1], b);
            if (!closed) marks[claw.key] = next;
          }
          running.delete(claw.key);
        })
      )
    );
    let timer;
    await Promise.race([
      covered,
      new Promise((resolve) => {
        timer = setTimeout(resolve, COVERED_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    closed = true;
    if (running.size) errors.push(`still reading after ${COVERED_DEADLINE_MS / 1000}s: ${[...running].join(', ')}`);

    // Claws still to backfill: one at a time, oldest-first, each saved as it
    // finishes, until this run's budget is spent. The rest wait for the next.
    const pending = targets.filter((claw) => !isCovered(claw)).sort((a, x) => (a.id || 0) - (x.id || 0));
    const started = Date.now();
    let done = 0;
    for (const claw of pending) {
      if (done > 0 && Date.now() - started > BACKFILL_BUDGET_MS) break;
      await guarded(claw, () => backfillClaw(claw, marks, cutoff, b));
      done += 1;
      // Saved now, so a run cut short keeps what it finished.
      marks.claws = registry;
      await save(b, marks, true);
      Object.assign(b, batch());
    }
    // Still to do: any not yet counted back to the cutoff, a failed read included.
    marks.pending = targets.filter((claw) => !isCovered(claw)).length;

    marks.claws = registry;
    marks.caughtUpAt = now;
    await save(b, marks, true);
    await writeState(ATTEMPT_KEY, { at: now, done: true, ms: Date.now() - started, error: errors[0] || null });
    return { added: b.added, pending: marks.pending, errors };
  });
}

/** Fold one batch of a day's totals into what is stored for it. */
export function mergeDay(stored, batch, partialKeys = [], clearedKeys = []) {
  const day = stored || { claws: {}, players: {}, names: {}, partial: [] };
  for (const [key, add] of Object.entries(batch.claws)) {
    const c = day.claws[key];
    if (!c) {
      day.claws[key] = add;
      continue;
    }
    for (const field of ['slabs', 'plays', 'revenue', 'swapPaid', 'keptFmv', 'fmv', 'kept']) c[field] += add[field];
    for (const tier of Object.keys(c.hits)) c.hits[tier] += add.hits[tier] || 0;
    if (add.best && (!c.best || add.best.fmv > c.best.fmv)) c.best = add.best;
    c.top = keepTop([...(c.top || []), ...(add.top || [])]);
    Object.assign(c, { name: add.name, price: add.price, grailPlus: add.grailPlus });
  }
  for (const [id, add] of Object.entries(batch.players)) {
    const p = (day.players[id] ||= { s: 0, r: 0, p: 0 });
    p.s += add.s;
    p.r += add.r;
    p.p += add.p;
  }
  Object.assign(day.names, batch.names);
  const cleared = new Set(clearedKeys);
  day.partial = [...new Set([...(day.partial || []).filter((key) => !cleared.has(key)), ...partialKeys])];
  return day;
}

/** The stored days from `from` to `to` (ms), oldest first; missing days skipped. */
export async function readDays(from, to) {
  const names = [];
  for (let at = Date.parse(dayOf(from)); at <= to; at += DAY_MS) names.push(dayOf(at));
  const stored = await readMany(names.map(dayKey), null);
  return names.map((day, i) => (stored[i] ? { day, ...stored[i] } : null)).filter(Boolean);
}

export const readMarks = () => readStateStrict(MARK_KEY, null);
export const readAttempt = () => readState(ATTEMPT_KEY, null);

/**
 * The Data tab's figures over a run of stored days: totals, daily revenue by
 * chain, per-claw totals, top players by spend and by pulls, and the biggest
 * pulls. Done here so the page gets a few kilobytes instead of every day's
 * per-wallet records.
 */
export function summariseDays(stats, retired = [], paused = []) {
  const retiredKeys = new Set(retired);
  const pausedKeys = new Set(paused);
  const totals = { revenue: 0, swapPaid: 0, keptFmv: 0, slabs: 0, plays: 0, kept: 0, fmv: 0 };
  const hits = { grails: 0, high: 0, medium: 0 };
  const claws = {};
  const players = {};
  const names = {};
  const daily = [];
  const best = [];

  for (const day of stats) {
    const row = { day: day.day, partial: (day.partial || []).length > 0, byChain: {}, revenue: 0, paid: 0, pulls: 0, pullsByChain: {} };
    for (const [key, c] of Object.entries(day.claws || {})) {
      const paid = c.swapPaid + c.keptFmv;
      for (const field of Object.keys(totals)) totals[field] += c[field] || 0;
      for (const tier of Object.keys(hits)) hits[tier] += c.hits?.[tier] || 0;
      row.revenue += c.revenue;
      row.paid += paid;
      row.byChain[c.chain] = (row.byChain[c.chain] || 0) + c.revenue;
      row.pulls += c.slabs;
      row.pullsByChain[c.chain] = (row.pullsByChain[c.chain] || 0) + c.slabs;

      const t = (claws[key] ||= { key, name: c.name, chain: c.chain, grailPlus: c.grailPlus, retired: retiredKeys.has(key), paused: pausedKeys.has(key), price: c.price, revenue: 0, paid: 0, slabs: 0, plays: 0, kept: 0, hits: { grails: 0, high: 0, medium: 0 }, best: null });
      t.revenue += c.revenue;
      t.paid += paid;
      t.slabs += c.slabs;
      t.plays += c.plays;
      t.kept += c.kept;
      for (const tier of Object.keys(t.hits)) t.hits[tier] += c.hits?.[tier] || 0;
      if (c.best && (!t.best || c.best.fmv > t.best.fmv)) t.best = c.best;
      // Each claw-day keeps its top pulls; older days stored only the best.
      for (const big of c.top || (c.best ? [c.best] : [])) best.push({ ...big, claw: c.name, chain: c.chain });
    }
    for (const [id, p] of Object.entries(day.players || {})) {
      const t = (players[id] ||= { id, s: 0, r: 0, p: 0 });
      t.s += p.s;
      t.r += p.r;
      t.p += p.p;
    }
    Object.assign(names, day.names || {});
    daily.push(row);
  }

  const paid = totals.swapPaid + totals.keptFmv;
  // One person often plays from a Base wallet and a Solana wallet; with a
  // username to go on, they are one player.
  const byPerson = {};
  for (const p of Object.values(players)) {
    const name = names[p.id] || null;
    const t = (byPerson[name || p.id] ||= { id: name || p.id, name, s: 0, r: 0, p: 0 });
    t.s += p.s;
    t.r += p.r;
    t.p += p.p;
  }
  const playerList = Object.values(byPerson);
  // A claw Beezie has replaced keeps its name, so it is told apart from its
  // successor.
  Object.values(claws).forEach((t) => {
    if (t.retired && !/\(.*\)/.test(t.name)) t.name = `${t.name} (old)`;
  });
  return {
    ...totals,
    paid,
    take: totals.revenue - paid,
    margin: totals.revenue ? (totals.revenue - paid) / totals.revenue : NaN,
    hits,
    players: playerList.length,
    arpu: playerList.length ? totals.revenue / playerList.length : NaN,
    daily,
    // Live claws first, then paused and retired ones; each by revenue.
    claws: Object.values(claws).sort(
      (a, b) => Number(a.retired || a.paused) - Number(b.retired || b.paused) || b.revenue - a.revenue
    ),
    topPlayers: [...playerList].sort((a, b) => b.r - a.r).slice(0, 25),
    topPullers: [...playerList].sort((a, b) => b.s - a.s).slice(0, 25),
    biggest: best.sort((a, b) => b.fmv - a.fmv).slice(0, 25),
  };
}
