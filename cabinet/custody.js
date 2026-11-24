/** Which nodes this page hands a player's AIR sign-in token to.
 *
 *  The token is a bearer credential: the AIR partner's, the same for every node, with no audience in it. A node that
 *  receives it can present it to any other node as the player — bind a key of its own to the player's profile, act
 *  from the player's custodied wallet. The arcade used to send it to whichever seed it had picked, and a seed only
 *  proves WHO it is (/whoami), not that it is honest (audit of 10 Nov 2026). Signing the request with the player key
 *  would not help: the seed can sign with a key of its own.
 *
 *  So the token goes only to:
 *    1. the node that served this page (same origin): an operator's own cabinet, on their own node;
 *    2. a node on this machine (localhost / 127.0.0.1): the visitor's own node, reached from the hosted arcade;
 *    3. a node that proves its key (/whoami, over https) AND whose bond on NodeStake, read from the chain by this
 *       page, is active and held by one of CUSTODY_OPERATORS.
 *  Anything else gets no token. `airNode(preferred)` answers the node to use: the one the page talks to when it
 *  qualifies, else the freshest announced seed of a listed operator, else null (the player stays signed in to AIR;
 *  the litVM profile is set up when a listed node is back).
 *
 *  The list is operator WALLETS, not node keys: an operator may run several nodes and rotate their keys; the bond is
 *  what ties a key to the wallet, and only the wallet's holder can make it. Adding an operator here is a statement
 *  that their nodes may hold players' custodied wallets. */
// The rule below imports nothing, so it runs under node --test; the page's own reads (the chain, the directory,
// /whoami) are loaded when the page first asks.

/** Operator wallets whose bonded nodes may receive AIR tokens. Lowercase. */
export const CUSTODY_OPERATORS = [
  '0x04be2b954346324ee54c4b4c0189df5bb577a378', // LitVM Games (the publisher's nodes)
];

const TTL_MS = 5 * 60_000;
const isLocal = (u) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(u);
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

/** The rule itself, with its reads passed in (demo/custody-list.test.mjs runs it without a browser).
 *    whoami(url) → the node's signed answer to a fresh nonce, checked: { ok, nodeId }
 *    stakeOf(nodeId) → { bonded, operator } | { error } | null, read from the chain by the caller
 *    seeds() → [{ nodeId, url, operator }] announced, bonded, fresh */
export function createCustody({ operators = CUSTODY_OPERATORS, pageOrigin = null, whoami, stakeOf, seeds = async () => [], now = () => Date.now() }) {
  const list = operators.map((a) => String(a).toLowerCase());
  const cache = new Map(); // origin → { at, verdict }
  const judge = async (url) => {
    const origin = originOf(url);
    if (!origin) return { ok: false, reason: 'not a node address' };
    if (pageOrigin && origin === pageOrigin) return { ok: true, why: 'the node that served this page' };
    if (isLocal(origin)) return { ok: true, why: 'a node on this machine' };
    if (!/^https:/.test(origin)) return { ok: false, reason: 'not reached over https' };
    const w = await whoami(origin).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
    if (!w?.ok || !w.nodeId) return { ok: false, reason: `it did not prove its key (${w?.reason ?? 'no answer'})` };
    const s = await stakeOf(w.nodeId).catch(() => null);
    if (!s || s.error) return { ok: false, reason: 'its bond could not be read from the chain', retry: true };
    if (!s.bonded) return { ok: false, reason: 'it has no active bond', nodeId: w.nodeId };
    const operator = String(s.operator ?? '').toLowerCase();
    if (!list.includes(operator)) return { ok: false, reason: 'its operator is not one the arcade gives sign-ins to', nodeId: w.nodeId, operator };
    return { ok: true, why: 'bonded by a listed operator', nodeId: w.nodeId, operator };
  };
  /** { ok, why | reason, nodeId?, operator? } for a node address. Cached five minutes; an unreadable chain is not. */
  const trusted = async (url) => {
    const key = originOf(url) ?? String(url);
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.verdict;
    const verdict = await judge(url);
    if (!verdict.retry) cache.set(key, { at: now(), verdict });
    return verdict;
  };
  /** The node to send the token to: `preferred` when it qualifies, else a listed operator's seed, else null. */
  const airNode = async (preferred) => {
    if (preferred && (await trusted(preferred)).ok) return originOf(preferred);
    let candidates = [];
    try { candidates = (await seeds()).filter((s) => list.includes(String(s.operator ?? '').toLowerCase())); } catch { /* chain unreachable */ }
    for (const s of candidates) if ((await trusted(s.url)).ok) return originOf(s.url);
    return null;
  };
  /** Throws unless `url` may receive the token. Every call that carries one goes through this. */
  const assertTrusted = async (url) => {
    const v = await trusted(url);
    if (!v.ok) throw new Error(`your sign-in is not sent to ${originOf(url) ?? 'this node'}: ${v.reason}`);
    return v;
  };
  return { trusted, airNode, assertTrusted };
}

const proveKey = async (origin) => {
  const { checkChallenge, newNonce } = await import('./protocol/challenge.js');
  const nonce = newNonce();
  const r = await fetch(`${origin}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { ok: false, reason: `whoami ${r.status}` };
  const answer = await r.json();
  const nodeId = typeof answer?.nodeId === 'string' ? answer.nodeId : null;
  if (!nodeId) return { ok: false, reason: 'whoami names no node' };
  const c = await checkChallenge(answer, { expectNodeId: nodeId, nonce });
  return c.ok ? { ok: true, nodeId } : { ok: false, reason: c.reason ?? 'bad signature' };
};

let page = null;
/** This page's instance: real /whoami, the chain through this page's own RPC, the directory's seeds. */
export const custody = () => (page ??= createCustody({
  pageOrigin: typeof location !== 'undefined' ? location.origin : null,
  whoami: proveKey,
  stakeOf: async (nodeId) => (await import('./chain.js')).readStake(nodeId),
  seeds: async () => (await import('./seeds.js')).chainSeeds(),
}));
