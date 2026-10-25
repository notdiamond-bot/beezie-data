// Beezie's own pull feed, per claw.
//
// Each claw page on Beezie lists its recent pulls — every slab, every tier,
// with the player's username, whether they swapped or kept it, both values,
// and the exact time. The page gets that list from a Next.js server action,
// `getClawPulls({ pageSize, clawId })`, and so can we:
//
//   POST <any page on the site>
//   Next-Action: <the action's id>
//   body: [{ "pageSize": 100, "clawId": 10 }]
//
// One request returns a few hundred pulls in well under a second. That is the
// whole feed, named, without inferring anything from stock or reading a chain.
//
// Two things to know:
//
//   The id is a build hash. It changes when Beezie redeploys their site, so it
//   is found by reading the claw page's own scripts, kept in KV so every
//   instance shares it, and found again when a call stops working.
//
//   Browsers cannot call it. Next.js refuses server actions from other sites,
//   so this runs only on our side — the poll, and /api/pulls.
//
// If the action cannot be found or called, the caller falls back to how pulls
// were detected before. Nothing depends on this existing.

import { CHAINS, getClawUrl } from '../src/chains.js';
import { readState, writeState } from './_store.js';

const ACTIONS_KEY = 'beezie:actions';

// Only the chains whose sites have the action. Flow's claw has been offline.
export const FEED_CHAINS = ['solana', 'base'];

const TIMEOUT_MS = 8000;

// After a failed search, how long before searching again. A search fetches the
// page and up to ~65 scripts, which is fine once after a Beezie deploy and not
// fine on every poll while their site is down.
const SEARCH_COOLDOWN_MS = 10 * 60_000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const ACTION_REF = /createServerReference\)\("([0-9a-f]{40,})"[^)]*"getClawPulls"\)/;

const actions = new Map(); // chain -> action id
const lastSearch = new Map(); // chain -> when a search last failed
let loaded = false;

export const __testing = { actions, lastSearch, reset: () => { actions.clear(); lastSearch.clear(); loaded = false; } };

const timeout = (ms = TIMEOUT_MS) => (AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});

// A deep page — the Data tab's backfill asks for tens of thousands of pulls —
// takes longer to serve. Without the extra time it would time out, and a failed
// call is read as Beezie having moved the action, which costs a full search.
const timeoutFor = (pageSize) => Math.min(50_000, Math.round(TIMEOUT_MS + pageSize * 0.4));

async function loadActions() {
  if (loaded) return;
  loaded = true;
  const stored = (await readState(ACTIONS_KEY, null)) || {};
  Object.entries(stored).forEach(([chain, id]) => actions.set(chain, id));
}

async function saveActions() {
  await writeState(ACTIONS_KEY, Object.fromEntries(actions));
}

// Read the claw page's scripts until one names the action.
async function search(chain, pageUrl) {
  if (Date.now() - (lastSearch.get(chain) || 0) < SEARCH_COOLDOWN_MS) return null;
  const site = new URL(pageUrl).origin;
  try {
    const html = await (await fetch(pageUrl, { headers: HEADERS, ...timeout() })).text();
    const scripts = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)].map((m) => m[0]))];
    for (let i = 0; i < scripts.length; i += 10) {
      const texts = await Promise.all(
        scripts.slice(i, i + 10).map((path) =>
          fetch(site + path, { headers: HEADERS, ...timeout() })
            .then((r) => (r.ok ? r.text() : ''))
            .catch(() => '')
        )
      );
      for (const text of texts) {
        const found = text.match(ACTION_REF);
        if (found) {
          actions.set(chain, found[1]);
          lastSearch.delete(chain);
          await saveActions();
          return found[1];
        }
      }
    }
  } catch {
    // Fall through: recorded as a failed search below.
  }
  lastSearch.set(chain, Date.now());
  return null;
}

// The action answers in React's streaming format: line `0:` describes the
// result and points at the line holding it (`"a":"$@1"` means line `1:`).
export function parseActionResponse(text) {
  const lines = String(text || '').split('\n');
  const head = lines.find((line) => line.startsWith('0:'));
  if (!head) return null;
  let ref;
  try {
    ref = JSON.parse(head.slice(2))?.a;
  } catch {
    return null;
  }
  const id = typeof ref === 'string' && ref.startsWith('$@') ? ref.slice(2) : '1';
  const body = lines.find((line) => line.startsWith(`${id}:`));
  if (!body) return null;
  try {
    const value = JSON.parse(body.slice(id.length + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function call(id, pageUrl, clawId, pageSize) {
  const response = await fetch(pageUrl, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Next-Action': id,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    body: JSON.stringify([{ pageSize, clawId }]),
    ...timeout(timeoutFor(pageSize)),
  });
  if (!response.ok) return null;
  return parseActionResponse(await response.text());
}

// One pull, in our own terms. Values are micro-units, as everywhere in Beezie.
export function normalisePull(raw, blockchain) {
  const at = Date.parse(raw.createdAt);
  if (!raw?.tokenId || !Number.isFinite(at)) return null;
  return {
    tokenId: String(raw.tokenId),
    name: raw.name || null,
    image: raw.imageUrl || null,
    at,
    wallet: raw.from || null,
    player: raw.fromUsername || null,
    // 'swapped', or 'claimed' when the player kept the slab.
    status: raw.status || null,
    kept: raw.status === 'claimed',
    swapValue: Number(raw.swapValue) || 0,
    itemValue: Number(raw.itemValue) || 0,
    blockchain,
  };
}

/**
 * The most recent pulls on one claw, newest first, or null if the feed could
 * not be read. `claw` needs { id, name, blockchain }.
 */
export async function fetchClawPulls(claw, pageSize = 100) {
  const { id: clawId, name, blockchain } = claw || {};
  if (!FEED_CHAINS.includes(blockchain) || !CHAINS[blockchain] || clawId == null) return null;

  await loadActions();
  const pageUrl = getClawUrl(clawId, name, blockchain);

  let id = actions.get(blockchain) || (await search(blockchain, pageUrl));
  if (!id) return null;

  let items = await call(id, pageUrl, clawId, pageSize).catch(() => null);
  if (!items) {
    // Most likely Beezie redeployed and the id moved. Find it again, once.
    actions.delete(blockchain);
    id = await search(blockchain, pageUrl);
    if (!id) return null;
    items = await call(id, pageUrl, clawId, pageSize).catch(() => null);
    if (!items) return null;
  }

  return items
    .map((raw) => normalisePull(raw, blockchain))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

// ---- recent pulls, kept warm between requests ------------------------------
//
// Viewers refresh a claw's feed every time a pull lands, and nearly all of
// what comes back they already had. While this instance stays warm it keeps
// the last read and asks Beezie only for the newest TOP_UP pulls, stitching
// them on — a few kilobytes from Beezie and a fraction of the parsing, instead
// of the whole page. A full read every FULL_EVERY_MS picks up changes to older
// rows (a kept slab swapped later), and any top-up that doesn't reach back to
// what is held falls back to a full read.

const TOP_UP = 60;
const FULL_EVERY_MS = 5 * 60_000;
const warm = new Map(); // `${chain}:${id}` -> { pulls, size, fullAt }

/** Stitch a fresh top page (newest first) onto what is held. */
export function stitch(top, held) {
  if (!top.length) return held;
  const oldest = top[top.length - 1].at;
  const inTop = new Set(top.map((pull) => `${pull.tokenId}:${pull.at}`));
  // The top page replaces everything back to its oldest moment; slabs held at
  // exactly that moment but cut off the page are kept.
  const older = held.filter(
    (pull) => pull.at < oldest || (pull.at === oldest && !inTop.has(`${pull.tokenId}:${pull.at}`))
  );
  return [...top, ...older];
}

// A paused claw's feed only changes if it reopens, so what is held is served
// as it stands for this long before Beezie is asked again.
const PAUSED_HOLD_MS = 10 * 60_000;

/**
 * `fetchClawPulls`, served from what this instance already holds when it can.
 * `paused` claws are served from the held copy without asking Beezie at all.
 */
export async function recentClawPulls(claw, size, now = Date.now(), { paused = false } = {}) {
  const key = `${claw.blockchain}:${claw.id}`;
  const held = warm.get(key);

  if (paused && held && held.size >= size && now - held.fullAt < PAUSED_HOLD_MS) {
    return held.pulls.slice(0, size);
  }

  if (held && held.size >= size && now - held.fullAt < FULL_EVERY_MS) {
    const top = await fetchClawPulls(claw, TOP_UP);
    const reaches = top && (top.length < TOP_UP || !held.pulls.length || top[top.length - 1].at <= held.pulls[0].at);
    if (top && reaches) {
      held.pulls = stitch(top, held.pulls).slice(0, held.size);
      return held.pulls.slice(0, size);
    }
  }

  const pulls = await fetchClawPulls(claw, size);
  if (pulls) warm.set(key, { pulls, size, fullAt: now });
  return pulls;
}

