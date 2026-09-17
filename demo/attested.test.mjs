/** Pickle Brawl as an attested title: the court signs an outcome report, the
 *  host node validates and settles it labelled `attested`, the witness checks
 *  the attestation and co-signs `attestation-only`, doubles derive team Elo.
 *    node --test demo/attested.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNode } from '../node/litnode.js';
import { generateKeypair, sign } from '../protocol/keys.js';
import { ATTEST_TAG } from '../node/settle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return false; };
const RULESET = join(process.cwd(), 'rulesets', 'pickle-brawl.v1.js');
const { seats, validateReport } = await import(pathToFileURL(RULESET).href);
const tmp = mkdtempSync(join(tmpdir(), 'litnode-attested-'));
const nodes = [];
const spawn = (opts) => createNode({ dataDir: join(tmp, opts.operator), offline: true, heartbeatMs: 200, ...opts }).then((n) => (nodes.push(n), n));

const report = (matchId, mode, scoreA, scoreB, winnerTeam) => ({
  matchId, mode, scoreA, scoreB, winnerTeam, courtUrl: 'wss://court.test', ticks: 5400,
  claims: mode === 'singles'
    ? [{ sub: 'air:alice', team: 0, slot: 0 }, { sub: 'air:bob', team: 1, slot: 0 }]
    : [{ sub: 'air:alice', team: 0, slot: 0 }, { sub: 'air:amy', team: 0, slot: 1 }, { sub: 'air:bob', team: 1, slot: 0 }, { sub: 'air:ben', team: 1, slot: 1 }],
});
const submission = async (court, r) => {
  const { participants, teams } = seats(r);
  const sig = await sign(ATTEST_TAG, { matchId: r.matchId, rulesetId: 'pickle-brawl.v1', report: r }, court.privateKey);
  // Court reports name seats (`pb:air:…`), not mesh keys, and the mesh did not
  // place them: they settle as CASUAL, labelled unplaced, off the official ladder.
  return { kind: 'attested', matchId: r.matchId, rulesetId: 'pickle-brawl.v1', mode: 'casual', participants, teams, report: r, attestor: { id: court.publicKey, sig } };
};

test('rulebook validation', () => {
  assert.equal(validateReport(report('m', 'singles', 11, 9, 0)), null);
  assert.equal(validateReport(report('m', 'doubles', 13, 11, 0)), null);
  assert.equal(validateReport(report('m', 'singles', 0, 0, null)), null, 'abandoned');
  assert.match(validateReport(report('m', 'singles', 11, 10, 0)), /win by two/);
  assert.match(validateReport(report('m', 'singles', 5, 3, 0)), /at least 11/);
  assert.match(validateReport(report('m', 'singles', 9, 11, 0)), /higher score/);
  assert.match(validateReport({ ...report('m', 'doubles', 11, 5, 0), claims: report('m', 'singles', 11, 5, 0).claims }), /4 seats/);
});

test('attested: court-signed report settles, witness co-signs attestation-only, doubles team Elo', { timeout: 60_000 }, async (t) => {
  t.after(async () => { for (const n of nodes) await n.stop().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); });
  const court = await generateKeypair();
  // Both operators authorize the studio's court for this title (COURTS=pickle-brawl.v1:<key>); a
  // valid signature from any other key is not a court's word.
  const courts = { 'pickle-brawl.v1': [court.publicKey] };
  const host = await spawn({ operator: 'studio', roles: ['mesh', 'settler'], rulesets: [RULESET], courts });
  const wit = await spawn({ operator: 'guild-a', roles: ['mesh', 'witness'], seeds: [host.addr], courts });
  assert.ok(await until(() => wit.rulesets()['pickle-brawl.v1']));

  const r1 = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(await submission(court, report('pb-1', 'doubles', 11, 7, 0))) });
  const d1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(d1));
  assert.equal(d1.attestation, 'attested');
  assert.equal(d1.verifiable, false);
  assert.equal(d1.attestor, court.publicKey);
  assert.equal(d1.placed, false); assert.equal(d1.official, false);
  assert.deepEqual(d1.teams, [['pb:air:alice', 'pb:air:amy'], ['pb:air:bob', 'pb:air:ben']]);
  assert.equal(d1.scores['pb:air:amy'], 11);

  assert.ok(await until(async () => (await (await fetch(`${host.addr}/delta/pb-1`)).json()).cosigners.length === 1), 'witness co-signs the attestation');

  // Second match, singles, other way round.
  await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(await submission(court, report('pb-2', 'singles', 8, 11, 1))) });
  assert.equal((await (await fetch(`${host.addr}/leaderboard?ruleset=pickle-brawl.v1`)).json()).leaderboard.length, 0, 'unplaced court results are not official standings');
  const lb = await (await fetch(`${host.addr}/leaderboard?ruleset=pickle-brawl.v1&scope=all`)).json();
  assert.equal(lb.deriveVersion, 2);
  const rating = Object.fromEntries(lb.leaderboard.map((r) => [r.player, r.rating]));
  assert.equal(rating['pb:air:amy'], 1212, 'doubles winners each +12 at even ratings');
  assert.equal(rating['pb:air:ben'], 1188);
  assert.ok(rating['pb:air:bob'] > rating['pb:air:ben'], 'bob won the singles back');
  const credits = await (await fetch(`${host.addr}/credits?ruleset=pickle-brawl.v1&currency=pickles&scope=all`)).json();
  assert.equal(credits['pb:air:amy'], 10);
  assert.equal(credits['pb:air:bob'], 10);

  // Refusals: rulebook, missing signature, wrong key.
  const bad = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(await submission(court, report('pb-3', 'singles', 11, 10, 0))) });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /win by two/);
  const unsigned = { ...(await submission(court, report('pb-4', 'singles', 11, 3, 0))), attestor: null };
  assert.equal((await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(unsigned) })).status, 400);
  const other = await generateKeypair();
  const forged = await submission(court, report('pb-5', 'singles', 11, 3, 0)); forged.attestor.id = other.publicKey;
  const rf = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(forged) });
  assert.equal(rf.status, 400); assert.match((await rf.json()).error, /not an authorized court/);
  // a VALID signature from a key nobody authorized is refused too (audit: signer must be an authorized court)
  const stranger = await submission(other, report('pb-6', 'singles', 11, 3, 0));
  const rs = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify(stranger) });
  assert.equal(rs.status, 400); assert.match((await rs.json()).error, /not an authorized court/);
  // ranked without a placement is refused, court or no court
  const rr = await fetch(`${host.addr}/ledger`, { method: 'POST', body: JSON.stringify({ ...(await submission(court, report('pb-7', 'singles', 11, 3, 0))), mode: 'ranked' }) });
  assert.equal(rr.status, 400); assert.match((await rr.json()).error, /ranked: participants must be player keys/);
  // a node that authorizes no court for the title refuses everything for it
  const none = await spawn({ operator: 'guild-b', roles: ['mesh', 'settler'], rulesets: [RULESET] });
  const rn = await fetch(`${none.addr}/ledger`, { method: 'POST', body: JSON.stringify(await submission(court, report('pb-8', 'singles', 11, 3, 0))) });
  assert.equal(rn.status, 400); assert.match((await rn.json()).error, /no authorized court/);
});
