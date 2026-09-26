/** Season Zero rewards as POINTS (docs/REWARDS.md): a pure fold over what the
 *  chain recorded, so every reader of the same logs computes the same totals.
 *    MatchBook      who was drawn to host and witness, who answered, how each match ended
 *    NodeStake      the operator wallet behind each node key; slashes
 *    TitleRegistry  who publishes each title
 *    PlayerProfile  which wallet owns each player key
 *    EpochAnchor    hourly root proposals (a node doing its job between matches)
 *  Nothing is paid: there is no rewards contract (BUILD-SPEC §16). These are
 *  the amounts a future claim root would carry.
 *
 *  The rules, all in `params` (contracts/deploy.testnet.json → Rewards):
 *    gate        an hour releases only while ≥ minActive operators (or nodes)
 *                did on-chain work in the trailing activeWindowH hours
 *    emission    pool left × ln2/(halfLifeDays·24) × m,  m = min(cap, 1 + 2√(Q̄/scale)),
 *                Q̄ = quality-weighted qualifying matches per hour, averaged over
 *                the trailing multiplier.trailingH hours; an hour with none releases nothing
 *    quality     repeat pairs decay (1, ½, ¼ …) to pairCapPerDay; playerCapPerDay; a
 *                player's distinct opponents over diversityWindowH scale the weight
 *    gas first   each duty's own gas (receipt gasUsed × price) is refunded before the split
 *    split       host 35 · witness 10 per agreeing seat · publisher 20 · guardian 15 (bps)
 *    reliability witness seats answered ÷ drawn (and settled hosts) over reliability.windowH,
 *                mapped smoothly between `zero` (×0) and `full` (×1); scales operator shares,
 *                not gas refunds
 *    forfeits    a slashed node's operator, and a lone dissenter on a match that
 *                voided, forfeit that ISO week (unless the match is in `waivers`)
 *
 *  Amounts are wei (BigInt) end to end. Everything an hour releases is either
 *  paid or rolled back into the pool: paid + rolledBack === released, always. */
import { rulesetIdBytes32 } from './matchbook.js';

export const WEI = 10n ** 18n;
const PPM = 1_000_000n, BPS = 10_000n, RATE_SCALE = 10n ** 12n;
const HOUR_S = 3600, DAY_S = 86_400;

export const DEFAULTS = Object.freeze({
  pool: '200',
  seasonStart: null,
  minActive: 10,
  countBy: 'operator',
  activeWindowH: 24,
  halfLifeDays: 180,
  multiplier: { cap: 3, scale: 400, trailingH: 24 },
  split: { host: 3500, witness: 1000, publisher: 2000, guardian: 1500 },
  quality: { pairCapPerDay: 5, playerCapPerDay: 30, diversityOpponents: 3, diversityWindowH: 168, requireProfiles: true },
  reliability: { windowH: 168, full: 0.9, zero: 0.5, lonelyDissentMisses: 2, lonelyDissentForfeit: true },
  allowlist: null,
  waivers: [],
});

/** The defaults with `overrides` merged in, checked. */
export function rewardParams(overrides = {}) {
  const o = overrides ?? {};
  const p = {
    ...DEFAULTS, ...o,
    multiplier: { ...DEFAULTS.multiplier, ...o.multiplier },
    split: { ...DEFAULTS.split, ...o.split },
    quality: { ...DEFAULTS.quality, ...o.quality },
    reliability: { ...DEFAULTS.reliability, ...o.reliability },
  };
  const s = p.split;
  if (s.host + 3 * s.witness + s.publisher + s.guardian !== 10_000) throw new Error('rewards split must total 10000 bps: host + 3 × witness + publisher + guardian');
  if (!['operator', 'node'].includes(p.countBy)) throw new Error('countBy is "operator" or "node"');
  if (!(Number.isInteger(p.minActive) && p.minActive >= 1)) throw new Error('minActive must be a whole number ≥ 1');
  if (!(p.reliability.full > p.reliability.zero)) throw new Error('reliability.full must exceed reliability.zero');
  if (!(p.halfLifeDays > 0 && p.multiplier.scale > 0 && p.multiplier.cap >= 1 && p.multiplier.trailingH >= 1)) throw new Error('halfLifeDays, multiplier.scale, multiplier.trailingH must be positive; multiplier.cap ≥ 1');
  toWei(p.pool);
  return p;
}

/** '200' or '0.5' zkLTC → wei. */
export function toWei(v) {
  const m = /^(\d+)(?:\.(\d{0,18}))?$/.exec(String(v).trim());
  if (!m) throw new Error(`not an amount: ${v}`);
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}
/** wei → '12.345678' (truncated, never rounded up). */
export function formatWei(w, digits = 6) {
  const v = BigInt(w), neg = v < 0n, a = neg ? -v : v;
  const frac = (a % WEI).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / WEI}${frac ? '.' + frac : ''}`;
}

/** Monday-based week number (the Unix epoch fell on a Thursday). */
export const weekOf = (ts) => Math.floor((Math.floor(ts / DAY_S) + 3) / 7);
const isZero = (a) => !a || /^0x0{40}$/.test(a);
const gasOf = (e) => BigInt(e.gasCost ?? 0);

/** The fold. `entries`: decoded logs from all five contracts, each
 *  { contract, event, block, logIndex, ts (seconds), tx, gasCost (wei), from, …fields }
 *  (protocol/rewards-chain.js builds them). Returns the hour-by-hour ledger,
 *  per-operator and per-publisher totals, and why matches did not count. */
export function computeRewards(entries, overrides = {}, { now = Date.now() } = {}) {
  const p = rewardParams(overrides), q = p.quality, rl = p.reliability;
  const log = entries.filter(Boolean).slice().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const waived = new Set((p.waivers ?? []).map((w) => String(w).replace(/^0x/, '').toLowerCase()));
  const allow = p.allowlist ? new Set(p.allowlist.map((a) => a.toLowerCase())) : null;

  // ---- 1. one pass in chain order: the state each event saw, and the match records
  const operatorOf = new Map(), nodeOfDelegate = new Map(), titleOfKey = new Map(), publisherOf = new Map(), tokenOfKey = new Map(), ownerOfToken = new Map();
  const matches = new Map(), activity = [], slashes = [];
  const opOf = (nodeKey) => operatorOf.get(nodeKey) ?? null;
  const ownerOfPlayer = (key) => { const t = tokenOfKey.get(key); const o = t == null ? null : ownerOfToken.get(t); return isZero(o) ? null : o; };
  // A finalize/expire is anyone's call: credit it only when the sender is a bonded node's delegate or operator.
  const callerOf = (from) => {
    if (!from) return { node: null, operator: null };
    const node = nodeOfDelegate.get(from);
    if (node) return { node, operator: opOf(node) };
    for (const [n, op] of operatorOf) if (op === from) return { node: n, operator: op };
    return { node: null, operator: null };
  };
  for (const e of log) {
    const ev = e.event;
    if (e.contract === 'NodeStake') {
      if (ev === 'Staked' || ev === 'OperatorTransferred') operatorOf.set(e.nodeKey, e.operator);
      else if (ev === 'DelegateSet') {
        for (const [d, n] of nodeOfDelegate) if (n === e.nodeKey) nodeOfDelegate.delete(d);
        if (!isZero(e.delegate)) nodeOfDelegate.set(e.delegate, e.nodeKey);
      } else if (ev === 'Slashed') slashes.push({ ts: e.ts, operator: opOf(e.nodeKey) });
      continue;
    }
    if (e.contract === 'TitleRegistry') {
      if (ev === 'Registered') { titleOfKey.set(rulesetIdBytes32(e.rulesetId), e.titleId); publisherOf.set(e.titleId, e.publisher); }
      else if (ev === 'Transfer') publisherOf.set(e.tokenId, e.to);
      continue;
    }
    if (e.contract === 'PlayerProfile') {
      if (ev === 'Transfer') ownerOfToken.set(e.tokenId, e.to);
      else if (ev === 'KeyBound') tokenOfKey.set(e.key, e.tokenId);
      else if (ev === 'KeyRevoked' && tokenOfKey.get(e.key) === e.tokenId) tokenOfKey.delete(e.key);
      continue;
    }
    if (e.contract === 'EpochAnchor') {
      if (ev === 'Proposed') activity.push({ ts: e.ts, node: e.nodeKey, operator: opOf(e.nodeKey) });
      continue;
    }
    if (e.contract !== 'MatchBook') continue;
    let m = matches.get(e.matchId);
    if (!m) matches.set(e.matchId, (m = { matchId: e.matchId, attests: [] }));
    switch (ev) {
      case 'Committed':
        Object.assign(m, { rulesetKey: e.rulesetKey, host: e.hostKey, hostOperator: opOf(e.hostKey), panel: e.panel, panelOperators: e.panel.map(opOf), commit: { ts: e.ts, gas: gasOf(e) } });
        activity.push({ ts: e.ts, node: e.hostKey, operator: m.hostOperator });
        break;
      case 'Settled':
        m.settle = { ts: e.ts, gas: gasOf(e), resultHash: e.resultHash, participants: e.participants, owners: e.participants.map(ownerOfPlayer) };
        m.host ??= e.hostKey; m.hostOperator ??= opOf(e.hostKey); m.rulesetKey ??= e.rulesetKey;
        activity.push({ ts: e.ts, node: e.hostKey, operator: opOf(e.hostKey) });
        break;
      case 'Attested':
        m.attests.push({ ts: e.ts, gas: gasOf(e), witness: e.witnessKey, operator: opOf(e.witnessKey), resultHash: e.resultHash, agrees: e.agrees, escalation: e.escalation });
        activity.push({ ts: e.ts, node: e.witnessKey, operator: opOf(e.witnessKey) });
        break;
      case 'Escalated':
        Object.assign(m, { escalationPanel: e.panel, escalationOperators: e.panel.map(opOf), escalatedTs: e.ts });
        break;
      case 'Finalized': {
        const caller = callerOf(e.from);
        const titleId = titleOfKey.get(e.rulesetKey ?? m.rulesetKey);
        const publisher = titleId == null ? null : publisherOf.get(titleId) ?? null;
        m.final = { ts: e.ts, gas: gasOf(e), status: e.status, finalHash: e.finalHash, caller: caller.operator, publisher: isZero(publisher) ? null : publisher };
        if (caller.operator) activity.push({ ts: e.ts, node: caller.node, operator: caller.operator });
        break;
      }
    }
  }

  // ---- 2. duties (reliability) and forfeits
  const duties = new Map(), forfeits = new Set();
  const duty = (operator, ts, drawn, answered) => { if (!operator) return; const l = duties.get(operator) ?? []; l.push({ ts, drawn, answered }); duties.set(operator, l); };
  for (const m of matches.values()) {
    // A placement that never settles is almost always players leaving; the chain cannot tell that from a host
    // outage, so it is not counted against the host (who simply earns nothing for it). Witness duties begin at
    // the settle, so a missing attest is unambiguous.
    if (m.settle) duty(m.hostOperator, m.settle.ts, 1, 1);
    if (m.settle && m.panel) {
      const regular = m.attests.filter((a) => !a.escalation);
      m.panel.forEach((key, i) => {
        const a = regular.find((x) => x.witness === key);
        const lone = a && !a.agrees && m.final?.status === 'void' && !waived.has(m.matchId)
          && regular.filter((x) => x.witness !== key && x.agrees).length >= 2;
        if (lone) {
          duty(m.panelOperators[i], m.settle.ts, rl.lonelyDissentMisses, 0);
          if (rl.lonelyDissentForfeit && m.panelOperators[i]) forfeits.add(`${m.panelOperators[i]}:${weekOf(a.ts)}`);
        } else duty(m.panelOperators[i], m.settle.ts, 1, a ? 1 : 0);
      });
    }
    if (m.escalationPanel) {
      const votes = m.attests.filter((a) => a.escalation);
      m.escalationPanel.forEach((key, i) => duty(m.escalationOperators[i], m.escalatedTs, 1, votes.some((a) => a.witness === key) ? 1 : 0));
    }
  }
  for (const s of slashes) if (s.operator) forfeits.add(`${s.operator}:${weekOf(s.ts)}`);
  const dutyStats = (op, since, until) => {
    let drawn = 0, answered = 0;
    for (const d of duties.get(op) ?? []) if (d.ts > since && d.ts <= until) { drawn += d.drawn; answered += d.answered; }
    return { drawn, answered };
  };
  /** ×1 at or above `full`, ×0 at or below `zero`, straight line between (ppm). No duties drawn: ×1. */
  const relMemo = new Map();
  const reliabilityPpm = (op, t) => {
    const key = `${op}:${t}`;
    if (relMemo.has(key)) return relMemo.get(key);
    const { drawn, answered } = dutyStats(op, t - rl.windowH * HOUR_S, t);
    const ppm = !drawn ? PPM : BigInt(Math.round(Math.min(1, Math.max(0, (answered / drawn - rl.zero) / (rl.full - rl.zero))) * 1e6));
    relMemo.set(key, ppm);
    return ppm;
  };

  // ---- 3. which finalized matches count, and how much each weighs
  const finals = [...matches.values()].filter((m) => m.final).sort((a, b) => a.final.ts - b.final.ts || (a.matchId < b.matchId ? -1 : 1));
  const excluded = {};
  const exclude = (m, why) => { m.excluded = why; excluded[why] = (excluded[why] ?? 0) + 1; };
  const pairCount = new Map(), playerCount = new Map(), opponents = new Map();
  for (const m of finals) {
    if (m.final.status !== 'final') { exclude(m, 'void'); continue; }
    if (!m.settle) { exclude(m, 'unsettled'); continue; }
    if (m.final.finalHash !== m.settle.resultHash) { exclude(m, 'host-overturned'); continue; }
    if (m.attests.filter((a) => !a.escalation && a.agrees).length < 2) { exclude(m, 'under-attested'); continue; }
    const players = m.settle.participants;
    if (players.length < 2) { exclude(m, 'solo'); continue; }
    if (q.requireProfiles && m.settle.owners.some((o) => !o)) { exclude(m, 'no-profile'); continue; }
    const seats = new Set([m.hostOperator, ...(m.panelOperators ?? [])].filter(Boolean));
    if (m.settle.owners.some((o) => o && seats.has(o))) { exclude(m, 'self-play'); continue; }
    const day = Math.floor(m.final.ts / DAY_S);
    const pairKey = `${day}:${[...players].sort().join(':')}`;
    const k = (pairCount.get(pairKey) ?? 0) + 1;
    pairCount.set(pairKey, k);
    const overPlayerCap = players.map((pl) => { const c = (playerCount.get(`${day}:${pl}`) ?? 0) + 1; playerCount.set(`${day}:${pl}`, c); return c > q.playerCapPerDay; }).some(Boolean);
    const since = m.final.ts - q.diversityWindowH * HOUR_S;
    for (const pl of players) { const l = opponents.get(pl) ?? []; for (const o of players) if (o !== pl) l.push({ ts: m.final.ts, o }); opponents.set(pl, l); }
    const diversity = Math.min(...players.map((pl) => Math.min(1, new Set(opponents.get(pl).filter((x) => x.ts > since).map((x) => x.o)).size / q.diversityOpponents)));
    const w = k > q.pairCapPerDay || overPlayerCap ? 0 : 2 ** -(k - 1) * diversity;
    m.weight = BigInt(Math.round(w * 1e6));
    if (m.weight === 0n) exclude(m, k > q.pairCapPerDay ? 'pair-cap' : 'player-cap');
    else m.qualifies = true;
  }

  // ---- 4. hour by hour: gate, emission, and the split of each qualifying match
  const nowS = Math.floor(now / 1000), endH = Math.floor(nowS / HOUR_S);
  const firstFinal = finals.find((m) => m.qualifies) ?? finals[0];
  const startH = p.seasonStart ? Math.floor(Date.parse(p.seasonStart) / 1000 / HOUR_S) : firstFinal ? Math.floor(firstFinal.final.ts / HOUR_S) : endH;
  const acts = activity.filter((a) => a.operator && (!allow || allow.has(a.operator))).sort((a, b) => a.ts - b.ts);
  /** Distinct operators (or nodes) with work in (t − activeWindowH, t]. A sliding window: call it with t never decreasing. */
  const activeWindow = () => {
    let lo = 0, hi = 0;
    const counts = new Map(), idOf = (a) => (p.countBy === 'node' ? a.node : a.operator);
    return (t) => {
      for (; hi < acts.length && acts[hi].ts <= t; hi++) { const id = idOf(acts[hi]); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
      for (const since = t - p.activeWindowH * HOUR_S; lo < hi && acts[lo].ts <= since; lo++) {
        const id = idOf(acts[lo]);
        if (id) { const n = counts.get(id) - 1; if (n) counts.set(id, n); else counts.delete(id); }
      }
      return counts.size;
    };
  };
  const activeAt = activeWindow();
  const byHour = new Map();
  for (const m of finals) if (m.qualifies) { const H = Math.floor(m.final.ts / HOUR_S); (byHour.get(H) ?? byHour.set(H, []).get(H)).push(m); }
  const qEffOf = (H) => (H < startH ? 0 : (byHour.get(H) ?? []).reduce((s, m) => s + Number(m.weight) / 1e6, 0));
  const r0 = Math.LN2 / (p.halfLifeDays * 24);
  const opRows = new Map(), pubRows = new Map();
  const row = (map, who, fields) => map.get(who) ?? map.set(who, { address: who, total: 0n, ...fields }).get(who);
  const eligible = (op, ts) => !!op && (!allow || allow.has(op)) && !forfeits.has(`${op}:${weekOf(ts)}`);

  /** Pays one match's allocation; returns what was paid (the rest rolls back). */
  const payMatch = (m, alloc, hourEnd) => {
    let paid = 0n;
    const credit = (map, who, field, amt, fields) => { if (amt <= 0n) return; const r = row(map, who, fields); r[field] += amt; r.total += amt; paid += amt; };
    const opCredit = (op, field, amt) => credit(opRows, op, field, amt, { gas: 0n, host: 0n, witness: 0n, guardian: 0n });
    const agreeing = m.attests.filter((a) => !a.escalation && a.agrees && m.panel?.includes(a.witness));
    const refunds = [
      { op: m.hostOperator, amt: (m.commit?.gas ?? 0n) + m.settle.gas },
      ...agreeing.map((a) => ({ op: a.operator, amt: a.gas })),
      { op: m.final.caller, amt: m.final.gas },
    ].filter((r) => r.op && r.amt > 0n);
    const gasTotal = refunds.reduce((s, r) => s + r.amt, 0n);
    for (const r of refunds) if (eligible(r.op, m.final.ts)) opCredit(r.op, 'gas', alloc < gasTotal ? alloc * r.amt / gasTotal : r.amt);
    if (alloc <= gasTotal) return paid;
    const profit = alloc - gasTotal, share = (bps) => profit * BigInt(bps) / BPS;
    const earn = (op, field, amt) => { if (eligible(op, m.final.ts)) opCredit(op, field, amt * reliabilityPpm(op, hourEnd) / PPM); };
    earn(m.hostOperator, 'host', share(p.split.host));
    for (const a of agreeing) earn(a.operator, 'witness', share(p.split.witness));
    const pub = share(p.split.publisher);
    if (m.final.publisher && pub > 0n) { credit(pubRows, m.final.publisher, 'publisher', pub, { publisher: 0n, matches: 0 }); pubRows.get(m.final.publisher).matches++; }
    // The guardian share: the escalation voters who sided with the final result, else whoever finalized it.
    const voters = m.escalationPanel ? m.attests.filter((a) => a.escalation && a.resultHash === m.final.finalHash && a.operator).map((a) => a.operator) : [];
    const guardians = voters.length ? voters : m.final.caller ? [m.final.caller] : [];
    for (const g of guardians) earn(g, 'guardian', share(p.split.guardian) / BigInt(guardians.length));
    return paid;
  };

  let pool = toWei(p.pool), released = 0n, paidTotal = 0n;
  const hours = [];
  for (let H = startH; H <= endH; H++) {
    const hourEnd = (H + 1) * HOUR_S, list = byHour.get(H) ?? [];
    const active = activeAt(Math.min(hourEnd, nowS));
    const gate = active >= p.minActive;
    const qEff = qEffOf(H);
    let trailing = 0;
    for (let h = H - p.multiplier.trailingH + 1; h <= H; h++) trailing += qEffOf(h);
    trailing /= p.multiplier.trailingH;
    const mult = qEff > 0 ? Math.min(p.multiplier.cap, 1 + 2 * Math.sqrt(trailing / p.multiplier.scale)) : 0;
    const rel = gate && qEff > 0 ? pool * BigInt(Math.round(r0 * mult * 1e12)) / RATE_SCALE : 0n;
    let paid = 0n;
    if (rel > 0n) {
      const W = list.reduce((s, m) => s + m.weight, 0n);
      for (const m of list) paid += payMatch(m, rel * m.weight / W, hourEnd);
    }
    pool -= paid;
    released += rel; paidTotal += paid;
    hours.push({ hour: H, at: new Date(H * HOUR_S * 1000).toISOString(), open: H === endH, active, gate, matches: list.length, qEff, trailing, m: mult, released: rel, paid, rolledBack: rel - paid, pool });
  }

  // Every operator with a duty is listed, earning or not: a paused season still shows who is doing the work.
  for (const op of duties.keys()) row(opRows, op, { gas: 0n, host: 0n, witness: 0n, guardian: 0n });
  const operators = [...opRows.values()].map((r) => {
    const all = dutyStats(r.address, -Infinity, nowS);
    return { ...r, duties: all, reliability: Number(reliabilityPpm(r.address, nowS)) / 1e6 };
  }).sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.address < b.address ? -1 : 1));
  const publishers = [...pubRows.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.address < b.address ? -1 : 1));
  const activeNow = activeWindow()(nowS);
  return {
    params: p,
    window: { from: startH, to: endH, fromAt: new Date(startH * HOUR_S * 1000).toISOString(), hours: hours.length },
    gate: { minActive: p.minActive, countBy: p.countBy, windowH: p.activeWindowH, activeNow, open: activeNow >= p.minActive },
    pool: { start: toWei(p.pool), left: pool },
    totals: { released, paid: paidTotal, rolledBack: released - paidTotal },
    hours, operators, publishers,
    matches: { finalized: finals.length, qualifying: finals.filter((m) => m.qualifies).length, excluded },
    forfeits: [...forfeits].sort(),
  };
}
