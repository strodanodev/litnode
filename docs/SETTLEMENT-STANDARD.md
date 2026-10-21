# The settlement standard

What every title on the litVM Games mesh must do to have a match settled,
and what the mesh promises back. Nothing here is new design: it is the
contract the code already enforces, written in one place so a title is
built against it rather than against one of the paths that happened to
exist first. Where a shipped title falls short, the gap is named.

Enforced by: `node/settle.js` (intake), `protocol/result.js` (the result
commitment and the official rule), `titles/title.js` (the title contract),
`node/matchbook.js` + `contracts/MatchBook.sol` (the chain lifecycle),
`sdk/conformance.mjs` (admission). Tests: `demo/settle.test.mjs`,
`demo/attested.test.mjs`, `demo/matchbook-node.test.mjs`,
`demo/publisher-offline.test.mjs`.

## 1. One envelope

A match reaches a node as one HTTP body on `POST /ledger`, in one of two
shapes. There is no third intake. Bridges (`sdk/bridge/`), gauntlet servers
(`node/gauntlet.js`), the arcade client (`sdk/client.js`) and import tools
all produce one of these.

**Replayable** — the node can re-run it:

```json
{ "matchId": "<64 hex>", "rulesetId": "<id>.v1", "buildHash": "<64 hex>",
  "mode": "ranked" | "casual",
  "participants": ["<player key>", "<player key>"],
  "entries": [ { "k": 0, "inputs": [<p0>, <p1>] }, ... ],
  "signatures": { "<player key>": "<sig over the ledger body>" },
  "relay": { "id": "<relay key>", "sig": "..." },
  "hydration": { ... }, "expected": { "hash": "...", "endTick": 0 },
  "room": "LIT-..." }
```

**Attested** — the node can only check it against the rules:

```json
{ "kind": "attested", "matchId": "<64 hex>", "rulesetId": "<id>.v1",
  "mode": "ranked" | "casual",
  "participants": ["<player key>", ...], "teams": [["..."], ["..."]],
  "report": { ... what the title's validate() reads ... },
  "attestor": { "id": "<court key>", "sig": "..." } }
```

The ledger body a player signs is `{ matchId, ticks, head, buildHash }`
under the `ledger` tag (`npm run bridge -- body <file>` prints it; in the
arcade the shell signs it, `cabinet:sign`).

## 2. One identity

A participant is an ed25519 public key, 64 hex. That key signs queue
entries, seat challenges and ledger heads; `PlayerProfile` binds it to a
wallet; rewards, profiles and the universal ladder fold by it.

- **Ranked requires keys.** `settle.js` refuses a ranked submission whose
  participants are not keys (`ranked: participants must be player keys`).
- **Casual may name anything** (`pb:<AIR sub>`, `af:<name>`), labelled as
  such; those rows never bind to a profile and never count for rewards.
- Sign-in is a product choice (AIR, a wallet, a local key); the identity
  the mesh settles is the key the sign-in produced.

Gap: Pickle Brawl's court reports `pb:<AIR sub>` seats for matchmaker-formed
matches, so those rows cannot bind to a profile. The arcade already seats a
court with the player key (the join ticket's `sub`); the court's reporter
should carry that key through to `participants`. This is a change in the
Pickle Brawl repository, not in the node.

## 3. One result

Every settled match becomes a delta whose `resultHash` commits to everything
a ranking or a settlement consumes (`protocol/result.js resultFields`):
protocol version, match binding (`descriptorHash`), build, kind, mode,
participants and teams, seed, ticks, head, final state root, engine hash,
hydration, scores, attestation, attestor, relay, host, epoch. A witness
recomputes every field itself and signs only `{ matchId, resultHash }`.
A dispute is over the same pair.

## 4. Three provenances, one ladder policy

What backs a result is recorded, never upgraded, and decides where it ranks.

| `attestation` | Who vouches | Witness does | On MatchBook | OFFICIAL |
| --- | --- | --- | --- | --- |
| `players` | both players signed the ledger head | replays the log in the sandbox | yes, when ranked and placed with a 3-seat panel | yes |
| `relay` | a relay key the host trusts; its record must match the replay | replays | never | no |
| `attested` | an authorized court signed the report | validates against the rulebook only (`attestation-only`) | possible for a ranked mesh placement; never official | no |
| `host` | this node's word | nothing | never | no |

`isOfficial` = `attestation === 'players'` and `verification === 'verified'`
(an independent witness reached the same commitment and no dispute
outweighs it), and the match was ranked and placed. Everything else is on
the title's own ladder (`scope=all`), labelled.

A title states its tier by the function it exports: `defineTitle` is
replayable, `defineAttestedTitle` is attested. The arcade shows an attested
title's ladder as attested. The path from attested to replayable is a build
change on the title's side (seeded randomness, integer or fixed-point math,
an input log) and a new build hash; old results are never relabelled.

## 5. Placement binds a ranked match

Ranked requires a placement the mesh computed from the chain beacon: the
participants, ruleset, build, mode, seed `H(beacon, matchId)` and host are
fixed before play, signed in a descriptor, and the submission must match it
(`placed: true`, `descriptorHash` in the commitment). An unplaced submission
settles casual, `placed: false`, and never reaches official standings.

What the host binds to (0.11.31): the placement in its own book, or — once
an earlier rival for the same players replaced it, its 15 minutes ran out,
or the node restarted — the signed descriptor the client carries back from
`GET /match` (`envelope`) as the submission's `descriptor`, verified as a
witness verifies it: signature, protocol, the placing key bonded in the
live stake table or at the descriptor's pinned block, the beacon this node
holds for the bucket, and an id the beacon derives for the two players.
Where the result then goes is the chain's call: a commit under the ledger's
id is settled on chain; none, and the result stays on the host; a commit
under another id for the same players (a placement replaced after a client
had fetched it) is never settled and expires on its own after the settle
window. The book is not persisted: the ledger is the proof of placement,
the chain is the record of the commit.

Only a host with three drawn witnesses under other operators commits on
chain; with fewer online the match plays casual-only and the arcade says so
before the queue.

## 6. The chain lifecycle

For a placed ranked match, in order, each from the node's delegated key:

1. `commit(matchId, descriptorHash, rulesetId, hostKey, panel[3])` before play;
2. `settle(matchId, resultHash, ledgerHash, buildHash, participants, scores, custodians)` after the host's own replay;
3. `attest(matchId, witnessKey, resultHash)` from each seat after fetching the ledger, checking its hash and replaying;
4. `finalize(matchId)` by the host, or by a seat when the host is gone (the liveness backstop);
5. on a dissent, `escalate` with the ledger, a nine-seat stake-weighted draw, `resolve`; slashing through NodeStake v3;
6. `GasRefund.claim` by the host and the agreeing seats;
7. the hour's finalized set goes under one `EpochAnchor` root, proposed by the settler, finalized at stake quorum.

Nothing per match is minted. The event log is the record; XP, level, Elo,
credits and stats are folds over it (`protocol/derive.js`,
`protocol/progression.js`) that every node reaches identically, and
`GET /progress` serves them.

Casual matches never enter this lifecycle. They settle on the host, carry
the host's signature and whatever provenance they had, and are lost with
the host. Open decision as of 19 Oct 2026: anchor them under a per-host
hourly root, or say in the arcade that casual history is not kept.

## 7. The title's side

A title ships one of two artifacts, both pinned by hash on `TitleRegistry`:

- **Replayable:** one import-free ES module exporting `defineTitle({...})`
  with `init / step / done / serialize / scores / view`; passes
  `npm run conformance`; bundled by `npm run bundle:title`. Nodes fetch it
  from peers by hash and run it only in the sandbox.
- **Attested:** one module exporting `defineAttestedTitle({...})` with
  `validate(report)` and `scores(report, participants, teams)`; the same
  conformance and bundling.

A title whose match server is a process (a gauntlet) also ships that
process, as a **server bundle** (`node/server-bundle.js`; built 19 Oct
2026, after the audit of that day named the gap):

- **Shape.** One deterministic tar (gzipped for transport): `manifest.json`
  `{ kind: 'server', rulesetId, entry, runtime, env, portRange, readyMs,
  ttlMs, ticketTtlMs, settledGraceMs, source }`, the server bundled by
  esbuild into plain JS with its dependencies inlined, and the data files
  it reads beside itself. No node_modules, no install step: everything that
  executes is inside the hashed bytes, and a node never runs npm.
  `npm run bundle:server -- gauntlets/<id>.server.json` packs it and
  prints the hash.
- **Hash.** `serverHash = sha256('server' NUL tar)`, the same tag-prefixed
  scheme as `H('ruleset', source)`, over the uncompressed tar, so the same
  checkout and esbuild reproduce it anywhere.
- **Registered** under the SAME `TitleRegistry` token with the existing
  `setBuild` (`npm run publish:title -- set-build servers/<id>.server.json`)
  and admitted by the existing `buildStatus`. No contract change and no
  kind tag: the kind is in the hash domain (a server hash can never verify
  as a ruleset or the reverse) and in the manifest, which must name the
  title it is registered under. A later bundle waits `activationDelay`; a
  revoked one stops being fetched at once.
- **Fetched** from any peer that holds it (`GET /server/<id>?build=<hash>`,
  advertised in the heartbeat as `servers`), kept under
  `<dataDir>/servers/<hash>/`, never evicted.
- **Run only by a node that opted in** (`GAUNTLET_SERVERS=<id>`). This is
  the one place the trust boundary differs from a ruleset's: a ruleset is
  admitted by the sandbox; a server is a trusted process with a port and
  the network, so admission is the publisher's registration (or a
  `TRUSTED_PUBLISHERS` signature) plus the operator's opt-in, and
  `TITLE_TRUST=open` does not extend to it.

Still machine-local: a gauntlet config that points at a checkout
(`gauntlets/<id>.json`) for a server the publisher has not bundled, and a
court key a server needs (Pickle Brawl's) — a bundle gets a per-title
state directory on the node for that (`GAUNTLET_STATE_DIR`), but the
operator still provisions the key and lists it in `COURTS`.

## 8. Conformance of the two shipped titles

| Rule | Agent Fighter | Pickle Brawl |
| --- | --- | --- |
| One envelope | three producers (relay + af-watch, gauntlet server, import); all produce the replayable envelope | the court produces the attested envelope; it also posts to the publisher's API |
| One identity | player keys since M0 (5 Oct 2026) | keys for arcade-placed matches; `pb:<AIR sub>` for matchmaker-formed matches |
| One result | yes | yes |
| Provenance | `players` (gauntlet), `relay` (relay path) | `attested` |
| Placement binds ranked | yes | ranked placements possible, none settled yet |
| Chain lifecycle | yes (2 final matches) | never reached |
| Hashed artifact | ruleset yes; server no (checkout per operator) | ruleset yes; court no |

What closes the gaps: retire the Agent Fighter relay intake once the
gauntlet runs on two or more operators; carry the player key through
Pickle Brawl's court reports; make Pickle Brawl replayable (the engine is
bit-exact across Node versions per the 9 Oct 2026 spike); ship match
servers as hashed builds.

## 9. Change control

The protocol version (`protocol/version.js`, 3) is in every signed body
and in the result commitment. A change to any shape above, to the result
fields, to the provenance rules or to the official rule is a protocol bump,
noted in CHANGELOG under the release that ships it, and every node refuses
peers on another version. Titles are certified by the conformance suite,
not by review.
