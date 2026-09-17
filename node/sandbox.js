/** The title sandbox, parent side. Every piece of title code the node ever
 *  runs — manifest extraction, the conformance replays, settlement replays,
 *  witness replays, attested-report validation — runs in a separate Node
 *  process started with the permission model on, an empty environment, a
 *  memory ceiling and a deadline. The node process itself never imports,
 *  evaluates or calls a ruleset. See node/sandbox-child.mjs for what the
 *  child removes before it parses the artifact.
 *
 *  Limits are enforceable, not advisory: memory by V8 (`--max-old-space-size`,
 *  the child aborts), wall clock by the parent (kill on deadline), CPU by the
 *  same kill (one thread), filesystem / child processes / addons by the
 *  permission model, network by removal of every network-capable global.
 *
 *  Fail closed: a runtime whose `--permission` flag is unknown cannot host
 *  titles; there is no in-process fallback. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHILD_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sandbox-child.mjs'), 'utf8');

/** The permission flag this runtime knows, or null (→ refuse to run titles). */
export function permissionFlag(exec = process.execPath) {
  const flags = process.allowedNodeEnvironmentFlags;
  if (exec === process.execPath && flags) {
    if (flags.has('--permission')) return '--permission';
    if (flags.has('--experimental-permission')) return '--experimental-permission';
    return null;
  }
  return '--permission';
}

export const DEFAULTS = { timeoutMs: 10_000, memoryMb: 256, maxOutputBytes: 8 << 20 };

/** @returns { run(source, jobs, opts) → [{ id, ok, ms, result | error }], status() } */
export function createSandbox({ node = process.execPath, timeoutMs = DEFAULTS.timeoutMs, memoryMb = DEFAULTS.memoryMb, log = () => {} } = {}) {
  const flag = permissionFlag(node);
  const stats = { runs: 0, killed: 0, failed: 0, msTotal: 0, lastMs: null };

  const run = (source, jobs, { timeoutMs: t = timeoutMs, memoryMb: m = memoryMb } = {}) => new Promise((resolve, reject) => {
    if (!flag) return reject(new Error('this Node runtime has no permission model (--permission): titles cannot be sandboxed, refusing to run them'));
    jobs = jobs.map((j, i) => ({ id: i, ...j }));
    const t0 = Date.now();
    const args = [flag, `--max-old-space-size=${m}`, '--stack-size=984', '--disallow-code-generation-from-strings', '--no-addons', '--input-type=module', '-e', CHILD_SOURCE];
    // Empty environment: nothing of the operator's shell reaches the child.
    // SystemRoot is what Windows itself needs to start a process.
    const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {};
    let child;
    try { child = spawn(node, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return reject(e); }
    let out = '', err = '', killed = false, settled = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, t);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.length > DEFAULTS.maxOutputBytes) { killed = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); stats.runs++; stats.lastMs = Date.now() - t0; stats.msTotal += stats.lastMs; fn(); };
    child.on('error', (e) => finish(() => { stats.failed++; reject(e); }));
    child.on('close', (code, signal) => finish(() => {
      if (killed) { stats.killed++; log(`sandbox: killed after ${t} ms (${jobs.map((j) => j.kind).join(',')})`); return reject(new Error(`sandbox: deadline of ${t} ms exceeded`)); }
      const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const fatal = lines.find((l) => l.fatal);
      if (fatal) { stats.failed++; return reject(new Error(`sandbox: ${fatal.fatal}`)); }
      const results = jobs.map((j) => lines.find((l) => l.id === j.id) ?? { id: j.id, ok: false, error: code === 0 ? 'no result' : `sandbox exited ${code ?? signal}${/heap|memory/i.test(err) ? ' (out of memory)' : ''}: ${err.trim().split('\n').pop() ?? ''}`.slice(0, 300) });
      if (results.some((r) => !r.ok)) stats.failed++;
      resolve(results);
    }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ source, jobs, evalTimeoutMs: Math.min(t, 5000) }));
  });

  /** Convenience: one job, throw on failure. */
  const one = async (source, job, opts) => {
    const [r] = await run(source, [{ id: 0, ...job }], opts);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };

  return { run, one, flag, status: () => ({ flag, node, timeoutMs, memoryMb, ...stats }) };
}
