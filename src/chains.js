// Central Beezie API access layer, shared by the browser bundle and the
// serverless cache in api/. Keep it free of environment-specific globals.
//
// Two endpoints do all the work:
//   1. `GET /claw` returns EVERY claw on a chain in a single response, with the
//      same payload shape as `/claw/by-id/{id}`. One request per chain replaces
//      one request per claw.
//   2. `GET /dropItems/byTokenIds?tokenIds=a&tokenIds=b&...` returns metadata for
//      a whole batch of tokens at once, replacing one request per token.

export const CHAINS = {
  base: {
    key: 'base',
    label: 'Base',
    api: 'https://api.beezie.com',
    site: 'https://beezie.com',
  },
  solana: {
    key: 'solana',
    label: 'Solana',
    api: 'https://solana-api.beezie.com',
    // Beezie moved everything onto beezie.com in the Oct 2026 migration; the
    // solana.beezie.com site no longer exists.
    site: 'https://beezie.com',
  },
  flow: {
    key: 'flow',
    label: 'Flow',
    api: 'https://flow-api.beezie.com',
    site: 'https://flow.beezie.com',
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);

// Display order on the dashboard.
const CHAIN_ORDER = { base: 0, solana: 1, flow: 2 };

export const chainLabel = (key) => CHAINS[key]?.label || 'Base';
export const chainRank = (key) => CHAIN_ORDER[key] ?? 99;

// The API returns USDC-style micro-units for every money field.
const MICRO = 1_000_000;

export const getTokenPageUrl = (tokenId, blockchain) =>
  `${CHAINS[blockchain]?.site || CHAINS.base.site}/marketplace/collectible/${tokenId}`;

export const getClawUrl = (clawId, clawName, blockchain) => {
  // Beezie slugs: strip accents/punctuation, then join words.
  // "Sport.Fun Multi-Category" -> SportFun-MultiCategory-72, "TCG Silver" -> TCG-Silver-74
  const parts = String(clawName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.-]/g, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let urlName;
  if (parts.length <= 1) urlName = parts[0] || '';
  else if (parts.length === 2) urlName = parts.join('-');
  else urlName = parts[0] + '-' + parts.slice(1).join('');

  const site = CHAINS[blockchain]?.site || CHAINS.base.site;
  return `${site}/claw/${urlName}-${clawId}`;
};

/** Which tier a slab falls in, from its FMV and the claw's price bands. */
export function tierOf(fmv, priceRanges) {
  if (!priceRanges || !Number.isFinite(fmv)) return null;
  for (const tier of ['grails', 'high', 'medium', 'low', 'base']) {
    const from = tier === 'base' ? priceRanges.fromBase : priceRanges[`from${tier[0].toUpperCase()}${tier.slice(1)}`];
    if (from !== undefined && fmv >= from) return tier;
  }
  return 'base';
}

// Turn a raw claw payload into the shape the dashboard renders.
export function normalizeClaw(raw, blockchain) {
  // The claw's swap fees come off the top before you're paid, so the number that
  // actually lands in your wallet is `swapValue` net of them. Beezie's own pull
  // screen shows this figure, not the raw swapValue.
  //   itemValue  = fair market value
  //   swapValue  = itemValue x swapRate          (pre-fee)
  //   payout     = swapValue x (1 - swapFees)    (what you receive)
  const feePct = (raw.swapFees?.percentages || []).reduce((sum, pct) => sum + pct, 0);
  const netOfFees = 1 - feePct / 100;

  // Base returns numeric token ids and Solana returns base58 strings. Anywhere
  // an id becomes an object key it comes back as a string, so normalize once
  // here — otherwise 14673 and "14673" are treated as two different slabs.
  // Values are converted to dollars here so nothing downstream has to.
  const grails = {};
  ['grails', 'high', 'medium'].forEach((tier) => {
    if (raw.grails?.[tier]) {
      grails[tier] = raw.grails[tier].map((item) => ({
        tokenId: String(item.tokenId),
        fmv: (item.itemValue || 0) / MICRO,
        payout: ((item.swapValue || 0) / MICRO) * netOfFees,
      }));
    }
  });
  const highHits = grails.high?.length || 0;
  const mediumHits = grails.medium?.length || 0;
  const grailHits = grails.grails?.length || 0;
  const totalHits = highHits + mediumHits + grailHits;

  const topHitValue = Math.max(
    0,
    ...(grails.grails?.length ? grails.grails.map((g) => g.payout) : []),
    ...(grails.grails?.length ? [] : (grails.high || []).map((g) => g.payout)),
  );

  const sumPayout = (tier) => (grails[tier] || []).reduce((sum, item) => sum + item.payout, 0);
  const totalHitsValue = sumPayout('high') + sumPayout('medium') + sumPayout('grails');

  const priceUsd = raw.priceUsdc ? raw.priceUsdc / MICRO : 0;

  // The API used to expose `totalSwapValue` for the whole machine; it no longer
  // does. `averageValue` is the average item FMV, so the expected amount you
  // actually receive is that times the swap rate, net of fees.
  // Beezie publishes `swapRate` as a percentage and `averageValue` in whole
  // dollars, not micro-units — a $100 claw reports an averageValue of 105.
  //
  // `swapRate` comes over the wire as a STRING ("95.74"), so it must be parsed,
  // not type-checked. A `typeof === 'number'` guard here silently sent every
  // claw down the 0.9 fallback and understated EV across the board.
  const parsedSwapRate = parseFloat(raw.swapRate);
  const swapRatePct = Number.isFinite(parsedSwapRate) ? parsedSwapRate : null;
  const swapRate = swapRatePct !== null ? swapRatePct / 100 : 0.9;

  // `swapRate` is a PRE-FEE rate, grossed up so that taking the swap fee back
  // off lands on the round number Beezie advertises on the claw page:
  //   95.74 x 0.94 = 90.00%  ("90% SWAP")
  //   90.43 x 0.94 = 85.00%  ("85% SWAP")
  // The net figure is the one worth showing — it is both what Beezie quotes and
  // what actually reaches your wallet.
  const swapRateNetPct = swapRatePct !== null ? swapRatePct * netOfFees : null;

  const averageValue = raw.averageValue || 0;
  const actualEV = averageValue * swapRate * netOfFees;

  // A "hit" is medium + high + grail. The API publishes those odds per claw and
  // keeps them current as stock is pulled, so prefer them over inferring the
  // ratio from the remaining grail list.
  const oddsPct = (tier) => parseFloat(raw.odds?.[tier]) || 0;
  const publishedHitOdds = oddsPct('medium') + oddsPct('high') + oddsPct('grails');
  const hitWinProbability = publishedHitOdds > 0
    ? publishedHitOdds
    : (raw.clawStockCount > 0 ? (totalHits / raw.clawStockCount) * 100 : 0);

  return {
    id: raw.id,
    key: `${blockchain}:${raw.id}`,
    name: raw.name,
    blockchain,
    status: raw.status,
    isPaused: raw.status !== 'active',
    clawStockCount: raw.clawStockCount,
    // Beezie's own wallets for this machine. A slab that was swapped rather than
    // kept comes back to one of these, which is how a pull can be told apart
    // from a keep without asking anyone.
    contractAddress: raw.contractAddress || null,
    managerWallet: raw.managerWalletAddress || null,
    // A reusable machine takes swapped slabs back in, so its stock can rise
    // without a restock. Base Silver is the first; most claws never do this.
    reusable: Boolean(raw.reusable),
    // The FMV band each tier covers, in whole dollars, and the fee taken off a
    // swap. Together they let any slab be tiered and priced from its play
    // record — including base and low, which the claw payload never lists.
    priceRanges: raw.priceRanges || null,
    swapFeePct: feePct,
    // Beezie's own two inputs to the EV figure, so the number on the card can be
    // checked rather than taken on faith. Both rates are kept: the gross one is
    // what the API sends, the net one is what Beezie shows and what you get.
    swapRatePct,
    swapRateNetPct,
    averageValue,
    actualEV,
    priceUsd,
    isPositiveEV: actualEV >= priceUsd,
    topHit: topHitValue,
    hitsRemaining: totalHits,
    hitsValue: totalHitsValue,
    hitWinProbability,
    odds: raw.odds || null,
    // Beezie's own signal that a refill is underway — authoritative when set.
    restockStartedAt: raw.restockStartedAt || null,
    grailsRaw: Object.keys(grails).length > 0 ? grails : null,
    isRestocking: Boolean(raw.restockStartedAt),
  };
}

// A healthy chain answers in about two seconds. Beezie's Base API has sat at a
// 15-25s timeout during an outage, and because every chain is awaited together,
// one dead chain held the whole dashboard at the loading screen for as long as
// it took to give up. Capping the wait lets a dead chain fail fast and the live
// ones render on time.
// Every chain gets the full budget on every poll, because the point is live
// figures for every machine. A healthy chain answers in under two seconds and
// costs nothing extra; the headroom is for one that is up but labouring —
// Beezie's Base API has been measured at 35-45s while still returning 200. A
// chain that is genuinely dead is caught by the cooldown in api/claws.js, so
// this budget is not paid for it on every poll.
export const CHAIN_TIMEOUT_MS = 55000;

function requestInit(headers, ms = CHAIN_TIMEOUT_MS) {
  const init = headers ? { headers } : {};
  // Node 17.3+ and every current browser; skipped rather than crashing elsewhere.
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(ms);
  }
  return init;
}

// One request per chain for every claw on it, as Beezie sends them. Exported
// for the Base reader in api/, which patches stock and contents from the chain
// before normalising — so it needs the payload rather than the finished claw.
//
// Paused machines are kept: they still have history worth looking at, and
// hiding them made a claw vanish from the grid mid-restock. `status` travels
// with each claw so the UI can mark them and the cache can freeze their state.
export async function fetchRawClaws(blockchain, headers, timeoutMs = CHAIN_TIMEOUT_MS) {
  const chain = CHAINS[blockchain];
  if (!chain) return [];

  const response = await fetch(`${chain.api}/claw`, requestInit(headers, timeoutMs));
  if (!response.ok) throw new Error(`${chain.label} claw list failed (${response.status})`);

  const data = await response.json();
  return (data.claws || []).filter((raw) => raw.isVisible !== false);
}

async function fetchChainClaws(blockchain, headers, timeoutMs) {
  const raws = await fetchRawClaws(blockchain, headers, timeoutMs);
  return raws.map((raw) => normalizeClaw(raw, blockchain));
}

// Fetches every claw across every chain. Chains that fail are skipped rather
// than taking the whole dashboard down (Flow in particular goes offline).
// `skip` names chains already known to be down. They are not contacted at all,
// which is the difference between a healthy chain rendering in two seconds and
// waiting out a dead one's timeout first. They still come back in `failed`, so
// the UI can name them either way.
// `timeouts` gives a per-chain budget; anything unnamed gets the fast one.
export async function fetchAllClaws({
  chainKeys = CHAIN_KEYS,
  headers,
  skip = [],
  timeouts = {},
} = {}) {
  const tried = chainKeys.filter((key) => !skip.includes(key));
  const results = await Promise.allSettled(
    tried.map((key) => fetchChainClaws(key, headers, timeouts[key] ?? CHAIN_TIMEOUT_MS))
  );

  const claws = [];
  const failedKeys = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') claws.push(...result.value);
    else failedKeys.push(tried[i]);
  });

  const skipped = skip.filter((key) => CHAINS[key]);
  const downKeys = [...failedKeys, ...skipped];

  return {
    claws,
    failed: downKeys.map((key) => CHAINS[key].label),
    // By key, for callers tracking which chains to stop contacting.
    failedKeys,
    triedKeys: tried,
    skippedKeys: skipped,
  };
}

// Beezie accepts repeated `tokenIds` query params. Chunked to keep URLs sane.
const TOKEN_BATCH_SIZE = 40;

export async function fetchTokenMetadata(tokenIds, blockchain, headers) {
  const chain = CHAINS[blockchain] || CHAINS.base;
  const byTokenId = {};

  for (let i = 0; i < tokenIds.length; i += TOKEN_BATCH_SIZE) {
    const batch = tokenIds.slice(i, i + TOKEN_BATCH_SIZE);
    const query = batch.map((id) => `tokenIds=${encodeURIComponent(id)}`).join('&');

    try {
      const response = await fetch(
        `${chain.api}/dropItems/byTokenIds?${query}`,
        requestInit(headers)
      );
      if (!response.ok) continue;

      const items = await response.json();
      (Array.isArray(items) ? items : []).forEach((item) => {
        byTokenId[item.tokenId] = {
          tokenId: item.tokenId,
          name: item.metadata?.name || `Token #${item.tokenId}`,
          image: item.metadata?.image || '',
          url: getTokenPageUrl(item.tokenId, blockchain),
        };
      });
    } catch {
      // Leave this batch out; callers fall back to a placeholder name.
    }
  }

  return byTokenId;
}

// ---------------------------------------------------------------------------
// Dashboard data
// ---------------------------------------------------------------------------

// Preferred path: the shared cache in api/claws.js. It polls Beezie once for
// everyone, so viewer count no longer multiplies traffic, and it carries the
// play/pull history that a single browser can't know about.
//
// Falls back to talking to Beezie directly when that endpoint isn't there —
// `npm run dev` without `vercel dev`, or a static host with no functions.
// `bucket`, when given, is a live event's five-second window: viewers who heard
// the same event ask for the same address and share one cached response.
// `bucket` is a pull Beezie announced and `minute` the once-a-minute safety
// poll; either gives every viewer the same address, so one function run
// serves them all.
export async function fetchDashboard({ bucket, minute } = {}) {
  try {
    const query = bucket ? `?e=${bucket}` : minute ? `?m=${minute}` : '';
    const response = await fetch(`/api/claws${query}`);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.claws) && data.claws.length > 0) {
        // Pulls arrive without their chain and claw name, which are read from
        // the key here rather than sent 250 times over.
        const nameOf = Object.fromEntries(data.claws.map((claw) => [claw.key, claw.name]));
        const recentPulls = (data.recentPulls || []).map((pull) => ({
          ...pull,
          blockchain: pull.blockchain || String(pull.key || '').split(':')[0],
          clawName: pull.clawName || nameOf[pull.key] || pull.key,
        }));
        return {
          claws: data.claws,
          lastPlayed: data.lastPlayed || {},
          lastRestock: data.lastRestock || {},
          restockSnapshots: data.restockSnapshots || {},
          recentPulls,
          failed: data.failed || [],
          stale: data.stale || [],
          retiredClaws: data.retiredClaws || [],
          source: 'shared',
        };
      }
    }
  } catch {
    // Endpoint missing or unreachable; fall through to direct fetching.
  }

  const { claws, failed } = await fetchAllClaws();
  return {
    claws,
    lastPlayed: {},
    lastRestock: {},
    restockSnapshots: {},
    recentPulls: [],
    failed,
    stale: [],
    retiredClaws: [],
    source: 'direct',
  };
}
