// Which play each payment bought: the same wallet and claw, the same number of slabs
// (a payment is a whole number of claw prices), the slabs out a few seconds later.
// Closest pairs first. Taken in order of time instead, a payment whose own play is
// not in the feed takes the next one, and everything after it slides by one.

// The feed dates a play up to a minute or so after its payment, usually 3 to 6s.
export const MATCH_BEFORE_S = 120;
export const MATCH_AFTER_S = 3;

/** How many slabs a payment is for, or null where it isn't a whole number of prices. */
export function slabsPaid(list, price) {
  if (!(list > 0) || !(price > 0)) return null;
  const n = Math.round(list / price);
  return n > 0 && Math.abs(list - n * price) < 0.02 ? n : null;
}

/** pays: [{ wallet, t (s), list }], plays: [{ wallet, at (ms), n }], one claw's. A Map. */
export function pairPays(pays, plays, price) {
  const pairs = [];
  for (const pay of pays) {
    const n = slabsPaid(pay.list, price);
    for (const play of plays) {
      if (play.wallet !== pay.wallet || (n && play.n !== n)) continue;
      const gap = play.at / 1000 - pay.t;
      if (gap >= -MATCH_AFTER_S && gap <= MATCH_BEFORE_S) pairs.push({ pay, play, gap: Math.abs(gap) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);
  const out = new Map();
  const taken = new Set();
  for (const { pay, play } of pairs) {
    if (out.has(pay) || taken.has(play)) continue;
    out.set(pay, play);
    taken.add(play);
  }
  return out;
}

/** The figures kept for a play: [paid, list, slabs, credits?]. */
export const entryFor = (pay, n) => [
  Math.round(pay.paid * 100) / 100,
  Math.round(pay.list * 100) / 100,
  n,
  ...(pay.credits ? [pay.credits] : []),
];
