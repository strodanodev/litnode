/** litVM testnet NFTs for the Cards page. Read-only, no wallet library, nothing signs.
 *
 *  Three sources, and the chain has the last word:
 *    explorer  Blockscout (CHAIN.explorer /api/v2, CORS *): which collections and token ids a wallet holds, and a
 *              collection's newest tokens. Its index can lag a fresh mint, so it is a list, never the count.
 *    chain     balanceOf(owner) per ERC-721 collection is the authoritative count, and tokenURI(id) is the card:
 *              Blockscout on Liteforge has not fetched metadata for these collections (metadata: null), so every
 *              card is described from the chain itself (Rapture Cards keep base64 JSON on chain).
 *    IPFS      art and off-chain metadata through public gateways, falling back gateway by gateway (a network
 *              that cannot resolve ipfs.io still gets the art from filebase or pinata).
 *
 *  Tested against Rapture Cards (0x138F…2721, ERC-721, ~7.7k tokens, id = setId << 32 | serial), 7 Nov 2026. */
import { rpcCall } from './chain.js';
import { CHAIN } from './config.js';

/** litVM testnet NFT collections the Cards page features: listed first for a wallet, and browsable (newest mints)
 *  when no wallet is known. Every other NFT a wallet holds on litVM shows too (cabinet/nfts.js). These are
 *  third-party collections, not litnode contracts, so they are named here: config.js and contracts.js
 *  carry litnode's own (demo/cabinet.test.mjs keeps address literals out of config.js). */
export const NFT_COLLECTIONS = [
  { address: '0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721', name: 'Rapture Cards', about: 'https://github.com/strodanodev/tessaract' },
];

export const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
const SEL = { balanceOf: '0x70a08231', tokenURI: '0xc87b56dd', uri: '0x0e89341c' };
const TYPES = 'ERC-721,ERC-404,ERC-1155';
const URI_LIMIT = 256 * 1024;     // a tokenURI bigger than this is not a card
const PAGE_CAP = 20;              // x50 explorer items: more than a testnet wallet holds
const CONCURRENCY = 6;

export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? '').trim());
const low = (a) => String(a).toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => low(a).slice(2).padStart(64, '0');
export const explorerToken = (contract, id) => `${CHAIN.explorer}/token/${contract}/instance/${id}`;
export const explorerAddress = (a) => `${CHAIN.explorer}/address/${a}`;

async function api(path, { timeoutMs = 12000 } = {}) {
  const r = await fetch(`${CHAIN.explorer}/api/v2${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  return r.json();
}
const qs = (o) => Object.entries(o ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** Run fn over items, at most n at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------------------------------------------------------------- decoding
/** The ABI-encoded `string` an eth_call returns -> JS string. Bounds-checked: hostile data throws. */
export function decodeAbiString(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  if (h.length < 128) throw new Error('ABI string is truncated');
  const off = parseInt(h.slice(0, 64), 16) * 2;
  if (!Number.isSafeInteger(off) || off + 64 > h.length) throw new Error('ABI string offset is out of range');
  const len = parseInt(h.slice(off, off + 64), 16);
  if (!Number.isSafeInteger(len) || len > URI_LIMIT || off + 64 + len * 2 > h.length) throw new Error('ABI string length is out of range');
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(h.substr(off + 64 + i * 2, 2), 16);
  return new TextDecoder().decode(bytes);
}

/** A `data:application/json` URI -> its JSON; null for anything else (an ipfs:// or https:// pointer). */
export function parseDataJson(uri) {
  const m = /^data:application\/json((?:;[^;,]*)*),([\s\S]*)$/i.exec(String(uri));
  if (!m) return null;
  let text;
  if (/;base64$/i.test(m[1])) text = new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
  else { try { text = decodeURIComponent(m[2]); } catch { text = m[2]; } }
  return JSON.parse(text);
}

/** Every URL that may serve a URI, best first: ipfs:// (and /ipfs/ paths) across GATEWAYS, http(s) and data: as is. */
export function mediaUrls(uri) {
  const u = String(uri ?? '').trim();
  if (!u) return [];
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u) ?? /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(u);
  if (ipfs) return GATEWAYS.map((g) => g + ipfs[1]);
  if (/^ar:\/\//i.test(u)) return [`https://arweave.net/${u.slice(5)}`];
  if (/^(https?:|data:image\/)/i.test(u)) return [u];
  return [];
}

const attr = (json, name) => json?.attributes?.find?.((a) => low(a?.trait_type ?? '') === low(name))?.value;
/** A token's metadata JSON -> what a card shows. Rapture Cards ('rapture/1') get kind, element and the four stats. */
export function cardOf(json) {
  const r = json?.rapture;
  const stats = ['Strength', 'Agility', 'Resilience', 'Intelligence'].map((k) => attr(json, k)).filter((v) => typeof v === 'number');
  const sub = [r?.kind ?? attr(json, 'Kind'), r?.element ?? attr(json, 'Element')].filter(Boolean).join(' · ');
  return {
    name: typeof json?.name === 'string' && json.name ? json.name : null,
    image: mediaUrls(json?.image ?? json?.image_url ?? json?.image_data),
    badge: sub || attr(json, 'Rarity') || attr(json, 'Type') || '',
    faction: r?.faction ?? attr(json, 'Faction') ?? null,
    set: attr(json, 'Set') ?? null,
    stats: stats.length === 4 ? { STR: stats[0], AGI: stats[1], RES: stats[2], INT: stats[3] } : null,
    unrevealed: r ? r.revealed === false : false,
  };
}

// ---------------------------------------------------------------- metadata (cached for the page's life)
const META = new Map();          // `${contract}:${id}` -> Promise<card | { error }>
/** The card a token is, read from the chain (tokenURI, or uri for ERC-1155) and, for a pointer, from the web. */
export function metadata(contract, id, type = 'ERC-721') {
  const key = `${low(contract)}:${id}`;
  if (!META.has(key)) META.set(key, (async () => {
    try {
      const data = (type === 'ERC-1155' ? SEL.uri : SEL.tokenURI) + word(id);
      let uri = decodeAbiString(await rpcCall('eth_call', [{ to: contract, data }, 'latest']));
      if (type === 'ERC-1155') uri = uri.replace(/\{id\}/g, BigInt(id).toString(16).padStart(64, '0'));
      let json = parseDataJson(uri);
      if (!json) {
        for (const url of mediaUrls(uri)) {
          try { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (r.ok) { json = await r.json(); break; } } catch { /* next gateway */ }
        }
      }
      if (!json) return { error: 'no metadata' };
      return cardOf(json);
    } catch (e) {
      META.delete(key);            // a transient RPC failure must not pin "no card" for the page's life
      return { error: e.message };
    }
  })());
  return META.get(key);
}
/** Fill meta for every token in the list, at most CONCURRENCY at a time; onEach fires as each lands. */
export async function describe(tokens, onEach) {
  await pool(tokens, CONCURRENCY, async (t) => { if (t.meta) return; t.meta = await metadata(t.contract, t.id, t.type); onEach?.(t); });
}

// ---------------------------------------------------------------- lists
const tokenRow = (it, contract, type, name, symbol) => ({
  contract: contract ?? it.token?.address_hash ?? it.token?.address,
  id: String(it.id),
  type: type ?? it.token_type ?? it.token?.type ?? 'ERC-721',
  amount: Number(it.value ?? 1) || 1,
  collection: name ?? it.token?.name ?? null,
  symbol: symbol ?? it.token?.symbol ?? null,
  meta: null,
});

/** { name, symbol, type, holders, supply } for a collection, or null when the explorer does not know it. */
export async function collectionInfo(contract) {
  try {
    const t = await api(`/tokens/${contract}`);
    return { contract, name: t.name ?? null, symbol: t.symbol ?? null, type: t.type ?? 'ERC-721', holders: Number(t.holders_count ?? t.holders ?? 0), supply: t.total_supply != null ? Number(t.total_supply) : null };
  } catch { return null; }
}

/** A collection's newest tokens, one explorer page (50) at a time. -> { tokens, next } */
export async function latest(contract, info, next = null) {
  const j = await api(`/tokens/${contract}/instances${next ? `?${qs(next)}` : ''}`);
  return { tokens: (j.items ?? []).map((it) => ({ ...tokenRow(it, contract, info?.type, info?.name, info?.symbol), owner: it.owner?.hash ?? null })), next: j.next_page_params ?? null };
}

/** balanceOf(owner) on chain: the count the explorer is checked against. null when unreachable. */
export async function balanceOf(contract, owner) {
  try { return Number(BigInt(await rpcCall('eth_call', [{ to: contract, data: SEL.balanceOf + addrWord(owner) }, 'latest']))); }
  catch { return null; }
}

/**
 * Everything an address holds on litVM: [{ contract, name, symbol, type, amount, onChain, tokens: [...] }],
 * `featured` collections first (then the biggest). For each ERC-721 collection the chain's balanceOf is read and
 * kept as `onChain`; when it is more than the explorer listed, the gap is the explorer's lag.
 */
export async function holdings(owner, featured = []) {
  const groups = new Map();
  let next = null;
  for (let p = 0; p < PAGE_CAP; p++) {
    const j = await api(`/addresses/${owner}/nft?${qs({ type: TYPES, ...next })}`);
    for (const it of j.items ?? []) {
      const t = tokenRow(it);
      if (!t.contract) continue;
      const k = low(t.contract);
      if (!groups.has(k)) groups.set(k, { contract: t.contract, name: t.collection, symbol: t.symbol, type: t.type, tokens: [], onChain: null });
      groups.get(k).tokens.push(t);
    }
    next = j.next_page_params;
    if (!next) break;
  }
  const feat = featured.map(low);
  for (const f of featured) {        // a featured collection the explorer has not indexed for this wallet yet still gets a chain count
    if (!groups.has(low(f))) { const info = await collectionInfo(f); groups.set(low(f), { contract: f, name: info?.name ?? null, symbol: info?.symbol ?? null, type: info?.type ?? 'ERC-721', tokens: [], onChain: null }); }
  }
  const list = [...groups.values()];
  await pool(list.filter((g) => g.type === 'ERC-721'), CONCURRENCY, async (g) => { g.onChain = await balanceOf(g.contract, owner); });
  for (const g of list) {
    g.tokens.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    g.amount = g.tokens.reduce((s, t) => s + t.amount, 0);
  }
  return list
    .filter((g) => g.amount || g.onChain)
    .sort((a, b) => (feat.includes(low(b.contract)) - feat.includes(low(a.contract))) || (b.amount - a.amount));
}

/** The browser wallet's first account, asked for read access only (no chain switch, no signature). */
export async function walletAccount() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet in this browser. Paste an address instead.');
  const [a] = await eth.request({ method: 'eth_requestAccounts' });
  if (!isAddress(a)) throw new Error('The wallet returned no account.');
  return a;
}
