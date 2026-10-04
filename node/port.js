/** One node per data directory, and a clear word when the port is taken.
 *
 *  Two things went wrong on operators' Windows machines after a restart:
 *  an old portable build's scheduled task started its own node at boot
 *  while the Control Plane started another, and whichever bound the port
 *  second died with a bare EADDRINUSE stack trace. Worse, two launchers on
 *  the SAME data directory run one identity twice, which can sign two
 *  different things for one match.
 *
 *  - `checkInstance` runs before the node starts: if the PID recorded in
 *    <dataDir>/node.pid is still a node process, it waits for that node to
 *    answer /health (a node started at boot can take a while to load) and
 *    reports `running` when it is this identity. The caller then exits with
 *    ALREADY_RUNNING_EXIT instead of fighting it for the port.
 *  - `describePortHolder` runs when listen fails: it names who holds the
 *    port (a litnode, by nodeId and operator, or another program by PID and
 *    path) and any `litnode*` scheduled task that will start it again.
 *
 *  Supervisors (run-node.cmd, sdk/host/supervisor.mjs, the Control Plane)
 *  back off on these exit codes rather than relaunching every 5 s. */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const ALREADY_RUNNING_EXIT = 73; // this identity is already running: attach to it
export const PORT_BUSY_EXIT = 74;       // something else holds the port

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout ?? '')));
});

export async function probeHealth(port, { timeoutMs = 1500, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const h = await r.json();
    return h && typeof h.nodeId === 'string' ? h : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The image name of a PID ('node.exe', 'SomeApp.exe'), or null. */
export async function processName(pid) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = /^"([^"]+)","(\d+)"/m.exec(out);
    return m && Number(m[2]) === pid ? m[1] : null;
  }
  return (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim() || null;
}

/** PID listening on a TCP port, or null. */
export async function listenerPid(port) {
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 5 && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`)) return Number(f[4]);
    }
    return null;
  }
  const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number(out.trim().split(/\s+/)[0]);
  return pid > 0 ? pid : null;
}

async function processPath(pid) {
  if (process.platform !== 'win32') return null;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`], 6000);
  return out.trim() || null;
}

/** Scheduled tasks named litnode* (an old portable install-task.cmd), Windows only. */
export async function litnodeTasks() {
  if (process.platform !== 'win32') return [];
  const out = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH']);
  const names = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"\\?([^"]*)"/.exec(line);
    if (m && /^litnode/i.test(m[1])) names.add(m[1]);
  }
  return [...names];
}

/** Before starting: is this data directory's node already running?
 *  → { state: 'free' } | { state: 'running', pid, health } | { state: 'stale', pid } */
export async function checkInstance({ pidFile, port, nodeId = null, waitMs = 30_000, stepMs = 1000, log = () => {}, deps = {} }) {
  const { alive = pidAlive, name = processName, health = (p) => probeHealth(p), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  if (!existsSync(pidFile)) return { state: 'free' };
  const pid = Number(String(readFileSync(pidFile, 'utf8')).trim().split(/\s+/)[0]);
  if (!pid || pid === process.pid || !alive(pid)) return { state: 'free' };
  // A PID Windows has handed to some other program since: not ours.
  const image = await name(pid);
  if (image && !/node/i.test(image)) return { state: 'stale', pid };
  const deadline = Date.now() + waitMs;
  let said = false;
  for (;;) {
    const h = await health(port);
    if (h && (!nodeId || h.nodeId === nodeId)) return { state: 'running', pid, health: h };
    if (!alive(pid)) return { state: 'free' };
    if (Date.now() >= deadline) return { state: 'stale', pid };
    if (!said) { log(`node.pid names PID ${pid}, still alive and not answering on :${port} yet; waiting up to ${Math.round(waitMs / 1000)} s for it`); said = true; }
    await sleep(stepMs);
  }
}

/** After listen failed with EADDRINUSE: who holds the port, in words. */
export async function describePortHolder(port, { nodeId = null, deps = {} } = {}) {
  const { health = (p) => probeHealth(p), pidOf = listenerPid, name = processName, path = processPath, tasks = litnodeTasks } = deps;
  const [h, pid, taskNames] = await Promise.all([health(port), pidOf(port), tasks()]);
  const [image, exe] = pid ? await Promise.all([name(pid), path(pid)]) : [null, null];
  const lines = [];
  let kind = 'unknown';
  if (h) {
    kind = nodeId && h.nodeId === nodeId ? 'self' : 'litnode';
    lines.push(kind === 'self'
      ? `this node (${h.nodeId.slice(0, 8)}…) is already running on :${port}${pid ? ` as PID ${pid}` : ''}; nothing to do`
      : `another litnode holds :${port}: nodeId ${h.nodeId.slice(0, 8)}…, operator ${h.operator ?? '?'}, version ${h.version ?? '?'}${pid ? `, PID ${pid}` : ''}`);
  } else if (pid) {
    kind = 'other';
    lines.push(`:${port} is held by PID ${pid}${image ? ` (${image})` : ''}, which is not a litnode`);
  } else {
    lines.push(`:${port} is in use, and its owner could not be read (try an administrator prompt, or a Windows reserved port range: netsh interface ipv4 show excludedportrange protocol=tcp)`);
  }
  if (exe) lines.push(`  path: ${exe}`);
  if (taskNames.length) lines.push(`  scheduled task(s) ${taskNames.join(', ')} start a node at boot and logon; if this machine runs the Control Plane, remove them (admin PowerShell): Get-ScheduledTask -TaskName 'litnode*' | Unregister-ScheduledTask -Confirm:$false`);
  if (kind === 'litnode' || kind === 'other') lines.push(`  free the port (end PID ${pid ?? '?'}) or set PORT to another number`);
  return { kind, pid, image, exe, tasks: taskNames, health: h, text: lines.join('\n') };
}
