/** The secrets rule (node/secrets.js, docs/SETTLEMENT-ARCHITECTURE.md §11): a node holds one stored secret, its own
 *  key. Secret-shaped env names and credential content are detected (names and paths only, never values); a
 *  service inherits only the OS basics of the node's environment; SECRETS_POLICY=strict refuses to start a
 *  service whose environment carries a publisher secret; `npm run host -- doctor` reports every one.
 *    node --test demo/secrets.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSecretName, secretNames, envSecretLines, scanText, scanDataDir, policyOf } from '../node/secrets.js';
import { createServices } from '../node/publisher-services.js';
import { effectiveConfig, preflight } from '../sdk/host/index.mjs';

test('secrets: names', () => {
  for (const k of ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'COURT_TICKET_SECRET', 'MATCHMAKER_TICKET_KEY_PRIVATE_KEY', 'DATABASE_URL', 'POSTGRES_URL', 'STRIPE_API_KEY', 'TUNNEL_TOKEN', 'OPERATOR_KEY', 'COURT_IDENTITY', 'SIGNER_KEY_FILE', 'db_password'])
    assert.ok(isSecretName(k), `${k} is secret-shaped`);
  for (const k of ['PORT', 'SEEDS', 'AIR_PARTNER_ID', 'AIR_PARTNER_IDS', 'COURT_PUBLIC_KEYS', 'RELAY_KEYS', 'COURTS', 'VERIFIERS', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'API_BASE_URL', 'LITNODE_GAUNTLET_TOKEN', 'PATH'])
    assert.ok(!isSecretName(k), `${k} is not`);
  assert.deepEqual(secretNames({ PORT: '1', DATABASE_URL: 'x', COURT_TICKET_SECRET: 'y' }, { except: ['court_ticket_secret'] }), ['DATABASE_URL']);
  assert.equal(policyOf('STRICT'), 'strict'); assert.equal(policyOf('nonsense'), 'warn'); assert.equal(policyOf(undefined), 'warn');
});

test('secrets: content', () => {
  assert.deepEqual(envSecretLines('# c\nPORT=1\nSUPABASE_SERVICE_KEY="abc"\nexport API_KEY=k\nEMPTY_SECRET=\nQUOTED_SECRET=""\n'), ['SUPABASE_SERVICE_KEY', 'API_KEY']);
  assert.deepEqual(scanText('{"privateKey":"0x' + 'ab'.repeat(32) + '"}'), ['json-private-key']);
  assert.ok(scanText('-----BEGIN EC PRIVATE KEY-----\nMHc…').includes('pem-private-key'));
  assert.ok(scanText('url=postgresql://user:hunter2@db.example:5432/x').includes('db-url-with-password'));
  assert.ok(scanText('eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWJ5dGVz').includes('jwt'));
  assert.deepEqual(scanText('{"publicKey":"' + 'ab'.repeat(32) + '","nodeId":"x"}'), [], 'public keys are not secrets');
});

test('secrets: the data folder keeps only the node\'s own key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litsec-'));
  try {
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ privateKey: 'ab'.repeat(32), publicKey: 'cd'.repeat(32) }));
    writeFileSync(join(dir, 'announcer.json'), JSON.stringify({ privateKey: '0x' + 'ef'.repeat(32) }));
    mkdirSync(join(dir, 'ledgers')); writeFileSync(join(dir, 'ledgers', 'x.json'), JSON.stringify({ privateKey: 'ab'.repeat(32) }));
    assert.deepEqual(scanDataDir(dir), [], 'own key files and content-addressed folders are not findings');
    mkdirSync(join(dir, 'proxies')); writeFileSync(join(dir, 'proxies', 'sub-1.json'), JSON.stringify({ privateKey: '0x' + '12'.repeat(32) }));
    writeFileSync(join(dir, 'court.json'), JSON.stringify({ privateKey: '34'.repeat(32) }));
    mkdirSync(join(dir, 'svc')); writeFileSync(join(dir, 'svc', '.env'), 'SUPABASE_SERVICE_KEY=abc\n');
    const f = scanDataDir(dir);
    assert.deepEqual(f.map((x) => x.kind).sort(), ['env-secret-line', 'json-private-key', 'proxies']);
    assert.ok(f.find((x) => x.kind === 'proxies').detail.startsWith('1 AIR proxy wallet key'));
    assert.ok(!JSON.stringify(f).includes('34'.repeat(32)), 'values are never reported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A spawn that records the env it was given and never listens, so launch gives up after readyMs. */
const recordingSpawn = (calls) => (command, args, opts) => { calls.push(opts.env); const c = new EventEmitter(); c.pid = 4242; c.kill = () => setImmediate(() => c.emit('exit', null)); return c; };
const bundle = (services) => ({ prefix: 'demo', cwd: process.cwd(), envFiles: [], portRange: [8870, 8879], services, file: 'x' });

test('secrets: a service inherits the OS basics and its own list, never the rest of the node\'s environment', async () => {
  const calls = [];
  const svcs = createServices({ bundles: [{ ...bundle({ a: { command: 'x', env: { PORT: '${port}' }, readyMs: 50 } }), inheritEnv: ['MY_SETTING'] }], nodeUrl: 'http://127.0.0.1:1', spawnImpl: recordingSpawn(calls), processEnv: { PATH: '/bin', SystemRoot: 'C:\\Windows', MY_SETTING: 'yes', SUPABASE_SERVICE_KEY: 'leak', AIR_PARTNER_ID: 'p', OPERATOR_KEY: 'k' } });
  await svcs.start(); await svcs.stop();
  const env = calls[0];
  assert.equal(env.PATH, '/bin'); assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.MY_SETTING, 'yes', 'inheritEnv is honoured');
  assert.equal(env.SUPABASE_SERVICE_KEY, undefined, 'the node\'s other variables stay with the node');
  assert.equal(env.AIR_PARTNER_ID, undefined); assert.equal(env.OPERATOR_KEY, undefined);
  assert.deepEqual(svcs.status()[0].secrets, []);
});

test('secrets: warn reports a publisher secret; strict refuses to start the service', async () => {
  const logs = [], calls = [];
  const services = { court: { command: 'x', env: { PORT: '${port}', COURT_IDENTITY: 'C:/keys/court.json' }, readyMs: 50 } };
  const warn = createServices({ bundles: [bundle(services)], nodeUrl: 'http://127.0.0.1:1', spawnImpl: recordingSpawn(calls), processEnv: {}, log: (l) => logs.push(l) });
  await warn.start(); await warn.stop();
  assert.equal(calls.length, 1, 'warn still starts it');
  assert.deepEqual(warn.status()[0].secrets, ['COURT_IDENTITY']);
  assert.ok(logs.some((l) => /WARNING .*COURT_IDENTITY/.test(l)) && !logs.some((l) => l.includes('C:/keys')), 'the name is logged, not the value');

  const strict = createServices({ bundles: [bundle(services)], nodeUrl: 'http://127.0.0.1:1', spawnImpl: recordingSpawn(calls), processEnv: {}, secretsPolicy: 'strict' });
  await strict.start(); await strict.stop();
  assert.equal(calls.length, 1, 'strict never spawns it');
  assert.equal(strict.status()[0].state, 'refused'); assert.match(strict.status()[0].lastError, /SECRETS_POLICY=strict/);
});

test('secrets: the per-run gauntlet token is not a finding', async () => {
  const calls = [];
  const b = { ...bundle({ mm: { command: 'x', env: { PORT: '${port}' }, readyMs: 50 } }), gauntletCallers: ['mm'], gauntletRulesets: ['demo.v1'] };
  const s = createServices({ bundles: [b], nodeUrl: 'http://127.0.0.1:1', spawnImpl: recordingSpawn(calls), processEnv: {}, secretsPolicy: 'strict' });
  await s.start(); await s.stop();
  assert.equal(calls.length, 1); assert.match(calls[0].LITNODE_GAUNTLET_TOKEN, /^[0-9a-f]{64}$/);
});

test('secrets: doctor lists every secret this install holds, by name and path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'litsec-home-'));
  try {
    const dataDir = join(home, 'data');
    mkdirSync(join(dataDir, 'proxies'), { recursive: true });
    writeFileSync(join(dataDir, 'proxies', 'a.json'), JSON.stringify({ privateKey: '0x' + '12'.repeat(32) }));
    writeFileSync(join(home, 'api.env'), 'SUPABASE_SERVICE_KEY=abc\nPORT=1\n');
    writeFileSync(join(home, 'svc.json'), JSON.stringify({ prefix: 'pb', cwd: home, envFiles: ['api.env'], services: { mm: { command: 'x', env: { COURT_IDENTITY: 'C:/k.json' } } } }));
    writeFileSync(join(home, 'g.json'), JSON.stringify({ command: 'x', env: { PORT: '${port}', COURT_TICKET_SECRET: '${secret}', DATABASE_URL: 'postgres://u:p@h/d' } }));
    const env = { OPERATOR: 'sec', DATA_DIR: dataDir, OFFLINE: '1', SERVICES: join(home, 'svc.json'), GAUNTLETS: `demo.v1=${join(home, 'g.json')}`, API_KEY: 'x' };
    const cfg = effectiveConfig(env, { processEnv: {} });
    const { checks } = await preflight(cfg, { env, skipNetwork: true });
    const c = checks.find((x) => x.id === 'secrets');
    assert.equal(c.ok, false);
    for (const want of ['node.env: API_KEY', 'pb: api.env carries SUPABASE_SERVICE_KEY', 'pb.mm: env COURT_IDENTITY', 'gauntlet demo.v1: env DATABASE_URL', 'AIR proxy wallet key'])
      assert.ok(c.detail.includes(want), `${want} in: ${c.detail}`);
    assert.ok(!c.detail.includes('COURT_TICKET_SECRET'), 'a per-run ${secret} is not a finding');
    assert.ok(!c.detail.includes('abc') && !c.detail.includes('postgres://'), 'values are never printed');
    assert.match(c.fix, /managed env/);

    const clean = { OPERATOR: 'sec', DATA_DIR: join(home, 'clean'), OFFLINE: '1' };
    const ok = (await preflight(effectiveConfig(clean, { processEnv: {} }), { env: clean, skipNetwork: true })).checks.find((x) => x.id === 'secrets');
    assert.equal(ok.ok, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('key proof (cabinet:sign-key): binds the player key to one title and one service', async () => {
  const { generateKeypair } = await import('../protocol/keys.js');
  const { signKeyProof, verifyKeyProof, signSeat, verifySeat, AUD_RE } = await import('../protocol/challenge.js');
  const kp = await generateKeypair();
  const claim = { aud: 'pb-matchmaker', nonce: 'ab'.repeat(16), player: kp.publicKey, rulesetId: 'pickle-brawl.v1' };
  const sig = await signKeyProof(claim, kp.privateKey);
  assert.ok(await verifyKeyProof(claim, sig));
  assert.ok(!(await verifyKeyProof({ ...claim, rulesetId: 'flood-control.v1' }, sig)), 'another title');
  assert.ok(!(await verifyKeyProof({ ...claim, aud: 'pb-api' }, sig)), 'another service');
  assert.ok(!(await verifyKeyProof({ ...claim, nonce: 'cd'.repeat(16) }, sig)), 'another nonce');
  // The tag keeps it from passing as a seat claim, and a seat signature from passing as a key proof.
  assert.ok(!(await verifySeat({ matchId: claim.aud, room: claim.rulesetId, player: claim.player, nonce: claim.nonce }, sig)));
  const seatSig = await signSeat({ matchId: 'm', room: 'r', player: kp.publicKey, nonce: claim.nonce }, kp.privateKey);
  assert.ok(!(await verifyKeyProof(claim, seatSig)));
  assert.ok(AUD_RE.test('pb-matchmaker') && !AUD_RE.test('PB Matchmaker') && !AUD_RE.test('x'.repeat(65)));
});
