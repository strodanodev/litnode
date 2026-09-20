/** Keep one node running: the cross-platform equivalent of run-node.cmd.
 *
 *    node sdk/host/supervisor.mjs            (normally via `npm run host -- start --detach`)
 *
 *  Reads node.env, runs node/cli.mjs in plain mode with stdout+stderr
 *  appended to litnode.log, and relaunches it when it ends — at once on exit
 *  75 (the node applied an update and asked to be restarted), after 5 s on
 *  anything else. SIGTERM/SIGINT, or a `stop` file beside the pid, end both.
 *  Writes <dataDir>/supervisor.pid; the node writes <dataDir>/node.pid. */
import { spawn } from 'node:child_process';
import { existsSync, openSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv, effectiveConfig, daemonEnv, ROOT, home } from './index.mjs';
import { RESTART_EXIT } from '../../node/update.js';

const env = readEnv() ?? {};
const cfg = effectiveConfig(env);
const pidFile = join(cfg.dataDir, 'supervisor.pid');
const stopFile = join(cfg.dataDir, 'supervisor.stop');
const logPath = join(home(), 'litnode.log');
const stamp = () => `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`;
const log = (m) => { const fd = openSync(logPath, 'a'); writeFileSync(fd, `${stamp()} supervisor: ${m}\n`); closeSync(fd); };

writeFileSync(pidFile, `${process.pid}\n`);
rmSync(stopFile, { force: true });
let child = null, stopping = false;

const runOnce = () => new Promise((resolve) => {
  const fd = openSync(logPath, 'a');
  child = spawn(process.execPath, [join(ROOT, 'node', 'cli.mjs')], {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
    env: { ...daemonEnv(cfg, env), LITNODE_PLAIN: '1' },
  });
  child.on('exit', (code, signal) => { closeSync(fd); child = null; resolve(code ?? (signal ? 128 : 1)); });
  child.on('error', (e) => { closeSync(fd); child = null; log(`spawn failed: ${e.message}`); resolve(1); });
});

const end = () => { stopping = true; if (child) child.kill('SIGTERM'); };
process.on('SIGTERM', end);
process.on('SIGINT', end);

log(`started (pid ${process.pid}) for operator ${cfg.operator} on :${cfg.port}`);
for (;;) {
  const code = await runOnce();
  if (stopping || existsSync(stopFile)) { log(`node exited (${code}); stopping`); break; }
  if (code === RESTART_EXIT) { log('node asked for a restart (update applied); relaunching'); continue; }
  log(`node exited (${code}); restarting in 5 s`);
  await new Promise((r) => setTimeout(r, 5000));
  if (stopping || existsSync(stopFile)) break;
}
rmSync(pidFile, { force: true });
rmSync(stopFile, { force: true });
