#!/usr/bin/env node
/** litnode host harness — one command per step from checkout to bonded,
 *  reachable, announced node. Built for people and for agents: every
 *  command is non-interactive, idempotent, takes `--json` for a single
 *  machine-readable object on stdout, and exits 0 ok · 1 error · 2 needs
 *  something only the operator can supply (a key, admin rights) · 3 not
 *  ready (verify).
 *
 *    npm run host -- init --operator laptop [--seeds https://…] [--roles mesh,host,witness,settler] [--tunnel quick] [--air-partner <id> | --no-air]
 *    npm run host -- doctor              preflight: runtime, ports, files, RPC, seeds, clock
 *    npm run host -- identity            create/print the node key and announcer address (no start needed)
 *    npm run host -- start [--detach]    run the node (dashboard), or supervised in the background
 *    npm run host -- status | next       every stage, and the one command to run next
 *    npm run host -- bond                bond this node (OPERATOR_KEY in the environment; the tool never prints it)
 *    npm run host -- publish [--tunnel quick|named …]   public URL through cloudflared + on-chain announce
 *    npm run host -- announce [--fund 0.02]              delegate + fund this node's announcer (OPERATOR_KEY)
 *    npm run host -- install-service [--remove]          start at logon: schtasks / systemd --user / launchd
 *    npm run host -- verify              status with a strict exit code (3 when a required stage is not done)
 *    npm run host -- stop | restart | logs [--lines 50] | env
 *
 *  Keys are read from the environment (OPERATOR_KEY, or the older
 *  DEPLOYER_KEY) and handed to the chain tools as a child environment. No
 *  flag takes a key; nothing here writes one. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, ENV_FILE, AIR_PARTNER_ID, home, readEnv, writeEnv, validateEnv, effectiveConfig, daemonEnv, ensureIdentity, preflight, inspect, plan, health, onPath, serviceStatus, prove } from './index.mjs';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const [k, inline] = a.slice(2).split('=');
  const next = argv[i + 1];
  if (inline != null) flags[k] = inline;
  else if (next != null && !next.startsWith('--') && next !== cmd) { flags[k] = next; i++; }
  else flags[k] = true;
}
const JSON_OUT = !!flags.json;
if (flags.home) process.env.LITNODE_HOME = String(flags.home); // node.env + litnode.log live here (default: the code folder)

const out = (obj, lines) => { if (JSON_OUT) console.log(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)); else for (const l of [].concat(lines ?? [])) console.log(l); };
class Exit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }
// Never process.exit() after a fetch: with keep-alive sockets open, Node on
// Windows aborts in libuv (async.c UV_HANDLE_CLOSING). Set exitCode and drain.
const exit = (code) => { process.exitCode = code; throw new Exit(code); };
const fail = (code, message, extra = {}) => { out({ ok: false, error: message, ...extra }, `error: ${message}`); exit(code); };
const tick = (s) => ({ done: '✔', todo: '·', blocked: '✖', optional: '○', unknown: '?' }[s] ?? ' ');

const keyFromEnv = () => {
  const raw = (process.env.OPERATOR_KEY ?? process.env.DEPLOYER_KEY ?? '').trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? (raw.startsWith('0x') ? raw : '0x' + raw) : null;
};
const childEnv = () => { const key = keyFromEnv(); const e = { ...process.env }; delete e.OPERATOR_KEY; if (key) e.DEPLOYER_KEY = key; return e; };
const runTool = (script, args, { needsEthers = false } = {}) => {
  if (needsEthers && !existsSync(join(ROOT, 'node_modules', 'ethers'))) fail(2, 'this step needs the chain tools: run `npm install` in the node folder once', { fix: 'npm install' });
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env: childEnv(), encoding: 'utf8', windowsHide: true, stdio: JSON_OUT ? 'pipe' : 'inherit' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const waitFor = async (pred, ms, step = 1000) => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, step)); } };
const readPid = (p) => { try { const n = Number(readFileSync(p, 'utf8').trim()); return n > 0 ? n : null; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } };

const cfg = () => effectiveConfig(readEnv() ?? {});

// -------------------------------------------------------------------- commands
const commands = {
  async help() {
    out({ commands: Object.keys(commands) }, readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^ \*\s?/, '')));
  },

  async init() {
    const current = readEnv() ?? {};
    const values = {};
    const map = { operator: 'OPERATOR', seeds: 'SEEDS', roles: 'ROLES', port: 'PORT', host: 'HOST', 'public-addr': 'PUBLIC_ADDR', rulesets: 'RULESETS', region: 'REGION', tunnel: 'TUNNEL', 'tunnel-name': 'TUNNEL_NAME', 'tunnel-host': 'TUNNEL_HOST', 'relay-port': 'RELAY_PORT', 'data-dir': 'DATA_DIR', channel: 'RELEASE_CHANNEL', rpc: 'RPC', trust: 'TITLE_TRUST', upnp: 'UPNP', gauntlets: 'GAUNTLETS', 'gauntlet-gateway-port': 'GAUNTLET_GATEWAY_PORT', 'gauntlet-upstream': 'GAUNTLET_UPSTREAM', courts: 'COURTS', 'relay-keys': 'RELAY_KEYS', services: 'SERVICES' };
    for (const [f, k] of Object.entries(map)) if (f in flags) values[k] = flags[f] === true ? '1' : String(flags[f]);
    if (flags.offline) values.OFFLINE = '1';
    if (flags.witness) { values.ROLES = 'mesh,witness'; values.RULESETS = ''; }
    const merged = { ...current, ...values };
    // First write from the example carries the example's defaults; a
    // witness-only or explicit config must not inherit the example's RULESETS.
    if (!existsSync(join(home(), ENV_FILE))) {
      values.OPERATOR ??= merged.OPERATOR ?? '';
      values.HOST ??= merged.HOST ?? '0.0.0.0';
      values.ROLES ??= merged.ROLES ?? 'mesh,host,witness,settler';
      values.SEEDS ??= merged.SEEDS ?? '';
      values.DATA_DIR ??= `./data/${values.OPERATOR || 'node'}`;
      values.RULESETS ??= merged.RULESETS ?? (values.ROLES.includes('host') ? './rulesets/agent-fighter.v1.js,./rulesets/pickle-brawl.v1.js' : '');
      values.REGION ??= merged.REGION ?? 'local';
      // Universal login: pin AIR session tokens to the arcade's partner app (docs/UNIVERSAL-LOGIN.md). --air-partner overrides; --no-air leaves it out.
      if (!flags['no-air']) values.AIR_PARTNER_ID ??= merged.AIR_PARTNER_ID ?? String(flags['air-partner'] ?? AIR_PARTNER_ID);
    }
    const errs = validateEnv({ ...merged, ...values });
    if (errs.length) fail(1, errs.join('; '), { errors: errs });
    writeEnv(values);
    const c = cfg();
    const id = await ensureIdentity(c.dataDir);
    out({ ok: true, file: join(home(), ENV_FILE), config: c, nodeId: id.nodeId, announcer: id.announcer }, [
      `wrote ${ENV_FILE}: operator ${c.operator} · roles ${c.roles.join(',')} · port ${c.port} · seeds ${c.seeds.join(',') || '(none)'} · tunnel ${c.tunnel ?? 'none'} · rulesets ${c.rulesets.length}`,
      `nodeId ${id.nodeId}`, `announcer ${id.announcer}`, `next: npm run host -- doctor`,
    ]);
  },

  async env() { out({ ok: true, config: cfg(), raw: readEnv() }, JSON.stringify(cfg(), null, 2)); },

  async identity() {
    const c = cfg();
    const id = await ensureIdentity(c.dataDir);
    out({ ok: true, ...id }, [`nodeId    ${id.nodeId}`, `announcer ${id.announcer}`, `files     ${id.files.identity}`]);
  },

  async doctor() {
    const c = cfg();
    const r = await preflight(c, { skipNetwork: !!flags.offline });
    out({ ok: r.ok, checks: r.checks, config: c }, [...r.checks.map((k) => `${k.ok === false ? '✖' : k.ok ? '✔' : '○'} ${k.id.padEnd(13)} ${k.detail}${k.fix ? `\n    fix: ${k.fix}` : ''}`), r.ok ? 'preflight ok' : 'preflight found problems']);
    process.exitCode = r.ok ? 0 : 1;
  },

  async start() {
    const c = cfg();
    if (!readEnv()) fail(2, `${ENV_FILE} missing — npm run host -- init --operator <name>`);
    const id = await ensureIdentity(c.dataDir);
    const already = await health(c.localUrl);
    if (already?.nodeId === id.nodeId) return out({ ok: true, alreadyRunning: true, nodeId: id.nodeId, url: c.localUrl }, `already running at ${c.localUrl}`);
    if (already) fail(1, `${c.localUrl} is another node (${already.operator}); change PORT or stop it`);
    if (flags.detach) {
      const supPid = readPid(join(c.dataDir, 'supervisor.pid'));
      if (supPid && alive(supPid)) fail(1, `a supervisor (pid ${supPid}) is already running but the node does not answer; check litnode.log`);
      const logFd = openSync(join(home(), 'litnode.log'), 'a');
      const child = spawn(process.execPath, [join(ROOT, 'sdk', 'host', 'supervisor.mjs')], { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: process.env });
      child.unref(); closeSync(logFd);
      const h = await waitFor(() => health(c.localUrl), Number(flags.timeout ?? 45_000));
      if (!h) fail(1, 'node did not answer within the timeout; see litnode.log', { log: join(home(), 'litnode.log') });
      return out({ ok: true, detached: true, supervisorPid: child.pid, nodeId: h.nodeId, url: c.localUrl, log: join(home(), 'litnode.log') }, [`node up at ${c.localUrl} (supervisor pid ${child.pid}, log litnode.log)`, 'next: npm run host -- status']);
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'node', 'cli.mjs')], { cwd: ROOT, stdio: 'inherit', env: daemonEnv(c) });
    process.exit(r.status ?? 0);
  },

  async stop() {
    const c = cfg();
    const did = [];
    const svc = serviceStatus(c);
    if (svc.foreign) did.push(`service ${svc.kind} runs another install (${svc.foreign}); left alone`);
    if (process.platform === 'win32' && svc.ours) { const r = spawnSync('schtasks', ['/End', '/TN', 'litnode'], { encoding: 'utf8', windowsHide: true }); did.push(`task litnode: ${r.status === 0 ? 'ended' : 'not running or not permitted'}`); }
    const supFile = join(c.dataDir, 'supervisor.pid');
    const supPid = readPid(supFile);
    if (supPid) { writeFileSync(join(c.dataDir, 'supervisor.stop'), '1'); did.push(`supervisor ${supPid}: ${alive(supPid) && kill(supPid) ? 'signalled' : 'not running'}`); }
    const nodePid = readPid(join(c.dataDir, 'node.pid'));
    if (nodePid) did.push(`node ${nodePid}: ${alive(nodePid) && kill(nodePid) ? 'signalled' : 'not running'}`);
    const gone = await waitFor(async () => !(await health(c.localUrl)), 15_000, 500);
    rmSync(join(c.dataDir, 'node.pid'), { force: true }); rmSync(supFile, { force: true });
    if (!gone && !flags.force) fail(1, `${c.localUrl} still answers; --force to also kill by port owner is not implemented — end the process by hand`, { did });
    out({ ok: true, did }, did.length ? did : ['nothing was running']);
  },

  async restart() { await commands.stop().catch(() => {}); flags.detach = true; await commands.start(); },

  async status() {
    const c = cfg();
    const s = await inspect(c, { chain: !flags.offline });
    const p = plan(c, s);
    out({ ok: true, ready: p.ready, next: p.next, stages: p.stages, nodeId: s.identity?.nodeId ?? null, advertised: s.advertised, at: s.at }, [
      `litnode ${s.health?.version ?? '(not running)'} · operator ${c.operator} · ${c.localUrl}`,
      ...p.stages.map((x) => `${tick(x.status)} ${x.id.padEnd(10)} ${x.detail}`),
      p.next ? `\nnext: ${p.next.command}${p.next.needs ? `\n      needs: ${p.next.needs.join(', ')}` : ''}` : '\nready: every required stage is done',
    ]);
  },

  async next() {
    const c = cfg();
    const p = plan(c, await inspect(c, { chain: !flags.offline }));
    out({ ok: true, ready: p.ready, next: p.next }, p.next ? [`${p.next.stage}: ${p.next.why}`, `run: ${p.next.command}`, ...(p.next.needs ? [`needs: ${p.next.needs.join(', ')}`] : [])] : ['ready']);
  },

  async verify() {
    const c = cfg();
    const s = await inspect(c);
    const p = plan(c, s);
    const required = p.stages.filter((x) => x.status === 'todo' || x.status === 'blocked' || x.status === 'unknown');
    out({ ok: required.length === 0, ready: p.ready, failing: required, stages: p.stages, proof: s.proof, nodeId: s.identity?.nodeId ?? null }, [
      ...p.stages.map((x) => `${tick(x.status)} ${x.id.padEnd(10)} ${x.detail}`),
      required.length ? `\nnot ready: ${required.map((x) => x.id).join(', ')}` : '\nverified: running, current, connected, bonded' + (s.proof?.ok ? ', proves its key at its public URL' : ''),
    ]);
    process.exitCode = required.length ? 3 : 0;
  },

  async bond() {
    const c = cfg();
    if (c.offline) fail(1, 'OFFLINE=1: nothing to bond');
    const id = await ensureIdentity(c.dataDir);
    if (!keyFromEnv()) fail(2, 'set OPERATOR_KEY (the operator wallet, 64 hex) in this shell, then re-run; the key is passed to tools/bond-node.mjs and never written', { nodeId: id.nodeId, needs: ['OPERATOR_KEY'] });
    const r = runTool('tools/bond-node.mjs', [id.nodeId], { needsEthers: true });
    if (r.code !== 0) fail(1, `bond failed (exit ${r.code})`, { stderr: r.stderr.slice(-2000) });
    const s = await inspect(c);
    out({ ok: !!s.standing?.active, nodeId: id.nodeId, standing: s.standing, output: r.stdout.slice(-2000) }, [s.standing?.active ? `bonded: ${id.nodeId} by ${s.standing.operator}` : 'bond sent; the chain does not show it active yet — re-run status in ~10 s']);
  },

  async announce() {
    const c = cfg();
    if (c.offline || !c.nodeDirectory) fail(1, 'no NodeDirectory on this configuration');
    const id = await ensureIdentity(c.dataDir);
    if (!keyFromEnv()) fail(2, 'set OPERATOR_KEY in this shell, then re-run; it is passed to tools/set-announcer.mjs and never written', { nodeId: id.nodeId, announcer: id.announcer, needs: ['OPERATOR_KEY'] });
    const args = [id.nodeId, id.announcer];
    if (flags.fund) args.push('--fund', String(flags.fund));
    const r = runTool('tools/set-announcer.mjs', args);
    if (r.code !== 0) fail(1, `announce delegation failed (exit ${r.code})`, { stderr: r.stderr.slice(-2000) });
    const s = await inspect(c);
    const delegated = (s.entry?.delegatedAnnouncer ?? '').toLowerCase() === id.announcer.toLowerCase();
    out({ ok: delegated, nodeId: id.nodeId, announcer: id.announcer, delegated, funded: s.balance != null ? s.balance > 0n : null, entry: s.entry, output: r.stdout.slice(-2000) },
      [`announcer ${id.announcer}: ${delegated ? 'delegated' : 'not yet visible on chain'}${s.balance != null ? `, balance ${Number(s.balance / 10n ** 12n) / 1e6} zkLTC` : ''}`, 'the running node announces its URL within ~2 min; check with status']);
  },

  async publish() {
    const c0 = cfg();
    const tunnel = flags.tunnel === true ? 'quick' : (flags.tunnel ?? c0.tunnel ?? 'quick');
    const values = { TUNNEL: tunnel };
    if (flags['tunnel-name']) values.TUNNEL_NAME = flags['tunnel-name'];
    if (flags['tunnel-host']) values.TUNNEL_HOST = flags['tunnel-host'];
    if (flags['relay-port']) values.RELAY_PORT = String(flags['relay-port']);
    const errs = validateEnv({ ...(readEnv() ?? {}), ...values });
    if (errs.length) fail(1, errs.join('; '), { errors: errs });
    if (!onPath('cloudflared')) fail(2, 'cloudflared is not on PATH; install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) and re-run', { needs: ['cloudflared'] });
    writeEnv(values);
    const c = cfg();
    const id = await ensureIdentity(c.dataDir);
    const h = await health(c.localUrl);
    const changed = !h || h.tunnel?.node?.mode !== tunnel;
    if (h?.nodeId === id.nodeId && changed) { await commands.stop().catch(() => {}); }
    if (!(await health(c.localUrl))) { flags.detach = true; await commands.start(); }
    const up = await waitFor(async () => { const x = await health(c.localUrl); return x?.tunnel?.node?.state === 'up' ? x : null; }, Number(flags.timeout ?? 90_000), 2000);
    if (!up) fail(1, 'tunnel did not come up within the timeout; /health.tunnel.node.lastError says why', { health: (await health(c.localUrl))?.tunnel ?? null });
    const url = up.tunnel.node.url;
    const proof = await prove(url, id.nodeId);
    let announced = null;
    if (keyFromEnv() && c.nodeDirectory) {
      const s = await inspect(c);
      const delegated = (s.entry?.delegatedAnnouncer ?? '').toLowerCase() === id.announcer.toLowerCase();
      if (!delegated || !(s.balance > 0n)) { const r = runTool('tools/set-announcer.mjs', [id.nodeId, id.announcer, '--fund', String(flags.fund ?? '0.02')]); announced = r.code === 0 ? 'delegated' : `delegation failed (${r.code})`; }
      else announced = 'already delegated and funded';
    }
    out({ ok: proof.ok, url, wsAddr: up.wsAddr ?? null, proof, announced, nodeId: id.nodeId, announcer: id.announcer, needs: keyFromEnv() ? [] : ['OPERATOR_KEY to delegate the announcer (npm run host -- announce --fund 0.02)'] }, [
      `public: ${url}${up.wsAddr ? ` · relay ${up.wsAddr}` : ''}`, `proof of possession: ${proof.ok ? 'ok' : proof.reason}`,
      announced ? `announcer: ${announced}` : 'announcer: not delegated (set OPERATOR_KEY and run: npm run host -- announce --fund 0.02) — without it, strangers find this node only through SEEDS or gossip',
    ]);
  },

  async 'install-service'() {
    const c = cfg();
    if (!readEnv()) fail(2, `${ENV_FILE} missing — init first`);
    const sup = join(ROOT, 'sdk', 'host', 'supervisor.mjs');
    const existing = serviceStatus(c);
    if (existing.foreign && !flags.force) fail(2, `a ${existing.kind} service already runs another install (${existing.foreign}); this harness will not replace it — remove it there first, or --force`, { foreign: existing.foreign });
    if (process.platform === 'win32') {
      if (flags.remove) { const r = spawnSync('schtasks', ['/Delete', '/TN', 'litnode', '/F'], { encoding: 'utf8', windowsHide: true }); return out({ ok: r.status === 0, output: r.stdout + r.stderr }, r.status === 0 ? 'task litnode removed' : `remove failed: ${(r.stderr || r.stdout).trim()} (admin prompt?)`); }
      const ps = [
        `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -MultipleInstances IgnoreNew;`,
        `$triggers = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -AtStartup));`,
        `$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest;`,
        `$action = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${sup}"' -WorkingDirectory '${ROOT}';`,
        `Stop-ScheduledTask -TaskName litnode -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName litnode -Confirm:$false -ErrorAction SilentlyContinue;`,
        `Register-ScheduledTask -TaskName litnode -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null;`,
        `Start-ScheduledTask -TaskName litnode; Start-Sleep -Seconds 2; (Get-ScheduledTask -TaskName litnode).State`,
      ].join(' ');
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) fail(2, `scheduled task registration failed — run from an administrator prompt`, { stderr: (r.stderr || r.stdout).trim().slice(-1500) });
      const h = await waitFor(() => health(c.localUrl), 45_000);
      return out({ ok: !!h, kind: 'schtasks', task: 'litnode', state: r.stdout.trim(), url: c.localUrl }, [`scheduled task litnode: ${r.stdout.trim()} (headless; log litnode.log)`, h ? `node up at ${c.localUrl}` : 'node not answering yet; check litnode.log']);
    }
    if (process.platform === 'darwin') {
      const dir = join(process.env.HOME, 'Library', 'LaunchAgents'); mkdirSync(dir, { recursive: true });
      const plist = join(dir, 'games.litvm.litnode.plist');
      if (flags.remove) { spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist]); rmSync(plist, { force: true }); return out({ ok: true }, 'LaunchAgent removed'); }
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>games.litvm.litnode</string>\n<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${sup}</string></array>\n<key>WorkingDirectory</key><string>${ROOT}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${join(home(), 'litnode.log')}</string>\n<key>StandardErrorPath</key><string>${join(home(), 'litnode.log')}</string>\n</dict></plist>\n`);
      const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
      const h = await waitFor(() => health(c.localUrl), 45_000);
      return out({ ok: !!h, kind: 'launchd', plist, launchctl: r.status }, [`LaunchAgent ${plist} (${r.status === 0 ? 'loaded' : 'write ok; launchctl bootstrap returned ' + r.status})`, h ? `node up at ${c.localUrl}` : 'node not answering yet; check litnode.log']);
    }
    const dir = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, '.config'), 'systemd', 'user'); mkdirSync(dir, { recursive: true });
    const unit = join(dir, 'litnode.service');
    if (flags.remove) { spawnSync('systemctl', ['--user', 'disable', '--now', 'litnode']); rmSync(unit, { force: true }); return out({ ok: true }, 'user unit removed'); }
    writeFileSync(unit, `[Unit]\nDescription=litnode (LIT GAMES arcade node)\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${ROOT}\nExecStart=${process.execPath} ${sup}\nRestart=always\nRestartSec=5\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n`);
    const have = !!onPath('systemctl');
    const r = have ? spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' }) && spawnSync('systemctl', ['--user', 'enable', '--now', 'litnode'], { encoding: 'utf8' }) : null;
    const h = have ? await waitFor(() => health(c.localUrl), 45_000) : null;
    return out({ ok: have ? !!h : null, kind: 'systemd', unit, enabled: r?.status === 0, linger: 'loginctl enable-linger $USER  (so it runs without a login session)' }, [`user unit ${unit}${have ? ` (${r?.status === 0 ? 'enabled' : 'enable failed: ' + (r?.stderr ?? '').trim()})` : ' written; no systemctl here'}`, 'to keep it running after logout: loginctl enable-linger $USER', h ? `node up at ${c.localUrl}` : 'node not answering yet; check litnode.log']);
  },

  async logs() {
    const p = join(home(), 'litnode.log');
    if (!existsSync(p)) fail(1, 'no litnode.log yet (only detached/service runs write it)');
    const lines = readFileSync(p, 'utf8').trimEnd().split(/\r?\n/).slice(-Number(flags.lines ?? 50));
    out({ ok: true, lines }, lines);
  },
};

if (!commands[cmd]) fail(1, `unknown command "${cmd}"; commands: ${Object.keys(commands).join(', ')}`);
try { if ('key' in flags || 'private-key' in flags) fail(2, 'keys are read from the environment only (set OPERATOR_KEY in this shell); no flag takes one'); await commands[cmd](); } catch (e) { if (!(e instanceof Exit)) { out({ ok: false, error: e.message, stack: e.stack }, `error: ${e.message}`); process.exitCode = 1; } }
