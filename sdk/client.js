/** @litvm/sdk/client — the game-side half of a title built from scratch.
 *
 *  A title is one file (sdk/index.js: defineTitle). This is what its CLIENT
 *  imports to take part in a mesh match: read the arcade's launch, run the
 *  same title module locally for rendering, record the per-tick inputs the
 *  node will replay, get the player's ledger signature from the arcade
 *  shell at match end (the key never leaves the cabinet's origin), and hand
 *  the signed ledger to the host node. Isomorphic: browser and Node.
 *
 *  Transport between the two players is yours (a WebSocket relay, WebRTC).
 *  The mesh places, replays, witnesses and settles; it does not carry
 *  frames. Inputs must reach both clients in the same order — whoever
 *  submits the ledger must hold every tick's inputs for every player.
 *
 *  Standalone (no cabinet — your own lobby, a test): `createClient` from
 *  cabinet/client.js queues and verifies placement, and `localSigner`
 *  signs with a key you hold. In the arcade, `connectShell` does both. */
import { h } from '../protocol/canonical.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { chainHead, ledgerBody, LEDGER_TAG, chainStep, GENESIS } from '../protocol/log.js';
import { roomCodeFor } from '../protocol/pairing.js';
import { seedFor } from '../protocol/placement.js';
import { agent as makeAgent } from '../protocol/erc6699.js';
export { seedFor, roomCodeFor, chainHead, ledgerBody };

/** What the node hydrates when a submission carries no characters: every
 *  participant is an `external` agent with zeroed core stats. Give this to
 *  createSim so a standalone or casual client reaches the node's exact
 *  state root. In a placed ranked match with a registry, the node reads
 *  the characters from the chain at the placement's block instead; a
 *  client wanting to render those has to read the same registry (the shell
 *  does not pass them yet — a known gap, docs/BUILD-FROM-SCRATCH.md). */
export const externalAgents = (participants) => Object.fromEntries(participants.map((p) => [p, makeAgent({ tokenId: `external:${p}`, stats: {}, manifest: null, source: 'external' })]));
export { createClient, loadPlayer } from '../cabinet/client.js';

// ------------------------------------------------------------------ launch

/** The arcade opens display.url with these when the mesh placed a match:
 *    ?ws=<relay wss>&room=LIT-…&player=<key>&match=<matchId>&build=<buildHash>
 *  Absent in a standalone run. `search` is location.search or a URL. */
export function parseLaunch(search = globalThis.location?.search ?? '') {
  const p = search instanceof URL ? search.searchParams : new URLSearchParams(String(search).replace(/^[^?]*\?/, ''));
  const get = (k) => (p.get(k) ? p.get(k) : null);
  const matchId = get('match');
  return { ws: get('ws'), room: get('room') ?? (matchId ? roomCodeFor(matchId) : null), player: get('player'), matchId, buildHash: get('build'), placed: !!matchId };
}

// ------------------------------------------------------------------- shell

/** Talk to the cabinet shell around this iframe. Resolves once the shell
 *  answers `cabinet:hello` with `cabinet:init` ({ player, node, game,
 *  match? }); `sign(body)` asks the shell for the player's ledger signature
 *  over exactly the match and build it launched. Outside a shell, `init`
 *  never arrives: use `timeoutMs` and fall back to standalone. */
export function connectShell({ win = globalThis.window, timeoutMs = 3000 } = {}) {
  if (!win?.parent || win.parent === win) return Promise.reject(new Error('not inside a cabinet shell'));
  return new Promise((resolve, reject) => {
    let init = null;
    const pending = new Map(); // matchId → { resolve, reject }
    const onMessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'cabinet:init' && !init) { init = d; resolve(shell); }
      if (d.type === 'cabinet:signed') { const p = pending.get(d.matchId); if (!p) return; pending.delete(d.matchId); d.error ? p.reject(new Error(d.error)) : p.resolve({ player: d.player, sig: d.sig }); }
    };
    win.addEventListener('message', onMessage);
    const shell = {
      get init() { return init; },
      get player() { return init?.player ?? null; },
      get match() { return init?.match ?? null; },
      get node() { return init?.node ?? null; },
      /** body = ledgerBody({ matchId, ticks, head, buildHash }) */
      sign: (body, { timeoutMs: t = 10_000 } = {}) => new Promise((res, rej) => {
        pending.set(body.matchId, { resolve: res, reject: rej });
        win.parent.postMessage({ type: 'cabinet:sign', body }, '*');
        setTimeout(() => { if (pending.delete(body.matchId)) rej(new Error('shell did not sign in time')); }, t);
      }),
      exit: () => win.parent.postMessage({ type: 'cabinet:exit' }, '*'),
      close: () => win.removeEventListener('message', onMessage),
    };
    win.parent.postMessage({ type: 'cabinet:hello' }, '*');
    setTimeout(() => { if (!init) { win.removeEventListener('message', onMessage); reject(new Error('no cabinet:init — not launched from the arcade')); } }, timeoutMs);
  });
}

/** A signer for standalone runs: your own key (dev, tests, a title with its
 *  own lobby). Same interface as the shell's sign(). */
export async function localSigner(kp = null) {
  const key = kp ?? (await generateKeypair());
  return { player: key.publicKey, publicKey: key.publicKey, sign: async (body) => ({ player: key.publicKey, sig: await sign(LEDGER_TAG, body, key.privateKey) }) };
}

// ---------------------------------------------------------------- simulate

/** Drive a title module locally, the way the node will in replay: init
 *  from the seed, step with { playerId: input } per tick. `ctx.agents` is
 *  whatever you know about the characters (the node hydrates its own). */
export function createSim(title, { seed, participants, ctx = {} }) {
  let state = title.init(seed, participants, ctx);
  let tick = 0;
  return {
    step(inputs) { if (title.done(state)) return state; state = title.step(state, inputs); tick++; return state; },
    get state() { return state; }, get tick() { return tick; },
    view: () => title.view(state), done: () => title.done(state), scores: () => title.scores(state),
    root: () => h('state', title.serialize(state)),
  };
}

// ---------------------------------------------------------------- recorder

/** Record the per-tick inputs of every participant, in participant order —
 *  the entries the host node replays and the witness re-replays. The chain
 *  head is maintained incrementally so a client can show it live and sign
 *  it the instant the match ends. */
export function createRecorder({ matchId, participants, rulesetId, buildHash, mode = 'ranked' }) {
  const entries = [];
  let head = GENESIS;
  const order = [...participants];
  return {
    /** inputs: { playerId: number } or an array in participant order. */
    record(inputs) {
      const k = entries.length;
      const arr = Array.isArray(inputs) ? inputs.map((x) => x | 0) : order.map((p) => (inputs[p] ?? 0) | 0);
      if (arr.length !== order.length) throw new Error(`tick ${k}: ${arr.length} inputs for ${order.length} participants`);
      const entry = { k, inputs: arr };
      entries.push(entry);
      head = chainStep(head, entry);
      return entry;
    },
    get ticks() { return entries.length; },
    get head() { return head; },
    entries: () => entries.slice(),
    /** What each player signs (protocol 3). */
    body: () => ledgerBody({ matchId, ticks: entries.length, head, buildHash }),
    /** The unsigned submission; add `signatures` from every player. */
    submission: ({ signatures = {}, hydration = null, expected = null } = {}) => ({ matchId, rulesetId, buildHash, mode, participants: order, entries: entries.slice(), ...(Object.keys(signatures).length ? { signatures } : {}), ...(hydration ? { hydration } : {}), ...(expected ? { expected } : {}) }),
  };
}

/** Check that a recorder's head equals the chain head over its entries
 *  (a sanity test for a client before it asks anyone to sign). */
export const headMatches = (rec) => chainHead(rec.entries()) === rec.head;

// ------------------------------------------------------------------ submit

/** Collect both players' signatures and settle on the host node.
 *  `signers` maps playerId → { sign(body) } (the shell for this player, your
 *  transport's relay of the other player's signature, or localSigner in
 *  tests). Returns the node's delta. */
export async function settle({ nodeUrl, recorder, signers, fetchImpl = globalThis.fetch, hydration = null }) {
  const body = recorder.body();
  const signatures = {};
  // Each entry is a signer ({ sign(body) } — the shell, localSigner) or the signature itself, e.g. the
  // other player's, carried over your transport as a hex string or { sig }.
  for (const [playerId, s] of Object.entries(signers)) { const r = typeof s === 'string' ? s : typeof s?.sign === 'function' ? await s.sign(body) : s; signatures[playerId] = r?.sig ?? r; }
  const sub = recorder.submission({ signatures, hydration });
  const r = await fetchImpl(`${String(nodeUrl).replace(/\/+$/, '')}/ledger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `ledger: ${r.status}`);
  return j;
}

/** The seed a placed match runs from — the same value on host, witness and
 *  both clients: H('seed', beacon, matchId). An unplaced (standalone) match
 *  uses H('seed', matchId), as the node does for casual submissions. */
export const matchSeed = (match) => (match?.beacon ? seedFor(match.beacon, match.matchId) : h('seed', match.matchId));
