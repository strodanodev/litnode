/** A stand-in for the Control Plane in demo/orphan.test.mjs: start a node with its stdout and stderr in
 *  pipes this process reads, print the node's PID once it answers, then die without closing anything.
 *    node orphan-parent.mjs <port> <dataDir> */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [port, dataDir] = process.argv.slice(2);
const root = join(import.meta.dirname, '..', '..');
const child = spawn(process.execPath, [join(root, 'node', 'cli.mjs')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true,
  env: { ...process.env, OFFLINE: '1', PORT: port, DATA_DIR: dataDir, OPERATOR: 'orphan', ROLES: 'mesh,host', LITNODE_PLAIN: '1', LITNODE_NO_UPDATE: '1' },
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 500));
}
process.stdout.write(`${child.pid}\n`);
process.exit(0);
