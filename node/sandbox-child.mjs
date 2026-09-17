/** The title sandbox, child side. Runs under `node --permission` with an
 *  empty environment; the parent (node/sandbox.js) passes THIS file's text as
 *  `-e` so nothing on disk needs to be readable, pipes one job batch over
 *  stdin, reads JSON lines from stdout and kills the process on a deadline.
 *
 *  Inside, every job gets a fresh V8 context (`vm.createContext`) with only
 *  ECMAScript intrinsics: no process, no require, no timers, no fetch, no
 *  console. Code generation from strings is off (no eval / Function). Data
 *  crosses the boundary as JSON text only, so no host object — and no host
 *  realm's Function constructor — is ever reachable from title code. Then
 *  the intrinsics a replay must not have are removed from the context:
 *  Date, Intl, WeakRef, FinalizationRegistry, Math.random.
 *
 *  What this is: an isolated runtime with an enforceable wall clock (parent
 *  kill), memory ceiling (--max-old-space-size), no filesystem, no child
 *  processes, no native addons (permission model) and no network API
 *  (removed below; the permission model does not cover sockets, so every
 *  network-capable global and process.getBuiltinModule are deleted before
 *  any title text is parsed). What it is not: a VM-escape-proof jail — a V8
 *  bug is out of scope, which is why builds still come from trusted
 *  publishers by default (node/litnode.js TITLE_TRUST). */
import vm from 'node:vm';

const write = process.stdout.write.bind(process.stdout);
const emit = (obj) => write(JSON.stringify(obj) + '\n');

// ---- scrub the child realm before any title text is looked at ------------
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator', 'Response', 'Request', 'Headers', 'FormData', 'Blob', 'File', 'crypto', 'performance']) { try { delete globalThis[k]; } catch { /* non-configurable: fall through */ } try { globalThis[k] = undefined; } catch { /* ignore */ } }
for (const k of ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'openStdin', 'chdir', 'kill', 'abort', 'setuid', 'setgid', 'umask']) { try { process[k] = undefined; } catch { /* ignore */ } }
try { process.env = Object.freeze({}); } catch { /* ignore */ }

// ---- ESM → script: the artifact is one module with no imports ------------
function toScript(source) {
  let s = source.replace(/\/\/# sourceMappingURL=.*$/m, '');
  // export { a as b, c };  (esbuild's form, possibly several)
  s = s.replace(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm, (_, list) => list.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(\S+)\s+as\s+(\S+)$/.exec(x);
    return m ? `__exports[${JSON.stringify(m[2])}] = ${m[1]};` : `__exports[${JSON.stringify(x)}] = ${x};`;
  }).join('\n'));
  // export default <expr>
  s = s.replace(/^\s*export\s+default\s+/gm, '__exports.default = ');
  // export const|let|var|function|class NAME
  const names = [];
  s = s.replace(/^\s*export\s+(const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, name) => { names.push(name); return `${kw} ${name}`; });
  s += '\n' + names.map((n) => `__exports[${JSON.stringify(n)}] = ${n};`).join('\n');
  if (/^\s*(import\s|export\s)/m.test(s)) throw new Error('unsupported import/export form in artifact');
  return `(function (__exports) {\n${s}\n})`;
}

// The context has ECMAScript intrinsics only. TextEncoder/TextDecoder are
// host globals, so a deterministic pure-JS UTF-8 pair is defined INSIDE the
// context (a host instance would leak the host realm's prototype chain).
const PRELUDE = `
  Math.random = function random() { throw new Error('Math.random is not available in the title sandbox'); };
  Object.freeze(Math);
  for (const k of ['Date', 'Intl', 'WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function']) { try { delete globalThis[k]; } catch (e) {} try { globalThis[k] = undefined; } catch (e) {} }
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(str = '') {
      str = String(str); const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) { const d = str.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return Uint8Array.from(out);
    }
  };
  globalThis.TextDecoder = class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(bytes = new Uint8Array()) {
      let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes);
      for (let i = 0; i < b.length;) {
        const x = b[i++]; let c;
        if (x < 0x80) c = x;
        else if (x < 0xe0) c = ((x & 31) << 6) | (b[i++] & 63);
        else if (x < 0xf0) c = ((x & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else { c = ((x & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63); }
        s += c > 0xffff ? String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 1023)) : String.fromCharCode(c);
      }
      return s;
    }
  };
`;

function freshContext() {
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  vm.runInContext(PRELUDE, ctx, { timeout: 1000 });
  return ctx;
}

/** Evaluate the module in a fresh context; returns its exports object (a context-realm object). */
function evaluate(source, ctx, timeout) {
  const fn = vm.runInContext(toScript(source), ctx, { timeout, filename: 'ruleset.js' });
  const exports = vm.runInContext('({})', ctx);
  fn.call(undefined, exports);
  return exports;
}
/** Parse JSON INSIDE the context so the resulting objects belong to the sandbox realm. */
const intoCtx = (ctx, value) => vm.runInContext(`(${JSON.stringify(value === undefined ? null : value)})`, ctx);
const outOfCtx = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

function manifestJob(exports) {
  const title = exports.default;
  const fns = {};
  for (const f of ['init', 'step', 'done', 'serialize', 'view', 'scores', 'validate']) fns[f] = typeof title?.[f] === 'function';
  return { manifest: outOfCtx(title?.manifest ?? null), fns, exports: Object.keys(exports), hasEngineHash: typeof exports.engine?.stateHash === 'function' };
}

function replayJob(exports, ctx, job) {
  const title = exports.default;
  const participants = intoCtx(ctx, job.participants);
  const [a, b] = job.participants;
  let state = title.init(job.seed, participants, intoCtx(ctx, job.ctx ?? {}));
  const entries = intoCtx(ctx, job.entries ?? []);
  const mkFrame = vm.runInContext('(function () { return {}; })', ctx);
  const max = job.maxTicks ?? entries.length;
  let t = 0;
  for (; t < entries.length && t < max && !title.done(state); t++) {
    const e = entries[t];
    const frame = mkFrame();
    frame[a] = e.inputs[0]; frame[b] = e.inputs[1];
    state = title.step(state, frame) ?? state;
  }
  const done = title.done(state);
  const out = { ticks: t, done: done === true, doneType: typeof done, serialized: JSON.stringify(outOfCtx(title.serialize(state))), scores: outOfCtx(title.scores(state)) };
  if (job.view) { try { out.view = JSON.stringify(outOfCtx(title.view(state))); } catch (e) { out.viewError = String(e.message ?? e); } }
  if (typeof exports.engine?.stateHash === 'function') out.engineHash = outOfCtx(exports.engine.stateHash(state));
  return out;
}

function attestedJob(exports, ctx, job) {
  const title = exports.default;
  const report = intoCtx(ctx, job.report);
  const bad = title.validate(report);
  const out = { validate: bad == null ? null : String(bad) };
  if (bad == null && job.participants) out.scores = outOfCtx(title.scores(report, intoCtx(ctx, job.participants), intoCtx(ctx, job.teams ?? null)));
  return out;
}

// ---- main ------------------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let batch;
  try { batch = JSON.parse(input); } catch (e) { emit({ fatal: `bad batch: ${e.message}` }); process.exit(2); }
  const { source, jobs = [], evalTimeoutMs = 5000 } = batch;
  for (const job of jobs) {
    const t0 = Date.now();
    try {
      const ctx = freshContext();
      const exports = evaluate(source, ctx, evalTimeoutMs);
      let result;
      if (job.kind === 'manifest') result = manifestJob(exports);
      else if (job.kind === 'replay') result = replayJob(exports, ctx, job);
      else if (job.kind === 'attested') result = attestedJob(exports, ctx, job);
      else throw new Error(`unknown job ${job.kind}`);
      emit({ id: job.id, ok: true, ms: Date.now() - t0, result });
    } catch (e) {
      emit({ id: job.id, ok: false, ms: Date.now() - t0, error: String(e && e.message ? e.message : e).slice(0, 500) });
    }
  }
  process.exit(0);
});
