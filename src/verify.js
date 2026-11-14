// "Verify this play": checks a Solana claw play against the chain.
//
// A play is two transactions on Beezie's claw program. The first (commit) locks
// in keccak256(server_seed) and the second (reveal) hands over the seed and the
// slabs. The program refuses a reveal whose seed doesn't hash to the commitment,
// so a seed can't be changed after the player has paid. This reads both
// transactions from a public Solana node and repeats those checks.
//
// What it cannot show: the program holds no odds table and no list of slabs, so
// nothing on-chain ties the seed to the tier or the slab that came out.

export const PROGRAM = 'BZCjgSRmWWGijSDrSBEzx47Yx9WTvqrhWCff5kVA7VsM';
export const RPC_URL = 'https://api.mainnet-beta.solana.com';

// The first eight bytes of every instruction: sha256("global:<name>"), as Anchor writes them.
const COMMIT = 'f788fc000014246a';
const REVEAL = '185618c01fe4220e';

// How far either side of the log's timestamp to look for the play's transactions,
// in seconds. The commit comes a few seconds before the reveal.
const BEFORE = 180;
const AFTER = 60;
const MAX_TX_READS = 14;
const MAX_SIG_PAGES = 3;
// The reveal can't come sooner than this many slots after the commit.
const MIN_SLOTS = 2;

// --- Keccak-256 (the original padding Solana and Ethereum use, not NIST SHA-3) ---

const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATIONS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const LANES = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function permute(s) {
  const c = new Array(5);
  const b = new Array(5);
  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let t = s[1];
    for (let i = 0; i < 24; i += 1) {
      const j = LANES[i];
      const next = s[j];
      s[j] = rotl(t, ROTATIONS[i]);
      t = next;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) b[x] = s[y + x];
      for (let x = 0; x < 5; x += 1) s[y + x] ^= ~b[(x + 1) % 5] & MASK & b[(x + 2) % 5];
    }
    s[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Keccak-256 of a Uint8Array, as a lowercase hex string. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let lane = 0n;
      for (let k = 7; k >= 0; k -= 1) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      state[i] ^= lane;
    }
    permute(state);
  }
  let hex = '';
  for (let i = 0; i < 4; i += 1) {
    for (let k = 0; k < 8; k += 1) hex += Number((state[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0');
  }
  return hex;
}

// --- Reading transactions ---

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error('Not base58');
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * What a getTransaction result (encoding "json") says about a claw play, or null
 * when it isn't a commit or reveal on Beezie's program.
 *   commit: { kind, sig, slot, time, machine, state, player, commitment }
 *   reveal: { kind, sig, slot, time, machine, state, player, seed, assets }
 */
export function readPlayTx(sig, result) {
  if (!result || result.meta?.err) return null;
  const message = result.transaction?.message;
  if (!message) return null;
  const keys = [
    ...message.accountKeys,
    ...(result.meta?.loadedAddresses?.writable || []),
    ...(result.meta?.loadedAddresses?.readonly || []),
  ];
  const ix = message.instructions.find((i) => keys[i.programIdIndex] === PROGRAM);
  if (!ix) return null;
  const data = base58Decode(ix.data);
  const accounts = ix.accounts.map((i) => keys[i]);
  const head = { sig, slot: result.slot, time: result.blockTime, machine: accounts[0] };
  const disc = toHex(data.subarray(0, 8));
  if (disc === COMMIT && data.length >= 41) {
    return { kind: 'commit', ...head, state: accounts[2], player: accounts[7], commitment: toHex(data.subarray(9, 41)) };
  }
  if (disc === REVEAL && data.length >= 41) {
    return { kind: 'reveal', ...head, state: accounts[1], player: accounts[2], seed: toHex(data.subarray(9, 41)), assets: accounts.slice(10) };
  }
  return null;
}

/**
 * The checks, given the two transactions and what the log showed.
 * `expect`: { wallet, machine, tokenIds }.
 */
export function checkPlay(commit, reveal, expect) {
  const steps = [];
  const add = (id, pass, label, detail) => steps.push({ id, pass, label, detail });

  add('found', Boolean(reveal && commit), 'Both transactions found on-chain', null);
  if (!reveal || !commit) return steps;

  add('machine', reveal.machine === expect.machine && commit.machine === expect.machine,
    'Played on this claw\'s machine account', null);
  add('player', reveal.player === expect.wallet && commit.player === expect.wallet,
    'Paid by the same wallet the log shows', null);
  const hash = keccak256(hexToBytes(reveal.seed));
  add('seed', hash === commit.commitment,
    'Revealed seed hashes to the commitment made before the play',
    `keccak256(seed) = ${hash.slice(0, 16)}…`);
  add('order', reveal.slot - commit.slot >= MIN_SLOTS,
    'Revealed after the commit\'s waiting period',
    `${reveal.slot - commit.slot} slots later`);
  const have = new Set(reveal.assets);
  const matched = expect.tokenIds.filter((id) => have.has(id)).length;
  add('cards', matched === expect.tokenIds.length,
    expect.tokenIds.length === 1 ? 'The slab in the log is the one handed over' : 'The slabs in the log are the ones handed over',
    matched === expect.tokenIds.length ? null : `${matched} of ${expect.tokenIds.length} found in the reveal`);
  return steps;
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g) || [], (h) => parseInt(h, 16));

// --- Talking to the node ---

export class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function rpc(method, params, { url = RPC_URL, fetcher = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      throw new VerifyError('network', 'Couldn\'t reach the Solana node.');
    }
    // The public node allows about ten transaction reads per ten seconds.
    if (response.status === 429) {
      await wait(1500 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new VerifyError('network', `The Solana node answered ${response.status}.`);
    const body = await response.json();
    if (body.error) throw new VerifyError('network', body.error.message || 'The Solana node refused the request.');
    return body.result;
  }
  throw new VerifyError('busy', 'The public Solana node is busy. Try again in a few seconds.');
}

/**
 * Finds a play's commit and reveal on-chain. `play`: { wallet, at (ms), tokenIds }.
 * Resolves to { commit, reveal } (commit is null when the reveal's can't be found).
 * Run by the server: Solana's public node refuses requests that come from a web page.
 */
export async function findPlay(play, options = {}) {
  const call = (method, params) => rpc(method, params, options);
  const at = Math.round(play.at / 1000);

  // The wallet's recent signatures, newest first, back to before the play.
  const candidates = [];
  let before;
  for (let page = 0; page < MAX_SIG_PAGES; page += 1) {
    const sigs = await call('getSignaturesForAddress', [play.wallet, { limit: 100, ...(before ? { before } : {}) }]);
    if (!sigs.length) break;
    for (const s of sigs) {
      if (!s.err && s.blockTime >= at - BEFORE && s.blockTime <= at + AFTER) candidates.push(s);
    }
    before = sigs[sigs.length - 1].signature;
    if (sigs[sigs.length - 1].blockTime < at - BEFORE || sigs.length < 100) break;
  }
  candidates.sort((a, b) => Math.abs(a.blockTime - at) - Math.abs(b.blockTime - at));

  // Nearest to the log's timestamp first; stops once the reveal and the commit it
  // answers are both in hand.
  let reveal = null;
  let commit = null;
  const commits = [];
  for (const s of candidates.slice(0, MAX_TX_READS)) {
    const result = await call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const tx = readPlayTx(s.signature, result);
    if (tx?.kind === 'commit') commits.push(tx);
    if (tx?.kind === 'reveal' && !reveal && play.tokenIds.some((id) => tx.assets.includes(id))) reveal = tx;
    if (reveal) {
      commit = commits.find((c) => c.state === reveal.state && c.slot < reveal.slot) || null;
      if (commit) break;
    }
  }

  if (!reveal) throw new VerifyError('missing', 'Couldn\'t find this play on-chain. It may be too old for the public node to look up.');
  return { commit, reveal };
}

/**
 * Finds a play and checks it, all in one place. `play`: { wallet, at (ms), machine, tokenIds }.
 * Resolves to { steps, ok, commit, reveal }; `ok` is true when every step passed.
 */
export async function verifyPlay(play, options = {}) {
  const { commit, reveal } = await findPlay(play, options);
  const steps = checkPlay(commit, reveal, { wallet: play.wallet, machine: play.machine, tokenIds: play.tokenIds });
  return { steps, ok: steps.every((s) => s.pass), commit, reveal };
}
