#!/usr/bin/env node
/** litnode bridge — settle matches from a game that already runs on its
 *  own backend. Non-interactive, idempotent, `--json` for one object on
 *  stdout; exit 0 ok · 1 error · 2 needs something from the operator.
 *
 *    npm run bridge -- assess --input-log yes|no --deterministic yes|no [--engine-open yes|no]
 *                                        which kind of title yours is, and the plan
 *    npm run bridge -- key [--file ~/.litnode/bridge-key.json] [--kind replayable|attested --ruleset id.v1]
 *                                        create/print the bridge key and the node.env line that authorizes it
 *    npm run bridge -- submit <submission.json> [--node http://127.0.0.1:7801]
 *                                        sign one unsigned submission and settle it
 *    npm run bridge -- watch --adapter jsonl|http|agent-fighter|./my-adapter.mjs --source <file|url>
 *                     [--kind …] [--ruleset …] [--node …] [--poll 5000] [--once] [--state <file>]
 *                                        follow your backend and settle each finished match
 *    npm run bridge -- backfill --adapter … --source …   the same, from the beginning, until caught up
 *    npm run bridge -- serve [--port 8480] [--host 127.0.0.1] [--node …] [--ruleset …] [--kind …]
 *                                        HTTP intake: your server POSTs /submit with BRIDGE_TOKEN
 *    npm run bridge -- check <matchId> [--node …]      what the mesh made of a match, in words
 *    npm run bridge -- resolve [--ruleset id.v1]       the live node NodeDirectory names for this title (also: --node auto anywhere)
 *    npm run bridge -- body <submission.json>          the body each player signs (for your client)
 *
 *  BRIDGE_TOKEN (serve) and the adapter's source secrets come from the
 *  environment. The bridge key is an ed25519 identity, not a wallet. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_KEY_FILE, loadOrCreateKey, nodeEnvLine, prepare, submit, check, createBridge, loadAdapter, createIntake, playerBody, validateReplayable, validateAttested, resolveNode } from './index.mjs';

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { rest.push(a); continue; }
  const [k, inline] = a.slice(2).split('=');
  const next = argv[i + 1];
  if (inline != null) flags[k] = inline;
  else if (next != null && !next.startsWith('--')) { flags[k] = next; i++; }
  else flags[k] = true;
}
const cmd = rest[0] ?? 'help';
const positional = rest.slice(1);
const JSON_OUT = !!flags.json;
const out = (obj, lines) => { if (JSON_OUT) console.log(JSON.stringify(obj, null, 2)); else for (const l of [].concat(lines ?? [])) console.log(l); };
class Exit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
// Never process.exit() after a fetch: with keep-alive sockets open, Node on
// Windows aborts in libuv (async.c UV_HANDLE_CLOSING). Set exitCode and drain.
const exit = (code) => { process.exitCode = code; throw new Exit(code); };
const fail = (code, message, extra = {}) => { out({ ok: false, error: message, ...extra }, `error: ${message}`); exit(code); };
// --node auto (or LITNODE_URL=auto): find a live node hosting --ruleset through
// NodeDirectory on chain, so nothing is pinned to a tunnel hostname that rotates.
let resolved = null;
const nodeUrl = () => resolved ?? String(flags.node ?? process.env.LITNODE_URL ?? 'http://127.0.0.1:7801').replace(/\/+$/, '');
const resolveIfAuto = async () => { if ((flags.node ?? process.env.LITNODE_URL) === 'auto') { const r = await resolveNode({ rulesetId: flags.ruleset ?? null, log }); resolved = r.url; return r; } return null; };
const keyFile = () => resolve(String(flags.file ?? process.env.BRIDGE_KEY_FILE ?? DEFAULT_KEY_FILE));
const log = (m) => { if (!JSON_OUT) console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
const readJson = (p) => { if (!p || !existsSync(p)) fail(1, `file not found: ${p}`); try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(1, `${p}: ${e.message}`); } };
const adapterOptions = () => ({ source: flags.source ?? process.env.BRIDGE_SOURCE, kind: flags.kind, rulesetId: flags.ruleset, sourceToken: process.env.BRIDGE_SOURCE_TOKEN, afRoot: flags['af-root'] ?? process.env.AF_ROOT });

const commands = {
  async resolve() {
    const r = await resolveNode({ rulesetId: flags.ruleset ?? null, log });
    out({ ok: true, ...r }, [`${r.url} · node ${r.nodeId} · operator ${r.operator} · announced ${new Date(r.updatedAt * 1000).toISOString()} (${r.candidates} candidate(s))`]);
  },

  async help() { out({ commands: Object.keys(commands) }, readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^ \*\s?/, ''))); },

  async assess() {
    const yes = (v) => String(v ?? '').toLowerCase().startsWith('y');
    if (!('input-log' in flags) || !('deterministic' in flags)) fail(2, 'answer --input-log yes|no and --deterministic yes|no (and --engine-open yes|no if you know)', { questions: ['input-log: does your server keep every player input per tick (or per frame) for the whole match?', 'deterministic: does re-running those inputs from the same seed reproduce the same result, on any machine (integer or seeded math, no wall clock, no float physics)?', 'engine-open: can the simulation be bundled as one ES module with no imports (no closed engine, no native code)?'] });
    const inputLog = yes(flags['input-log']), det = yes(flags.deterministic), open = 'engine-open' in flags ? yes(flags['engine-open']) : null;
    const replayable = inputLog && det && open !== false;
    const plan = replayable
      ? ['kind: REPLAYABLE (defineTitle). Witnesses re-run your log; results can be OFFICIAL.', 'ruleset: port step()/init()/done()/serialize()/scores() into titles/<id>.mjs (host-a-title skill) and bundle it — the node replays YOUR sim, so the bundle must be the engine you run.', 'bridge: after each match, post { matchId, rulesetId, buildHash, mode, participants, entries:[{k,inputs}], expected? } — via `serve` (webhook) or `watch` (poll).', 'official results: have both clients sign the ledger body (`bridge body`) — through the cabinet shell (cabinet:sign) when launched from the arcade; otherwise the relay key labels results `relay` (authenticated, unofficial).', 'node: RELAY_KEYS=<bridge key> in node.env; restart; `bridge check <matchId>`.']
      : ['kind: ATTESTED (defineAttestedTitle). Your server is the court; results settle labelled `attested` (trusted, not verified) and never OFFICIAL until the title becomes replayable.', 'ruleset: write validate(report) and scores(report, participants, teams) in titles/<id>.mjs — the rules a node CAN check (score bounds, win condition, seat counts); bundle it.', 'bridge: after each match, post { kind:"attested", matchId, rulesetId, mode, participants, teams, report } — via `serve` or `watch`.', 'node: COURTS=<rulesetId>:<bridge key> in node.env (or attestors in the manifest); restart; `bridge check <matchId>`.', ...(inputLog && !det ? ['path to replayable: seed your randomness, integer math or fixed-point physics, and the same log becomes verifiable — a new build hash, no migration of old results.'] : !inputLog ? ['path to replayable: record per-tick inputs on the server first; without a log nothing can be re-run.'] : [])];
    out({ ok: true, kind: replayable ? 'replayable' : 'attested', inputLog, deterministic: det, engineOpen: open, plan }, [`kind: ${replayable ? 'replayable' : 'attested'}`, ...plan.map((p) => `- ${p}`)]);
  },

  async key() {
    const kp = await loadOrCreateKey(keyFile());
    const kind = flags.kind ?? 'replayable', rid = flags.ruleset ?? '<rulesetId>';
    const line = nodeEnvLine(kind, rid, kp.publicKey);
    out({ ok: true, publicKey: kp.publicKey, file: keyFile(), kind, nodeEnv: line }, [`bridge key ${kp.publicKey}`, `file      ${keyFile()}  (private; never share it)`, `node.env  ${line}   ← the node operator adds this and restarts; until then the node settles nothing this key signs as ${kind === 'attested' ? 'a court' : 'a relay'}`]);
  },

  async body() {
    const sub = readJson(positional[0]);
    const errs = validateReplayable(sub);
    if (errs.length) fail(1, errs.join('; '), { errors: errs });
    const body = playerBody(sub);
    out({ ok: true, body, tag: 'ledger', how: "sign('ledger', body, playerPrivateKey) → signatures[playerId]; or in the arcade: postMessage({type:'cabinet:sign', body}) → cabinet:signed" }, [JSON.stringify(body), "each player signs this with tag 'ledger' (protocol/keys.js sign) — in the arcade, cabinet:sign does it for them"]);
  },

  async submit() {
    const sub = readJson(positional[0]);
    const kp = await loadOrCreateKey(keyFile());
    let signed; try { signed = await prepare(sub, kp); } catch (e) { fail(1, e.message); }
    const r = await submit(nodeUrl(), signed);
    const c = r.status !== 'refused' ? await check(nodeUrl(), r.matchId) : null;
    out({ ok: r.status !== 'refused', ...r, delta: undefined, check: c }, [`${r.matchId}: ${r.status}${r.error ? ` — ${r.error}` : ''}`, ...(c ? [c.verdict] : []), ...(r.status === 'refused' && /not a relay this host trusts|not an authorized court/.test(r.error ?? '') ? [`fix: add \`${nodeEnvLine(signed.kind === 'attested' ? 'attested' : 'replayable', signed.rulesetId, kp.publicKey)}\` to the node's node.env and restart it`] : [])]);
    if (r.status === 'refused') process.exitCode = 1;
  },

  async watch() { return runWatch(false); },
  async backfill() { return runWatch(true); },

  async serve() {
    const token = process.env.BRIDGE_TOKEN;
    if (!token) fail(2, 'set BRIDGE_TOKEN (≥16 chars) in the environment; your backend sends it as `authorization: Bearer <token>`', { needs: ['BRIDGE_TOKEN'] });
    const kp = await loadOrCreateKey(keyFile());
    const intake = createIntake({ nodeUrl: nodeUrl(), key: kp, token, host: flags.host ?? '127.0.0.1', port: Number(flags.port ?? 8480), rulesetId: flags.ruleset ?? null, kind: flags.kind ?? null, log });
    const addr = await intake.listen();
    out({ ok: true, listening: `http://${addr.address}:${addr.port}`, node: nodeUrl(), publicKey: kp.publicKey }, [`bridge intake on http://${addr.address}:${addr.port}/submit → ${nodeUrl()}`, `POST a submission with 'authorization: Bearer $BRIDGE_TOKEN'; GET /check/<matchId>; GET /health`, `bridge key ${kp.publicKey} — the node needs ${nodeEnvLine(flags.kind ?? 'replayable', flags.ruleset ?? '<rulesetId>', kp.publicKey)}`]);
    await new Promise(() => {});
  },

  async check() {
    if (!positional[0]) fail(1, 'usage: check <matchId>');
    const c = await check(nodeUrl(), positional[0]);
    out({ ok: c.found, ...c }, c.found ? [`${c.matchId}: ${c.verdict}`, `mode ${c.mode} · attestation ${c.attestation} · placed ${c.placed} · cosigners ${c.cosigners} · disputes ${c.disputes}${c.proof ? ` · proof ${c.proof.status}` : ''}`, `scores ${JSON.stringify(c.scores)}`] : [`${c.matchId}: ${c.verdict}`]);
    process.exitCode = c.found ? 0 : 1;
  },
};

async function runWatch(backfill) {
  if (!flags.adapter) fail(1, '--adapter jsonl|http|agent-fighter|./path.mjs required');
  const adapter = await loadAdapter(String(flags.adapter)).catch((e) => fail(1, e.message));
  const kp = await loadOrCreateKey(keyFile());
  const name = String(flags.adapter).replace(/[^a-z0-9]+/gi, '-');
  const stateFile = resolve(String(flags.state ?? join(homedir(), '.litnode', `bridge-${name}.json`)));
  if (backfill && existsSync(stateFile) && !flags.keep) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ cursor: flags.cursor ?? null, seen: {} }) + '\n'); }
  const bridge = createBridge({ nodeUrl: nodeUrl(), key: kp, adapter, stateFile, pollMs: Number(flags.poll ?? 5000), log, adapterOptions: adapterOptions() });
  log(`bridge ${kp.publicKey.slice(0, 12)}… ${adapter.kind} ${flags.ruleset ?? adapter.rulesetId} via ${flags.adapter} → ${nodeUrl()} (state ${stateFile})`);
  if (backfill || flags.once) {
    let total = [];
    for (;;) { const did = await bridge.once(); total = total.concat(did); if (!did.length || flags.once) break; }
    const counts = total.reduce((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {});
    out({ ok: !total.some((d) => d.status === 'error'), did: total, counts, cursor: bridge.state.cursor }, [`done: ${JSON.stringify(counts)}`]);
    return;
  }
  bridge.start();
  await new Promise((res) => { const stop = () => { bridge.stop(); res(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); });
}

if (!commands[cmd]) fail(1, `unknown command "${cmd}"; commands: ${Object.keys(commands).join(', ')}`);
try { if (!['resolve', 'key', 'assess', 'body', 'help'].includes(cmd)) await resolveIfAuto(); await commands[cmd](); } catch (e) { if (!(e instanceof Exit)) { out({ ok: false, error: e.message, stack: e.stack }, `error: ${e.message}`); process.exitCode = 1; } }
