/** The match receipt: what the chain recorded about one match, each step a
 *  transaction a player can open on the Liteforge block explorer — and each
 *  one re-checked from this browser against the chain, not taken from the
 *  node's word.
 *
 *  Sources, in order of authority:
 *    the chain       eth_getTransactionReceipt for every tx the node names
 *                    (status 1, sent to MatchBook, carrying that event for
 *                    this match), EpochAnchor.rootOf(hour) for the hour's root
 *    the node        GET /match/:id/chain (its decoded MatchBook events),
 *                    /delta/:id (the local settlement: ticks, attestation),
 *                    /proof/:id (the hour's Merkle path)
 *  A step the node reports and the chain does not confirm is shown, marked
 *  "not confirmed"; nothing is hidden and nothing is upgraded.
 *
 *  Route: #/match/<matchId> — a link a player can paste. Pure module: the
 *  caller passes `api` (node reads), `rpc` (chain reads, or null) and the
 *  contract set. */
import { keccak256Hex, selector } from './protocol/keccak.js';

const EVENTS = {
  Committed: 'Committed(bytes32,bytes32,bytes32,bytes32,bytes32[3])',
  Settled: 'Settled(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32[],int64[],bytes32[])',
  Attested: 'Attested(bytes32,bytes32,bytes32,bool,bool)',
  Extended: 'Extended(bytes32,uint64)',
  Escalating: 'Escalating(bytes32,uint64,uint64)',
  Escalated: 'Escalated(bytes32,bytes32,bytes32[],uint256[])',
  Finalized: 'Finalized(bytes32,bytes32,bytes32,uint8)',
};
const TOPIC = Object.fromEntries(Object.entries(EVENTS).map(([k, sig]) => [k, '0x' + keccak256Hex(sig)]));
const lc = (s) => String(s ?? '').toLowerCase();
const strip0x = (s) => lc(s).replace(/^0x/, '');

/** What each step means, in a player's words. */
export const STEP = {
  Committed: 'Placed on chain — the host and three witnesses were fixed before a single frame was played',
  Settled: 'Result posted — the host replayed the match and published the score, result hash and ledger hash',
  Attested: 'Witness verdict — an independent node replayed the same ledger and signed what it reached',
  Extended: 'Window extended — a witness was late, so the chain gave it more time',
  Escalating: 'Dispute opened — witnesses disagreed; a larger panel is being drawn',
  Escalated: 'Escalation panel seated',
  Finalized: 'Final — the chain closed the match',
};
const ORDER = ['Committed', 'Settled', 'Attested', 'Extended', 'Escalating', 'Escalated', 'Finalized'];

/** Re-check one transaction against the chain. → { ok, reason } (ok null = could not check). */
export async function confirmTx(rpc, { tx, event, matchKey, contract, block }) {
  if (!rpc || !tx) return { ok: null, reason: 'no chain reader' };
  try {
    const r = await rpc('eth_getTransactionReceipt', [tx]);
    if (!r) return { ok: false, reason: 'no such transaction on chain' };
    if (r.status !== '0x1') return { ok: false, reason: 'transaction reverted' };
    if (contract && lc(r.to) !== lc(contract)) return { ok: false, reason: 'sent to another contract' };
    if (block != null && parseInt(r.blockNumber, 16) !== block) return { ok: false, reason: 'in another block than reported' };
    const hit = (r.logs ?? []).some((l) => lc(l.address) === lc(contract) && lc(l.topics?.[0]) === lc(TOPIC[event]) && strip0x(l.topics?.[1]) === strip0x(matchKey));
    return hit ? { ok: true, gasUsed: parseInt(r.gasUsed, 16), from: r.from } : { ok: false, reason: `no ${event} for this match in the transaction` };
  } catch (e) { return { ok: null, reason: e.message }; }
}

/** EpochAnchor.rootOf(epoch) from the chain → hex (no 0x) or null. */
async function anchoredRoot(rpc, anchor, epoch) {
  if (!rpc || !anchor || epoch == null) return null;
  try {
    const out = await rpc('eth_call', [{ to: anchor, data: selector('rootOf(uint64)') + BigInt(epoch).toString(16).padStart(64, '0') }, 'latest']);
    const root = strip0x(out);
    return /^0+$/.test(root) ? '' : root;
  } catch { return null; }
}

/** Everything the receipt page shows for one match. */
export async function loadReceipt(matchId, { api, rpc, contracts }) {
  const get = (p) => api(p).catch(() => null);
  const [chain, delta, proof] = await Promise.all([get(`/match/${encodeURIComponent(matchId)}/chain`), get(`/delta/${encodeURIComponent(matchId)}`), get(`/proof/${encodeURIComponent(matchId)}`)]);
  if (!chain && !delta) throw new Error('the node did not answer — is it online?');
  const events = [...(chain?.events ?? [])].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || ORDER.indexOf(a.event) - ORDER.indexOf(b.event));
  const matchKey = chain?.key ?? matchId;
  const mb = contracts?.MatchBook;
  const checks = await Promise.all(events.map((e) => confirmTx(rpc, { tx: e.tx, event: e.event, matchKey, contract: mb, block: e.block })));
  const epoch = proof?.status === 'final' || proof?.root ? proof.epoch : null;
  const root = chain?.status && chain.status !== 'none' ? await anchoredRoot(rpc, contracts?.EpochAnchor, epoch) : null;
  const settled = events.find((e) => e.event === 'Settled') ?? null;
  const committed = events.find((e) => e.event === 'Committed') ?? null;
  return {
    matchId, matchKey, status: chain?.status ?? (chain ? 'none' : 'unknown'), panel: chain?.panel ?? committed?.panel ?? null,
    events: events.map((e, i) => ({ ...e, check: checks[i] })), settled, committed,
    delta: delta && !delta.error ? delta : null,
    proof: proof && !proof.error ? { ...proof, anchoredRoot: root } : null,
    nodeHasMatchBook: chain ? chain.matchBook !== null : null,
  };
}

// ─────────────────────────────────────────────────────────────── render
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 10) => (s ? `${String(s).slice(0, n)}…` : '—');
const STATUS_TAG = {
  final: ['live', 'final on chain', 'the chain closed this match with its result; it counts toward the official ladder'],
  void: ['court', 'voided on chain', 'witnesses disagreed, the host never settled, or the match was abandoned; it does not count'],
  settled: ['', 'settled · awaiting witnesses', 'the host posted the result; witness verdicts are still arriving'],
  committed: ['', 'committed · awaiting result', 'placed on chain; the result has not been posted yet'],
  escalating: ['court', 'in dispute', 'a larger panel is being drawn'],
  escalated: ['court', 'in dispute', 'a larger panel is judging'],
  none: ['', 'not on chain', 'this match settled on the node only — it was never committed to MatchBook'],
  unknown: ['', 'unknown', 'the node could not be asked'],
};

/** @param r    loadReceipt()'s result
 *  @param o.explorer  base URL of the block explorer
 *  @param o.me        this player's key (to mark "you")
 *  @param o.names     key → display name, optional */
export function renderReceipt(r, { explorer, me = null, names = {}, contracts = {}, link = globalThis.location?.href ?? '' } = {}) {
  const ex = (kind, v, label = null) => (v ? `<a class="link mono" target="_blank" rel="noopener" title="open on the Liteforge explorer" href="${esc(explorer)}/${kind}/${esc(v)}">${esc(label ?? short(v, 12))} ↗</a>` : '—');
  const hex = (v) => (v ? `0x${strip0x(v)}` : null);
  const [cls, label, title] = STATUS_TAG[r.status] ?? STATUS_TAG.unknown;
  const who = (k) => `${k === me ? '<b>you</b> · ' : ''}${esc(names[k] ?? short(k, 12))}`;

  // Result: from the chain's Settled event when there is one, else the local settlement.
  const parts = r.settled?.participants ?? r.delta?.participants ?? [];
  const scores = r.settled ? Object.fromEntries(r.settled.participants.map((p, i) => [p, r.settled.scores[i]])) : r.delta?.scores ?? {};
  const top = parts.length ? Math.max(...parts.map((p) => scores[p] ?? 0)) : null;
  const winners = parts.filter((p) => (scores[p] ?? 0) === top);
  const result = parts.length ? `<table class="rcpt-score"><tbody>${parts.map((p) => `<tr class="${p === me ? 'me' : ''}"><td>${who(p)}</td><td class="num"><b>${esc(scores[p] ?? '—')}</b></td><td class="dim">${winners.length === 1 && winners[0] === p ? 'winner' : winners.length > 1 && winners.includes(p) ? 'draw' : ''}</td></tr>`).join('')}</tbody></table><div class="source">${r.settled ? 'Score as posted on chain in the Settled event' : 'Score from this node\'s local settlement (not on chain)'}${r.delta?.ticks ? ` · ${r.delta.ticks} ticks` : ''}${r.delta?.rulesetId ? ` · ${esc(r.delta.rulesetId)}` : ''}</div>` : '<div class="empty">No result recorded yet.</div>';

  // Timeline: one row per on-chain step.
  const check = (c) => (c?.ok === true ? '<span class="res w" title="receipt fetched from the chain by this browser: succeeded, sent to MatchBook, carries this event for this match">✓ confirmed</span>' : c?.ok === false ? `<span class="res l" title="${esc(c.reason)}">✗ ${esc(c.reason)}</span>` : `<span class="dim" title="${esc(c?.reason ?? '')}">not re-checked</span>`);
  const extra = (e) => (e.event === 'Attested' ? `witness ${esc(short(e.witnessKey, 12))} · ${e.agrees ? 'agrees' : '<b>disagrees</b>'}${e.escalation ? ' · escalation seat' : ''}` : e.event === 'Committed' ? `host ${esc(short(e.hostKey, 12))}` : e.event === 'Settled' ? `result ${esc(short(e.resultHash, 12))}` : e.event === 'Finalized' ? `status <b>${esc(e.status)}</b>` : e.event === 'Extended' ? `until ${new Date(e.until * 1000).toLocaleTimeString()}` : '');
  const rows = r.events.map((e) => `<tr>
      <td><b>${esc(e.event)}</b><div class="dim small">${esc(STEP[e.event] ?? '')}</div></td>
      <td class="small">${extra(e)}</td>
      <td class="num">${ex('block', e.block, `#${e.block}`)}</td>
      <td>${e.tx ? ex('tx', e.tx) : '<span class="dim">—</span>'}</td>
      <td class="small">${check(e.check)}</td>
    </tr>`).join('');
  const attests = r.events.filter((e) => e.event === 'Attested');
  const timeline = r.events.length
    ? `<div class="tablewrap"><table class="rcpt-steps"><thead><tr><th>Step</th><th>Detail</th><th class="num">Block</th><th>Transaction</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table></div>
       <div class="source">${attests.length}/${r.panel?.length ?? 3} witness verdicts recorded by this node${r.status === 'final' && attests.length < 3 ? ' (the chain finalizes with the verdicts it has once the window closes; a node that missed an attest transaction still shows the Finalized one)' : ''}. Every link opens the transaction on the Liteforge block explorer; "confirmed" means this browser fetched its receipt from the chain itself.</div>`
    : `<div class="empty">${r.status === 'none' ? 'This match was never committed to MatchBook, so there is no transaction to open. It settled on the node only (unplaced, casual, or the draw could not seat three witnesses) and does not count toward the official ladder.' : r.nodeHasMatchBook === false ? 'This node does not follow MatchBook; ask a node on the current release.' : 'The node holds no chain events for this match.'}</div>`;

  // Proof: hashes a verifier needs, and the hour's anchored root.
  const kv = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const p = r.proof;
  const anchored = p && r.status === 'none' ? '<span class="dim">this node&#39;s own hourly tree — the match is not on chain, so nothing anchors it</span>' : p ? (p.anchoredRoot == null ? '<span class="dim">not re-checked</span>' : p.anchoredRoot === '' ? '<span class="dim">hour not anchored yet</span>' : strip0x(p.anchoredRoot) === strip0x(p.root) ? '<span class="res w">✓ root anchored on EpochAnchor</span>' : '<span class="res l">✗ anchored root differs</span>') : null;
  const proof = `<dl class="mesh rcpt-kv">
      ${kv('match id', `<span class="mono" data-copy="${esc(r.matchId)}" title="click to copy">${esc(short(r.matchId, 20))}</span>`)}
      ${r.committed ? kv('descriptor hash', `<span class="mono">${esc(short(r.committed.descriptorHash, 16))}</span>`) : ''}
      ${r.settled ? kv('result hash', `<span class="mono" data-copy="${esc(hex(r.settled.resultHash))}">${esc(short(r.settled.resultHash, 16))}</span>`) + kv('ledger hash', `<span class="mono" data-copy="${esc(hex(r.settled.ledgerHash))}">${esc(short(r.settled.ledgerHash, 16))}</span>`) + kv('build hash', `<span class="mono">${esc(short(r.settled.buildHash, 16))}</span>`) : ''}
      ${r.panel ? kv('witness panel', r.panel.map((k) => `<span class="mono">${esc(short(k, 10))}</span>`).join(' · ')) : ''}
      ${r.delta?.attestation ? kv('signed by', esc(r.delta.attestation === 'players' ? 'both players (ledger signatures)' : r.delta.attestation)) : ''}
      ${p ? kv('hourly root', `epoch ${esc(p.epoch)} · <span class="mono">${esc(short(p.root, 14))}</span> · ${anchored}${contracts.EpochAnchor ? ` · ${ex('address', contracts.EpochAnchor, 'EpochAnchor')}` : ''}`) : ''}
      ${contracts.MatchBook ? kv('contract', ex('address', contracts.MatchBook, 'MatchBook')) : ''}
    </dl>`;

  return `
    <div class="page-h"><a class="dim" href="#/games">‹ arcade</a><h1 class="chrome" style="margin-left:12px">Match receipt</h1><span class="tag ${cls}" title="${esc(title)}">${esc(label)}</span>
      <div class="right">${link ? `<button class="btn sm" data-copy-now="${esc(link)}">Copy link</button>` : ''}</div></div>
    <div class="grid2">
      <section class="panel"><div class="panel-h"><h3>Result</h3></div><div class="panel-b">${result}</div></section>
      <section class="panel"><div class="panel-h"><h3>Proof</h3></div><div class="panel-b">${proof}</div></section>
    </div>
    <section class="panel"><div class="panel-h"><h3>On chain</h3><span class="dim">Liteforge · <a class="link" target="_blank" rel="noopener" href="${esc(explorer)}">block explorer ↗</a></span></div><div class="panel-b">${timeline}</div></section>`;
}
