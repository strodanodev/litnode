/** @litvm/sdk — what a game developer imports to put a title on the mesh.
 *
 *  A title is one file. Five functions and a manifest (defineTitle) for a
 *  deterministic game the network can replay; two functions and a manifest
 *  (defineAttestedTitle) for one it cannot. Everything downstream — placement,
 *  witness replay, ladders, credits, stats, hourly settlement on litVM — is
 *  derived from that file and the deltas it produces; the developer writes no
 *  backend.
 *
 *  Recognition in the litVM Games ecosystem is a set of on-chain facts, not a
 *  listing (docs/HOST-YOUR-TITLE.md): the ruleset passes conformance
 *  (sdk/conformance.mjs — every node re-checks it before loading), a bonded
 *  node hosts it, its matches settle into epoch roots on EpochAnchor, its
 *  agents hydrate from ERC6699Registry, its players are keys (and, bound,
 *  PlayerProfiles).
 *
 *  The bundled artifact must be a single ES module with no imports; this
 *  file and everything it re-exports are dependency-free so tools/
 *  bundle-title.mjs can inline them. */
export { defineTitle, defineAttestedTitle, eloLeaderboard, winnerTakesCredits, titleHash } from '../titles/title.js';

/** Linear interpolation, the one helper every balance mapping wants. */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Clamp into [lo, hi]. */
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** A balance mapping: how a character's ERC-6699 core stats (uint16, 0–65535
 *  each: strength, agility, resilience, intelligence) become this title's
 *  numbers. `map` is { name: (stats) => number }. The version is the hash of
 *  the mapping's own source, so a retune is a new version and a witness
 *  replaying an old delta uses the mapping that delta was settled with.
 *  Keep every range BOUNDED: a mapping is only as fair as its spread. */
export function defineBalance(map) {
  const source = Object.entries(map).map(([k, fn]) => `${k}=${fn.toString()}`).join('\n');
  let hsh = 0x811c9dc5; // FNV-1a over the source; no crypto needed inside a ruleset
  for (let i = 0; i < source.length; i++) { hsh ^= source.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193) >>> 0; }
  const version = `bal-${hsh.toString(16).padStart(8, '0')}`;
  return { version, apply: (stats) => Object.fromEntries(Object.entries(map).map(([k, fn]) => [k, fn(stats ?? {})])), map };
}

/** A seeded integer PRNG a title may use for anything random: same seed,
 *  same sequence, on every node. Never Math.random inside a ruleset. */
export function seededRandom(seedHex) {
  let s = 0;
  for (let i = 0; i < seedHex.length; i++) s = (Math.imul(s, 31) + seedHex.charCodeAt(i)) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
