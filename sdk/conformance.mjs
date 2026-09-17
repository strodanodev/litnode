/** The conformance suite. A title that passes is a title the mesh will host;
 *  every node runs the same checks before it loads a ruleset, so passing
 *  here is not a courtesy — it is the gate.
 *
 *    node sdk/conformance.mjs rulesets/my-title.v1.js
 *
 *  Two stages, and the order is the point:
 *
 *   STATIC   — reads the text, executes nothing. Artifact shape (one module,
 *              no imports, a default export) and a purity LINT (Math.random,
 *              Date, fetch, timers…). The lint catches mistakes early with a
 *              clear message; it is not the security boundary — a bracket
 *              access or a computed name walks past any regex. A static
 *              failure ends the suite here: no title code has run anywhere.
 *   SANDBOX  — everything that executes runs in node/sandbox.js: a separate
 *              process under Node's permission model with an empty
 *              environment, no filesystem, no network globals, a memory
 *              ceiling and a deadline; inside it a V8 context with only
 *              ECMAScript intrinsics, minus Date, Intl, WeakRef and
 *              Math.random. A title that reaches for any of them fails at
 *              run time whatever the text looked like. Manifest, contract
 *              functions, two replays from scratch reaching the same
 *              serialize() root, scores keyed by participants, view().
 *
 *  What two replays prove: that this title, on these seeded inputs, is
 *  deterministic and bounded. They do not prove all-input determinism; the
 *  sandbox proves the title CANNOT read anything but its inputs, which is
 *  the property that matters. Pure: returns { ok, checks, stage }. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSandbox } from '../node/sandbox.js';

const PURITY = [/\bMath\.random\b/, /\bnew Date\b/, /\bDate\.now\b/, /\bperformance\.now\b/, /\bcrypto\b\s*\./, /\bfetch\s*\(/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\blocalStorage\b/, /\bprocess\.env\b/, /\brequire\s*\(/, /\bimport\s*\(/];
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/** Deterministic input frames for the smoke replay: a bitfield per side per tick. */
export function inputsFor(seed, participants, ticks) {
  let s = 0; for (let i = 0; i < seed.length; i++) s = (Math.imul(s, 31) + seed.charCodeAt(i)) >>> 0;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return Array.from({ length: ticks }, (_, k) => ({ k, inputs: participants.map(() => next() & 0x3f) }));
}

/** STATIC stage only: never executes anything. Exported so the node can
 *  refuse before it even hands the bytes to the sandbox. */
export function staticCheck(source) {
  const checks = [];
  const add = (name, ok, detail = '', { warn = false } = {}) => { checks.push({ name, ok, detail, warn, stage: 'static' }); return ok; };
  const body = stripComments(String(source ?? ''));
  add('artifact: non-empty text', body.trim().length > 0 && source.length < 4 << 20, source.length >= 4 << 20 ? 'artifact over 4 MB' : '');
  const hasImport = /^\s*import\s[\s\S]*?from\s*['"]/m.test(body) || /^\s*import\s*['"]/m.test(body);
  add('artifact: single module, no imports', !hasImport, hasImport ? 'bundle the title into one file (tools/bundle-title.mjs)' : '');
  const hasDefault = /export\s+default\b/.test(body) || /export\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(body); // esbuild writes `export { x as default }`
  add('artifact: default export', hasDefault, hasDefault ? '' : 'export default defineTitle({...})');
  const dirty = PURITY.filter((re) => re.test(body)).map((re) => re.source);
  add('purity (lint): no clock, randomness, network, storage or loaders', dirty.length === 0, dirty.length ? `found ${dirty.join(', ')} — use the seed and seededRandom(); the sandbox removes these anyway` : '');
  return { ok: checks.every((c) => c.ok || c.warn), checks };
}

/** Run the suite over ruleset SOURCE (a string). Nothing executes in this
 *  process; `sandbox` (node/sandbox.js) is where the title runs. */
export async function check(source, { ticks = 240, sandbox = null, timeoutMs = 20_000 } = {}) {
  const st = staticCheck(source);
  const checks = [...st.checks];
  const add = (name, ok, detail = '', { warn = false } = {}) => { checks.push({ name, ok, detail, warn, stage: 'sandbox' }); return ok; };
  let man = null;
  const result = (ok, stage) => ({ ok, stage, checks, manifest: man?.manifest ?? null, fns: man?.fns ?? null });
  if (!st.ok) return result(false, 'static');

  const sb = sandbox ?? createSandbox({ timeoutMs });
  try { man = await sb.one(source, { kind: 'manifest' }, { timeoutMs }); }
  catch (e) { add('sandbox: loads with no host capabilities', false, e.message); return result(false, 'sandbox'); }
  add('sandbox: loads with no host capabilities', true);
  const m = man.manifest;
  if (!m) { add('manifest: present', false, 'default export has no manifest — use defineTitle / defineAttestedTitle'); return result(false, 'sandbox'); }
  add('manifest: present', true);

  // manifest
  add('manifest: rulesetId like "name.v1"', /^[a-z0-9][a-z0-9-]*\.v\d+$/.test(m.rulesetId ?? ''), `got ${JSON.stringify(m.rulesetId)}`);
  add('manifest: kind', m.kind === 'replayable' || m.kind === 'attested', `got ${m.kind}`);
  const modesOk = Array.isArray(m.modes) && m.modes.length > 0 && m.modes.every((x) => ['ranked', 'casual'].includes(x));
  add('manifest: modes ⊆ {ranked, casual}', modesOk, `got ${JSON.stringify(m.modes)}`);
  const svc = m.services ?? {};
  add('manifest: services shapes', (svc.leaderboard == null || svc.leaderboard.kind === 'elo') && (svc.credits == null || (svc.credits.kind === 'pot' && typeof svc.credits.currency === 'string')), JSON.stringify(svc));
  add('manifest: display for the arcade', !!(m.display && typeof m.display.title === 'string' && m.display.title.length), 'display: { title, url?, description?, cover? } — how the arcade lists it (warning: hosting works without it)', { warn: true });
  if (m.kind === 'replayable') {
    add('manifest: tickRate > 0', Number.isInteger(m.tickRate) && m.tickRate > 0, `got ${m.tickRate}`);
    add('manifest: maxTicks > 0', Number.isInteger(m.maxTicks) && m.maxTicks > 0, `got ${m.maxTicks}`);
    const pOk = Number.isInteger(m.participants) ? m.participants >= 1 : Array.isArray(m.participants) && m.participants.every((n) => Number.isInteger(n) && n >= 1);
    add('manifest: participants', pOk, `got ${JSON.stringify(m.participants)}`);
    add('manifest: inputSchema', typeof m.inputSchema === 'string' && m.inputSchema.length > 0, `got ${JSON.stringify(m.inputSchema)}`);
    for (const fn of ['init', 'step', 'done', 'serialize', 'view', 'scores']) add(`contract: ${fn}()`, man.fns[fn] === true);
    if (checks.some((c) => !c.ok && !c.warn)) return result(false, 'sandbox');

    // determinism: two runs from scratch in two fresh contexts, same root
    const n = Number.isInteger(m.participants) ? m.participants : m.participants[0];
    const participants = Array.from({ length: n }, (_, i) => `p${i}`.padEnd(64, `${i}`));
    const seed = 'ab'.repeat(32);
    const ctx = { agents: Object.fromEntries(participants.map((p) => [p, { tokenId: p.slice(0, 8), stats: { strength: 32768, agility: 32768, resilience: 32768, intelligence: 32768 }, manifest: null, equipped: {}, controller: null }])) };
    const job = { kind: 'replay', seed, participants, ctx, entries: inputsFor(seed, participants, ticks), view: true };
    let a, b;
    try { [a, b] = await sb.run(source, [job, { ...job, view: false }], { timeoutMs }); } catch (e) { add('determinism: runs inside the limits', false, e.message); return result(false, 'sandbox'); }
    if (!a.ok || !b.ok) { add('determinism: runs inside the limits', false, a.error ?? b.error); return result(false, 'sandbox'); }
    add('determinism: runs inside the limits', true, `${a.result.ticks} ticks, ${a.ms} ms`);
    add('determinism: same root twice', a.result.serialized === b.result.serialized, a.result.serialized === b.result.serialized ? '' : 'serialize() differs between two identical runs');
    add('determinism: serialize is JSON', (() => { try { JSON.parse(a.result.serialized); return true; } catch { return false; } })());
    add('contract: done() returns a boolean', a.result.doneType === 'boolean');
    const sc = a.result.scores;
    add('contract: scores() keyed by participants', !!sc && participants.every((p) => typeof sc[p] === 'number'), JSON.stringify(sc)?.slice(0, 80));
    add('contract: view() does not throw', !a.result.viewError, a.result.viewError ?? '');
    add('contract: view() is not the whole state', a.result.view !== a.result.serialized || a.result.serialized === '{}', 'hidden information must be filtered node-side');
  } else {
    for (const fn of ['validate', 'scores']) add(`contract: ${fn}()`, man.fns[fn] === true);
    add('manifest: participants list', Array.isArray(m.participants) && m.participants.every((x) => Number.isInteger(x) && x >= 1), JSON.stringify(m.participants));
    add('manifest: teams', Number.isInteger(m.teams) && m.teams >= 1, `got ${m.teams}`);
    add('manifest: attestors (authorized courts)', Array.isArray(m.attestors) && m.attestors.length > 0 && m.attestors.every((k) => /^[0-9a-f]{64}$/.test(k)), 'attestors: [<ed25519 pubkey hex>] — which courts may sign reports (warning: a node may also configure courts)', { warn: true });
    if (man.fns.validate) {
      let r;
      try { r = (await sb.one(source, { kind: 'attested', report: {} }, { timeoutMs })).validate; } catch (e) { r = `threw: ${e.message}`; }
      add('contract: validate({}) rejects with a reason', typeof r === 'string' && r.length > 0, `got ${JSON.stringify(r)}`);
    }
  }
  return result(checks.every((c) => c.ok || c.warn), 'sandbox');
}

export const checkFile = (path, opts) => check(readFileSync(path, 'utf8'), opts);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node sdk/conformance.mjs <title.mjs | ruleset.js>'); process.exit(2); }
  let source = readFileSync(file, 'utf8');
  // Unbundled source (imports the SDK): check the artifact it WOULD become.
  const { needsBundle, bundleTitle } = await import('./bundle.mjs');
  if (needsBundle(source)) { source = await bundleTitle(file); console.log(`(bundled ${file} in memory — ${source.length} bytes; tools/bundle-title.mjs writes it)`); }
  const r = await check(source);
  for (const c of r.checks) console.log(`${c.ok ? '  ok ' : c.warn ? 'warn ' : 'FAIL '} [${c.stage}] ${c.name}${c.detail && !c.ok ? `  — ${c.detail}` : ''}`);
  console.log(r.ok ? `\n${file}: conformant — a bonded node will host it` : `\n${file}: NOT conformant (${r.stage} stage) — no node will load it`);
  process.exit(r.ok ? 0 : 1);
}
