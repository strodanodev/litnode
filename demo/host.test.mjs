/** The host harness (sdk/host): node.env round-trips with its comments,
 *  the effective configuration matches what node/cli.mjs runs with, an
 *  identity made before first start is the identity the node then uses,
 *  preflight and the stage plan read the real node and say the one next
 *  command, and the CLI is non-interactive, JSON-clean and idempotent from
 *  init to stop against a scratch LITNODE_HOME.
 *    node --test demo/host.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNode } from '../node/litnode.js';
import { parseEnv, writeEnv, readEnv, validateEnv, effectiveConfig, daemonEnv, ensureIdentity, readIdentity, preflight, inspect, plan, serviceStatus, ROOT } from '../sdk/host/index.mjs';

const RULESET = join(ROOT, 'rulesets', 'tug.v1.js');
const cli = (home, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'sdk', 'host', 'cli.mjs'), ...args, '--json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LITNODE_HOME: home, ...env }, timeout: 90_000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};

test('host: node.env round-trips, comments survive, empties are commented out, values validate', () => {
  const home = mkdtempSync(join(tmpdir(), 'lithost-'));
  try {
    writeEnv({ OPERATOR: 'guild-a', SEEDS: 'https://seed.example', TUNNEL: '' }, { dir: home });
    const text = readFileSync(join(home, 'node.env'), 'utf8');
    assert.match(text, /^# litnode settings/m, 'the example file is the base, with its comments');
    assert.match(text, /^OPERATOR=guild-a$/m);
    assert.match(text, /^SEEDS=https:\/\/seed\.example$/m);
    assert.match(text, /^#TUNNEL=$/m, 'an empty value comments the key out rather than deleting it');
    writeEnv({ SEEDS: '', PORT: '7900' }, { dir: home });
    const env = readEnv(home);
    assert.equal(env.OPERATOR, 'guild-a', 'a second write keeps what it did not touch');
    assert.equal(env.SEEDS, undefined);
    assert.equal(env.PORT, '7900');
    assert.deepEqual(parseEnv('# c\nA=1\n  B = two words \n#C=3\nbad line\n'), { A: '1', B: 'two words' });
    assert.deepEqual(validateEnv({ OPERATOR: 'ok-1', ROLES: 'mesh,host', PORT: '7801', SEEDS: 'http://a:1,https://b' }), []);
    const errs = validateEnv({ OPERATOR: 'Bad Name', ROLES: 'mesh,king', PORT: 'x', SEEDS: 'ftp://a', TUNNEL: 'named' });
    assert.equal(errs.length, 5, errs.join('; '));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('host: effective config matches the daemon; the shell overrides node.env; the daemon env never carries a key', () => {
  const c = effectiveConfig({ OPERATOR: 'x', HOST: '0.0.0.0', PORT: '7905', ROLES: 'mesh,witness', RULESETS: './rulesets/tug.v1.js', OFFLINE: '1' }, { processEnv: { REGION: 'eu' } });
  assert.equal(c.operator, 'x');
  assert.equal(c.dataDir, join(ROOT, 'data', 'x'), 'DATA_DIR defaults to data/<operator> beside the code, as cli.mjs does');
  assert.deepEqual(c.roles, ['mesh', 'witness']);
  assert.equal(c.region, 'eu', 'the process environment wins over node.env');
  assert.equal(c.rulesets[0], RULESET);
  assert.equal(c.offline, true); assert.equal(c.rpc, null);
  assert.match(c.publicAddr, /^http:\/\/\d+\.\d+\.\d+\.\d+:7905$/, 'listening on every interface advertises the LAN address, like start-node.cmd');
  const chain = effectiveConfig({ OPERATOR: 'y' }, { processEnv: {} });
  assert.match(chain.nodeStake, /^0x[0-9a-fA-F]{40}$/, 'chain defaults come from contracts/deployed.testnet.json');
  assert.match(chain.nodeDirectory, /^0x/);
  const e = daemonEnv(c, { OPERATOR: 'x', HOST: '0.0.0.0' }, { OPERATOR_KEY: '0x' + '11'.repeat(32), DEPLOYER_KEY: 'k', PATH: 'p' });
  assert.equal(e.OPERATOR_KEY, undefined); assert.equal(e.DEPLOYER_KEY, undefined);
  assert.equal(e.PUBLIC_ADDR, c.publicAddr); assert.equal(e.PATH, 'p');
});

test('host: an identity made before first start is the identity the node runs with; preflight and the plan read the live node', { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'lithost-'));
  const dataDir = join(home, 'data');
  let node = null;
  t.after(async () => { await node?.stop().catch(() => {}); rmSync(home, { recursive: true, force: true }); });

  const id = await ensureIdentity(dataDir);
  assert.match(id.nodeId, /^[0-9a-f]{64}$/); assert.match(id.announcer, /^0x[0-9a-f]{40}$/);
  assert.deepEqual(await ensureIdentity(dataDir), id, 'idempotent');
  node = await createNode({ dataDir, port: 0, offline: true, operator: 'w', roles: ['mesh', 'witness'], rulesets: [RULESET] });
  assert.equal(node.nodeId, id.nodeId, 'the daemon picked up identity.json rather than generating its own');
  assert.equal(readIdentity(dataDir).nodeId, id.nodeId);

  writeEnv({ OPERATOR: 'w', ROLES: 'mesh,witness', PORT: String(node.port), HOST: '127.0.0.1', DATA_DIR: dataDir, RULESETS: './rulesets/tug.v1.js', OFFLINE: '1', SEEDS: '' }, { dir: home });
  const cfg = effectiveConfig(readEnv(home), { processEnv: {} });
  cfg.home = home;
  const pre = await preflight(cfg, { env: readEnv(home) });
  assert.equal(pre.ok, true, JSON.stringify(pre.checks.filter((c) => c.ok === false)));
  assert.equal(pre.checks.find((c) => c.id === 'port').ok, null, 'our own node on the port is not a conflict');

  const s = await inspect(cfg);
  assert.equal(s.health.nodeId, id.nodeId);
  const p = plan(cfg, s);
  const by = Object.fromEntries(p.stages.map((x) => [x.id, x.status]));
  assert.equal(by.running, 'done'); assert.equal(by.configure, 'done');
  assert.equal(by.hosting, 'optional', 'a ruleset is loaded for replay, but without the host role nothing is placed here');
  assert.equal(by.reachable, 'optional', 'a witness with no host role needs no inbound path');
  assert.equal(by.bonded, 'optional', 'offline: no chain');
  assert.equal(p.ready, true, JSON.stringify(p.stages));
  assert.equal(p.next, null);

  // Another identity on that port → blocked, with the reason, not a false "running".
  const other = effectiveConfig({ ...readEnv(home), DATA_DIR: join(home, 'other') }, { processEnv: {} });
  other.home = home;
  await ensureIdentity(other.dataDir);
  const p2 = plan(other, await inspect(other));
  assert.equal(p2.stages.find((x) => x.id === 'running').status, 'blocked');
});

test('host: the plan names the one next command with what it needs — the chain stages stay optional until a role wants them', () => {
  const cfg = effectiveConfig({ OPERATOR: 'h', ROLES: 'mesh,host,witness', TUNNEL: 'quick' }, { processEnv: {} });
  const base = { env: { OPERATOR: 'h' }, identity: { nodeId: 'ab'.repeat(32), announcer: '0x' + 'cd'.repeat(20) }, health: null, foreign: null, peers: null, titles: null, standing: null, entry: null, balance: null, proof: null, chainError: null, service: { kind: 'systemd', installed: false }, advertised: null };
  let p = plan(cfg, base);
  assert.equal(p.next.stage, 'running'); assert.match(p.next.command, /start --detach/);

  const up = { ...base, health: { version: '0.9.0', protocol: 3, uptimeMs: 5000, rulesets: { 'tug.v1': 'x' }, peers: 1, refused: 0, update: { available: false }, tunnel: { node: { state: 'up', url: 'https://x.trycloudflare.com', mode: 'quick' } }, inbound: { reachable: null }, addr: 'https://x.trycloudflare.com', directory: { seeds: 2 } }, peers: { peers: [{ fresh: true }], incompatible: [] }, advertised: 'https://x.trycloudflare.com', proof: { ok: true } };
  p = plan(cfg, up);
  assert.equal(p.next.stage, 'bonded', JSON.stringify(p.next));
  assert.match(p.next.command, /host -- bond/);
  assert.ok(p.next.needs.some((n) => /OPERATOR_KEY/.test(n)), 'the operator, not the harness, supplies the key');

  const bonded = { ...up, standing: { active: true, amount: 10n ** 18n, operator: '0x' + '11'.repeat(20) } };
  p = plan(cfg, bonded);
  assert.equal(p.next.stage, 'announced'); assert.match(p.next.command, /announce --fund/);

  const announced = { ...bonded, entry: { url: 'https://x.trycloudflare.com', wsAddr: '', updatedAt: 1_800_000_000n, delegatedAnnouncer: base.identity.announcer }, balance: 1n };
  p = plan(cfg, announced);
  assert.equal(p.ready, true, JSON.stringify(p.stages.filter((x) => x.status === 'todo')));

  const stale = { ...announced, entry: { ...announced.entry, url: 'https://old.trycloudflare.com' } };
  p = plan(cfg, stale);
  assert.equal(p.stages.find((x) => x.id === 'announced').status, 'todo', 'chain says an older URL: the node re-announces; the plan says wait');
  assert.match(p.stages.find((x) => x.id === 'announced').detail, /re-announces/);

  const chainDown = { ...up, chainError: 'fetch failed' };
  p = plan(cfg, chainDown);
  assert.equal(p.stages.find((x) => x.id === 'bonded').status, 'unknown', 'a failed read is unknown, never a guess');
});

test('host CLI: init → doctor → start --detach → status/next/verify → stop, non-interactive, JSON on stdout, idempotent', { timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'lithost-'));
  const port = 7900 + Math.floor(Math.random() * 90);
  t.after(() => { cli(home, ['stop']); rmSync(home, { recursive: true, force: true }); });

  let r = cli(home, ['init', '--operator', 'cli-w', '--offline', '--port', String(port), '--data-dir', join(home, 'data'), '--roles', 'mesh,witness', '--rulesets', '']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true); assert.match(r.json.nodeId, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(join(home, 'node.env')));
  assert.equal(r.json.config.rulesets.length, 0, 'an explicit empty RULESETS is honoured over the example default');
  r = cli(home, ['init', '--operator', 'cli-w']);
  assert.equal(r.code, 0); assert.equal(r.json.config.port, port, 'a second init keeps what it did not change');
  r = cli(home, ['init', '--operator', 'Bad Name']);
  assert.equal(r.code, 1); assert.equal(r.json.ok, false);
  r = cli(home, ['bond', '--key', '0x' + '00'.repeat(32)]);
  assert.equal(r.code, 2, 'no flag takes a key'); assert.match(r.json.error, /environment only/);

  r = cli(home, ['doctor']);
  assert.equal(r.code, 0, JSON.stringify(r.json?.checks?.filter((c) => c.ok === false) ?? r.stderr));
  r = cli(home, ['next']);
  assert.equal(r.json.next.stage, 'running'); assert.match(r.json.next.command, /start --detach/);

  r = cli(home, ['start', '--detach']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.detached, true);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.operator, 'cli-w');
  r = cli(home, ['start', '--detach']);
  assert.equal(r.json.alreadyRunning, true, 'start is idempotent');

  r = cli(home, ['status']);
  assert.equal(r.code, 0); assert.equal(r.json.ready, true, JSON.stringify(r.json.stages));
  r = cli(home, ['verify']);
  assert.equal(r.code, 0, JSON.stringify(r.json.failing));
  r = cli(home, ['logs', '--lines', '3']);
  assert.equal(r.code, 0); assert.ok(r.json.lines.length > 0);

  r = cli(home, ['stop']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }), 'stopped for good — the supervisor did not relaunch it');
  assert.ok(!existsSync(join(home, 'data', 'supervisor.pid')));
  r = cli(home, ['stop']);
  assert.equal(r.code, 0, 'stop when nothing runs is fine');
  r = cli(home, ['verify']);
  assert.equal(r.code, 3, 'verify is strict: a stopped node is not ready');
});

test('host: SERVICE_NAME names the start-at-logon task, so a second node on one machine never takes the first one’s', () => {
  assert.equal(effectiveConfig({}, { processEnv: {} }).serviceName, 'litnode', 'default unchanged for existing installs');
  assert.equal(effectiveConfig({ SERVICE_NAME: 'litnode-witness-2' }, { processEnv: {} }).serviceName, 'litnode-witness-2');
  for (const bad of ['', 'a b', 'x;del', '../x', 'n'.repeat(65)]) assert.equal(effectiveConfig({ SERVICE_NAME: bad }, { processEnv: {} }).serviceName, 'litnode', `rejected: ${JSON.stringify(bad)}`);
  // init validates it, so a typo is an error rather than a silent fallback onto the first node's task.
  assert.deepEqual(validateEnv({ OPERATOR: 'w2', SERVICE_NAME: 'litnode-witness-2' }), []);
  assert.ok(validateEnv({ OPERATOR: 'w2', SERVICE_NAME: 'x;del' }).some((e) => /SERVICE_NAME/.test(e)));
  // A name nothing is registered under: the real service manager is asked, and the answer names it.
  const name = `litnode-test-${process.pid}`;
  const st = serviceStatus({ ...effectiveConfig({ SERVICE_NAME: name }, { processEnv: {} }), root: ROOT });
  assert.equal(st.installed, false); assert.equal(st.ours, false); assert.equal(st.foreign, undefined);
  if (process.platform === 'win32') { assert.equal(st.name, name); assert.match(st.detail, new RegExp(name)); }
});
