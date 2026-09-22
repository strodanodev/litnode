/** The operator's view of a node, from GET /fleet (docs/FLEET-TELEMETRY.md) — read and VERIFIED here.
 *
 *  Every read sends a nonce and checks the node key's answer over nonce + digest (protocol/challenge.js, vendored):
 *  the Node page shows a document this node signed just now, or says why it will not. Nothing here signs
 *  anything or holds a key; the hot key is shown by address only. */
import { h } from './protocol/canonical.js';
import { checkChallenge, newNonce } from './protocol/challenge.js';

/** GET /fleet?nonce= and verify. `expectNodeId` pins the node (the /health id); a document another key signed throws. */
export async function readFleet(base, { expectNodeId = null, timeoutMs = 6000 } = {}) {
  const nonce = newNonce();
  const r = await fetch(`${base}/fleet?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404) throw new Error('this node is older than 0.11.12 and has no /fleet — update it');
  if (!r.ok) throw new Error(`/fleet: HTTP ${r.status}`);
  const doc = await r.json();
  const { digest, proof, ...body } = doc;
  if (h('fleet', body) !== digest) throw new Error('the document does not match its digest');
  const c = await checkChallenge(proof, { expectNodeId: expectNodeId ?? doc.nodeId, nonce, expectDigest: digest });
  if (!c.ok) throw new Error(`the node key did not sign this document (${c.reason})`);
  return doc;
}

/** One line per node event, for the events strip. */
export function describeEvent(ev) {
  const d = ev, id = (v, n = 12) => (typeof v === 'string' ? `${v.slice(0, n)}…` : '');
  switch (ev.type) {
    case 'placed': return `placed ${id(d.matchId)} · ${d.rulesetId} · host ${id(d.host, 8)}`;
    case 'settled': return `settled ${id(d.matchId)}`;
    case 'attested': return `attested ${id(d.matchId)}`;
    case 'chain-final': return `final on chain ${id(d.matchId)}`;
    case 'backstop': return `backstop ${d.what} ${id(d.matchId)} (seat ${d.seat})`;
    case 'tx': return `sent ${d.what} ${id(d.tx)}`;
    case 'tx-failed': return `${d.what} failed: ${d.reason}`;
    case 'gas-low': return `hot key low: ${d.balance} zkLTC ≈ ${d.matchesLeft} matches`;
    case 'witness': return `witness ${id(d.matchId)} ${d.ok ? 'agrees' : `DISAGREES (${d.reason})`}`;
    case 'dispute': return `placement dispute ${id(d.matchId)}`;
    case 'ruleset': return `ruleset ${d.rulesetId} @ ${id(d.buildHash, 10)}${d.current ? ' current' : ''}`;
    case 'stakes': return `standings read: ${d.bonded} bonded`;
    case 'bond': return `bond: ${d.active ? 'active' : 'none'}${d.eligible ? ', eligible' : ''}`;
    case 'tunnel': return `${d.which} tunnel ${d.state ?? (d.url ? 'up' : 'down')}${d.url ? ` ${d.url}` : ''}`;
    case 'announced': return `announced ${d.url}${d.wsAddr ? ` + relay` : ''} (tx ${id(d.tx, 10)})`;
    case 'update': return `release ${d.latest} available`;
    case 'incompatible': return `peer ${id(d.nodeId, 8)} on protocol ${d.protocol} excluded`;
    case 'peer.forgotten': return `forgot ${d.operator ?? id(d.nodeId, 8)} (silent 10 min)`;
    case 'seed-refused': return `seed ${d.url} refused: ${d.reason}`;
    case 'proposed': return `anchor proposed for epoch ${d.epoch}`;
    case 'enrolled': return 'enrolled in the witness pool';
    case 'restart': return 'restarting';
    default: return `${ev.type} ${JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 't' && k !== 'type'))).slice(0, 80)}`;
  }
}

export const ago = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86400_000).toFixed(1)} d`);

/** The operator's setup, one step at a time, from the verified document: each step's state and what clears it.
 *  `state`: ok | todo | warn | na. Pure: the page renders it, tests read it. */
export function checklist(f, { cabinetContracts = null } = {}) {
  const s = f.self, mb = f.chain.matchBook, ann = f.chain.announcer, purse = mb?.purse ?? null;
  const hot = ann?.address?.toLowerCase() ?? null;
  const delegate = s.bond?.delegate?.toLowerCase() ?? null;
  const steps = [];
  steps.push({ key: 'bonded', label: 'Bonded on NodeStake', state: s.bonded ? 'ok' : s.bonded === false ? 'todo' : 'warn',
    detail: s.bonded ? `${s.wallet ? `by ${s.wallet.slice(0, 6)}…${s.wallet.slice(-4)}` : 'yes'}${s.eligible ? ' · eligible for panels' : s.bond?.eligible === false ? ' · not yet eligible (age)' : ''}` : s.bonded === false ? 'the operator wallet bonds this node key (Operator panel below, or npm run bond -- <nodeId>)' : 'no stake contract configured or not read yet' });
  steps.push({ key: 'hotkey', label: 'Hot key set (delegate)', state: !s.bonded ? 'na' : delegate && hot && delegate === hot ? 'ok' : 'todo',
    detail: delegate && hot && delegate === hot ? `${hot.slice(0, 10)}… signs for this node` : !s.bonded ? 'after the bond' : delegate ? `delegate ${delegate.slice(0, 10)}… is not this node's key ${hot ? hot.slice(0, 10) + '…' : ''}` : 'Operator panel → Set hot key, or npm run delegate -- <nodeId> <address>' });
  steps.push({ key: 'funded', label: 'Hot key funded (zkLTC gas)', state: !purse ? 'na' : purse.balance == null ? 'warn' : Number(purse.balance) === 0 ? 'todo' : purse.low ? 'warn' : 'ok',
    detail: !purse ? 'no MatchBook configured' : purse.balance == null ? 'balance not read yet' : `${purse.balance} zkLTC ≈ ${purse.matchesLeft ?? '?'} matches as ${purse.perMatchRole ?? 'host'} at ${purse.gasPriceWei ? (Number(purse.gasPriceWei) / 1e9).toFixed(2) : '?'} gwei${purse.low ? ' — LOW: top up in the Hot key panel (one click, or the free faucet)' : ''}` });
  steps.push({ key: 'enrolled', label: 'Enrolled in the witness pool', state: !mb ? 'na' : mb.enrolled ? 'ok' : s.roles.includes('witness') ? (mb.delegated && mb.funded ? 'warn' : 'todo') : 'na',
    detail: !mb ? '' : mb.enrolled ? 'can be drawn for escalations' : s.roles.includes('witness') ? 'automatic once the hot key is delegated and funded (retried every 5 min)' : 'not a witness' });
  const tunnelUp = s.tunnel ? s.tunnel.state === 'up' : /^https:\/\//.test(s.addr ?? '');
  steps.push({ key: 'public', label: 'Public address verified', state: s.tunnel ? (s.tunnel.state === 'up' ? 'ok' : s.tunnel.state === 'verifying' ? 'warn' : 'todo') : /^https:\/\//.test(s.addr ?? '') ? 'ok' : 'na',
    // cloudflared logs a transient origin error and carries on: the last error matters only while the tunnel is not up
    detail: s.tunnel ? `${s.tunnel.mode} tunnel ${s.tunnel.state}${s.tunnel.url ? ` · ${s.tunnel.url}` : ''}${s.tunnel.lastError && s.tunnel.state !== 'up' ? ` · ${s.tunnel.lastError.slice(0, 120)}` : ''}` : /^https:\/\//.test(s.addr ?? '') ? s.addr : `LAN only (${s.addr}) — fine for a witness; a seed sets TUNNEL=quick in node.env` });
  if (s.relay) steps.push({ key: 'relay', label: 'Relay answers through its tunnel', state: s.relay.state === 'up' ? 'ok' : s.relay.state === 'verifying' ? 'warn' : s.relay.state === 'off' ? 'na' : 'todo',
    detail: `${s.relay.state}${s.relay.ms != null ? ` · ${s.relay.ms} ms` : ''}${s.relay.url ? ` · ${s.relay.url}` : ''}${s.relay.lastError ? ` · ${s.relay.lastError}` : ''}` });
  const entry = ann?.entry ?? null;
  const entryKnown = !!ann && 'entry' in ann; // the directory entry is reported by nodes from 0.11.15
  const announced = !!entry && entry.url === s.addr && (entry.wsAddr ?? null) === (s.wsAddr ?? null);
  steps.push({ key: 'announced', label: 'Announced on NodeDirectory', state: !ann ? 'na' : !tunnelUp && !/^https:\/\//.test(s.addr ?? '') ? 'na' : !entryKnown ? (ann.lastTx ? 'ok' : 'warn') : announced ? 'ok' : ann.lastError ? 'todo' : 'warn',
    detail: !ann ? 'no directory configured' : !entryKnown ? (ann.lastTx ? `last announce tx ${ann.lastTx.slice(0, 12)}… (the entry itself is reported by nodes from 0.11.15)` : 'no announce sent yet') : announced ? `${entry.url}${entry.wsAddr ? ' + relay' : ''} · ${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : ''}` : ann.lastError ? ann.lastError : entry ? `directory has ${entry.url}${entry.wsAddr ? ' + relay' : ''}; this node advertises ${s.addr}${s.wsAddr ? ' + relay' : ''} — the next announce is due` : 'not announced yet (needs a public address, a delegated and funded announcer key)' });
  if (cabinetContracts && f.chain.contracts) {
    const mine = cabinetContracts, theirs = f.chain.contracts;
    const skew = ['NodeStake', 'NodeDirectory', 'MatchBook'].filter((k) => mine[k]?.address && theirs[k] && mine[k].address.toLowerCase() !== theirs[k].toLowerCase());
    steps.push({ key: 'contracts', label: 'Same contract generation as this cabinet', state: skew.length ? 'todo' : 'ok', detail: skew.length ? `this cabinet and the node disagree on ${skew.join(', ')} — one of them is on an older release` : `generation ${theirs.generation ?? '?'}` });
  }
  return steps;
}
