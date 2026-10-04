/** Agent Fighter as a gauntlet title, end to end (M1 of the Agent Fighter MVP):
 *
 *    two players queue → the mesh places the match on the node that runs Agent Fighter's gauntlet →
 *    that node spawns the title's own match server for this match alone (no database, no publisher key)
 *    → each player claims a seat with a signature over the gateway's challenge → two headless players
 *    fight it through the gateway → each "arcade" checks the head of its player's OWN log and signs →
 *    the server posts the log to its node → the node replays and settles it as the players' →
 *    a witness on another operator's node replays it again and co-signs → official.
 *
 *  Needs an Agent Fighter checkout (AF_ROOT, default E:/NPC/AGENT FIGHTER/agent-fighter) with
 *  node_modules installed; skipped otherwise.
 *    node --test demo/af-gauntlet.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { loadGauntletConfigs } from '../node/gauntlet.js';
import { generateKeypair, seal } from '../protocol/keys.js';
import { QUEUE_TAG, bucketOf, roomCodeFor } from '../protocol/pairing.js';
import { signSeat } from '../protocol/challenge.js';
import { chainHead, ledgerBody, signLedger } from '../protocol/log.js';

const ROOT = process.cwd();
const AF = resolve(process.env.AF_ROOT ?? 'E:/NPC/AGENT FIGHTER/agent-fighter');
const TSX = join(AF, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RULESET = join(ROOT, 'rulesets', 'agent-fighter.v1.js');
const BOT = join(ROOT, 'demo', 'fixtures', 'af-gauntlet-bot.mts');
const have = existsSync(TSX) && existsSync(join(AF, 'packages', 'server', 'src', 'gauntlet-server.ts'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(200); } return false; };

/** Run one bot; play the arcade for it: check the head of its own log, sign, answer. */
const runBot = ({ kp, ws, ticket, room, name, char, seed, match }) => new Promise((resolveBot, reject) => {
  const child = spawn(process.execPath, [TSX, BOT], {
    cwd: AF, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BOT_SESSION_URL: pathToFileURL(join(AF, 'packages', 'server', 'src', 'agent-session.ts')).href, BOT_WS: ws, BOT_TICKET: ticket, BOT_ROOM: room, BOT_NAME: name, BOT_CHAR: char, BOT_SEED: String(seed), BOT_CHARS: join(AF, 'characters') },
  });
  let buf = '', err = '', signedHead = null, result = null;
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith('LEDGER ')) {
        const { ledger, entries } = JSON.parse(line.slice(7));
        // What the arcade does (cabinet:sign with entries): the head of the player's OWN record, not the host's word.
        const own = chainHead(entries);
        if (own !== ledger.head || entries.length !== ledger.ticks) { child.stdin.write('REFUSE\n'); continue; }
        signedHead = own;
        const sig = await signLedger(ledgerBody({ matchId: match.matchId, ticks: entries.length, head: own, buildHash: match.buildHash ?? null }), kp);
        child.stdin.write(`SIG ${sig}\n`);
      } else if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
    }
  });
  child.on('exit', (code) => (result ? resolveBot({ ...result, signedHead }) : reject(new Error(`bot ${name} exited ${code} without a result: ${err.slice(-800)}`))));
});

test('Agent Fighter gauntlet: placed, served per match, signed by both players, settled, witnessed, official', { skip: !have && `no Agent Fighter checkout with node_modules at ${AF}`, timeout: 300_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'lit-afg-'));
  const [cfg] = Object.values(loadGauntletConfigs(`agent-fighter.v1=${join(ROOT, 'gauntlets', 'agent-fighter.json')}`, { root: ROOT }));
  // This checkout, and bots that play faster than real time (a gauntlet has no economy for the pace check to guard).
  const afCfg = { ...cfg, cwd: AF, env: { ...cfg.env, AF_NO_PACE_CHECK: '1' } };
  const host = await createNode({ dataDir: join(tmp, 'host'), offline: true, heartbeatMs: 200, operator: 'studio', roles: ['mesh', 'host', 'settler'], rulesets: [RULESET], gauntlets: { 'agent-fighter.v1': afCfg }, gauntletPort: 0, relayPort: null });
  const witness = await createNode({ dataDir: join(tmp, 'witness'), offline: true, heartbeatMs: 200, operator: 'guild', roles: ['mesh', 'witness'], rulesets: [RULESET], seeds: [host.addr] });
  t.after(async () => { await witness.stop(); await host.stop(); rmSync(tmp, { recursive: true, force: true }); });
  assert.ok(await until(async () => (await (await fetch(`${host.addr}/peers`)).json()).peers?.length >= 2, 20_000), 'the two nodes see each other');

  // Two players queue ranked in one bucket.
  const [p1, p2] = await Promise.all([generateKeypair(), generateKeypair()]);
  const bucket = bucketOf(Date.now());
  for (const kp of [p1, p2]) {
    const env = await seal(QUEUE_TAG, { playerId: kp.publicKey, rulesetId: 'agent-fighter.v1', tokenId: '1', mode: 'ranked', bucket, region: 'lan' }, kp);
    const r = await fetch(`${host.addr}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    assert.ok(r.status === 200 || r.status === 202, `queue: ${r.status}`);
  }
  let match = null;
  assert.ok(await until(async () => { match = (await (await fetch(`${host.addr}/match?playerId=${p1.publicKey}`)).json()).matches?.[0] ?? null; return !!match; }, 40_000), 'placed');
  assert.equal(match.host, host.nodeId, 'the node that runs the gauntlet hosts it');
  const room = roomCodeFor(match.matchId);
  assert.ok(await until(() => host.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 90_000), `the match server is up: ${JSON.stringify(host.gauntlet.status())}`);

  // Each player claims its seat: the gateway's challenge, signed by the player key.
  const gw = `http://127.0.0.1:${host.gauntlet.port}`;
  const claim = async (kp) => {
    const { challenge } = await (await fetch(`${gw}/${room}/ticket?player=${kp.publicKey}`)).json();
    const sig = await signSeat(challenge, kp.privateKey);
    const r = await fetch(`${gw}/${room}/ticket?player=${kp.publicKey}&nonce=${challenge.nonce}&sig=${sig}`);
    assert.equal(r.status, 200);
    return r.json();
  };
  const [s1, s2] = await Promise.all([claim(p1), claim(p2)]);
  assert.equal(s1.ws, `ws://127.0.0.1:${host.gauntlet.port}/${room}`, 'the match has its own room on the gateway');

  const [r1, r2] = await Promise.all([
    runBot({ kp: p1, ws: s1.ws, ticket: s1.ticket, room, name: 'P1', char: 'analog', seed: 11, match }),
    runBot({ kp: p2, ws: s2.ws, ticket: s2.ticket, room, name: 'P2', char: 'vector', seed: 22, match }),
  ]);
  assert.equal(r1.reason, 'verified'); assert.equal(r2.reason, 'verified');
  assert.ok(r1.signedHead && r1.signedHead === r2.signedHead, 'both players signed the head of their own log, and the two agree');

  // The server handed the log to its node; the node replayed it and settled it as the players'.
  let delta = null;
  assert.ok(await until(async () => { const r = await fetch(`${host.addr}/delta/${match.matchId}`); if (r.ok) delta = await r.json(); return !!delta?.matchId; }, 60_000), 'settled on the host');
  assert.equal(delta.attestation, 'players');
  assert.equal(delta.placed, true);
  assert.equal(delta.mode, 'ranked');
  assert.equal(delta.complete, true, 'the log runs to the final KO');
  assert.equal(delta.head, r1.signedHead);
  assert.deepEqual([...delta.participants].sort(), [p1.publicKey, p2.publicKey].sort());
  // A witness on another operator's node replays it and co-signs: verified, and official.
  assert.ok(await until(async () => { delta = await (await fetch(`${host.addr}/delta/${match.matchId}`)).json(); return (delta.cosigners?.length ?? 0) > 0; }, 60_000), 'witnessed');
  assert.ok(delta.cosigners.includes(witness.nodeId));
  assert.equal(delta.verification, 'verified');
  assert.equal(delta.official, true, 'players signed, a witness re-ran it: official');
  // The match server is gone once the match settled.
  assert.ok(await until(() => !host.gauntlet.status().active.some((a) => a.matchId === match.matchId && a.state === 'up'), 30_000), 'the per-match server ended');
});
