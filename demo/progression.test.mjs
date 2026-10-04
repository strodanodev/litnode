/** Player progression as a fold over settled results (protocol/progression.js): XP, level, rating,
 *  record, streak, identical on every node.
 *    node --test demo/progression.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progression, progressOf, levelOf, xpForNext, DEFAULT_PROGRESSION } from '../protocol/progression.js';
import { derive } from '../protocol/derive.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const manifest = { services: { leaderboard: { kind: 'elo', k: 24 } } };
const match = (id, epoch, [p, q], [sp, sq]) => ({ matchId: id, epoch, participants: [p, q], scores: { [p]: sp, [q]: sq } });

test('the level curve is Agent Fighter\'s: 80 + 45 × level to the next, capped at 40, XP keeps counting', () => {
  assert.deepEqual(levelOf(0), { level: 1, xp: 0, xpForNext: 125 });
  assert.deepEqual(levelOf(124), { level: 1, xp: 124, xpForNext: 125 });
  assert.deepEqual(levelOf(125), { level: 2, xp: 0, xpForNext: 170 });
  assert.deepEqual(levelOf(125 + 170 + 10), { level: 3, xp: 10, xpForNext: 215 });
  let toCap = 0; for (let l = 1; l < 40; l++) toCap += xpForNext(l);
  assert.deepEqual(levelOf(toCap + 999), { level: 40, xp: 999, xpForNext: null }, 'XP keeps counting past the cap');
  assert.equal(DEFAULT_PROGRESSION.xpWin, 60);
});

test('wins, draws and losses give 60 / 30 / 20 XP; the streak counts consecutive wins', () => {
  const f = progression([
    match('m1', 1, [A, B], [2, 0]),
    match('m2', 2, [A, B], [2, 1]),
    match('m3', 3, [A, C], [1, 1]),
    match('m4', 4, [B, A], [2, 0]),
  ], manifest);
  const a = progressOf(f, A);
  assert.deepEqual([a.matches, a.wins, a.draws, a.losses, a.xpTotal], [4, 2, 1, 1, 60 + 60 + 30 + 20]);
  assert.deepEqual([a.streak, a.bestStreak], [0, 2]);
  assert.deepEqual([a.level, a.xp], [2, 170 - 125], '170 XP: level 2 with 45 into it');
  const b = progressOf(f, B);
  assert.deepEqual([b.wins, b.losses, b.streak, b.xpTotal], [1, 2, 1, 20 + 20 + 60]);
  assert.equal(f.ranking[0].player, A, 'ranked by level, then XP into it, then wins');
  const nobody = progressOf(f, 'd'.repeat(64));
  assert.deepEqual([nobody.level, nobody.matches, nobody.rating], [1, 0, 1200]);
});

test('every node gets the same numbers: order-free, a match counted once, rating equal to /leaderboard', () => {
  const ds = [match('x2', 2, [A, B], [2, 0]), match('x1', 1, [B, C], [2, 1]), match('x3', 3, [C, A], [2, 0]), match('x0', 1, [A, C], [1, 1])];
  const f1 = progression(ds, manifest);
  const f2 = progression([...ds].reverse().concat(ds[0]), manifest);
  assert.equal(f2.digest, f1.digest, 'arrival order and a duplicate change nothing');
  const ladder = derive(ds, manifest);
  for (const p of [A, B, C]) assert.equal(f1.players[p].rating, ladder.rating[p], 'the same Elo walk as the leaderboard');
});

test('a title can set its own progression in its manifest', () => {
  const f = progression([match('m', 1, [A, B], [1, 0])], { services: { leaderboard: { kind: 'elo', k: 24 }, progression: { xpWin: 500, xpLoss: 0 } } });
  assert.deepEqual([f.players[A].xpTotal, f.players[A].level, f.players[B].xpTotal], [500, 3, 0]);
  assert.notEqual(f.digest, progression([match('m', 1, [A, B], [1, 0])], manifest).digest, 'the rules are in the digest');
});
