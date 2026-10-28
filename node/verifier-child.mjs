/** The verifier child: one verify() call, then exit. Started by node/verifier.js with the permission model on (read
 *  access to the bundle's own directory only: no writes, no child processes, no addons, no workers), an empty
 *  environment, a heap ceiling and a deadline. The parent passes this file's text with -e, so the child reads no file
 *  of litnode's.
 *
 *  The permission model does not cover the network on this runtime, so before the bundle is imported every
 *  network-capable builtin is refused at resolve time (that covers import() and a bundle's createRequire alike) and
 *  the network globals are removed. A verifier is a pure function over a log (docs/SETTLEMENT-STANDARD.md §11): it
 *  needs none of them. Capability-restricted, like the title sandbox; not proven escape-free.
 *
 *  stdin:  { entry: file URL of the bundle's entry, log: base64 of the committed bytes, spec }
 *  stdout: one JSON line, { ok: true, finalHash, result } or { ok: false, error } */
import { registerHooks } from 'node:module';

const REFUSED = new Set(['net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'child_process', 'cluster', 'worker_threads', 'inspector', 'repl']);
registerHooks({
  resolve(specifier, context, next) {
    if (REFUSED.has(specifier.replace(/^node:/, '').split('/')[0])) throw new Error(`refused: a verifier may not import ${specifier}`);
    return next(specifier, context);
  },
});
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[k]; } catch { /* not there */ } }

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
try {
  const { entry, log, spec } = JSON.parse(input);
  const m = await import(entry);
  if (typeof m.verify !== 'function') throw new Error('the bundle exports no verify()');
  const r = await m.verify(new Uint8Array(Buffer.from(log, 'base64')), spec ?? null);
  out({ ok: true, finalHash: typeof r?.finalHash === 'string' ? r.finalHash : null, result: r?.result ?? null });
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e).slice(0, 500) });
}
process.exit(0);
