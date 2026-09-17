# Remediation of the 17 September 2026 build audit

Companion to [litnode-build-review.md](./litnode-build-review.md). Same
standard: what is implemented, what is deployed and what is demonstrated are
three different columns, and this document keeps them apart.

## Revision

| | |
|---|---|
| source | `strodanodev/litnode` master, commits `53bd257` → `b3469c1` → `c4acf48` → this one (docs), on top of audited HEAD `c915601` |
| package version | 0.8.0 · **protocol version 2** (`protocol/version.js`) |
| ruleset builds | `agent-fighter.v1` `859e7215418db6473f0ceb1a88a1f51dc279db1974636c2262f547fcafca76da` · `pickle-brawl.v1` `db035b782d23e85d4dcfdab0b2364f9e4f1c828b3dd8b2217c25b62cf0e1cb2e` · `tug.v1` `94aee45adbfc68604209a407a63e25c184844526ee87110224d41febc52af218` — bytes unchanged from the audit; sidecars now carry a publisher signature by the release key `4d8759b0…` |
| tests | 61 passing, 1 skipped (manual), 0 failing; 19 suites run one file at a time; 248 s on the audit machine (`npm test`) |
| deployed contracts | **unchanged: the v1 set** listed in `contracts/deployed.testnet.json` (Liteforge 4441). The v2 contracts in this source are compiled and tested against mocks only. |
| running nodes | desktop `5b703f12…` was on **0.6.5** during this work and has not been updated to 0.8.0 (see "what was deployed"); the two laptop nodes were offline (desktop `/peers` listed only itself, as the audit also observed) |

## What changed, per finding

### 1 — Conformance is not isolation → title code no longer runs in the node

- `node/sandbox.js` / `node/sandbox-child.mjs`: every execution of title code
  (manifest read, conformance replays, settlement replay, witness replay,
  attested `validate`/`scores`) is a separate `node --permission` process
  with an empty environment, `--max-old-space-size` (default 256 MB), a
  parent-enforced deadline (default 10 s), no addons, code generation from
  strings disabled; inside it a `vm` context with ECMAScript intrinsics only
  and `Date`, `Intl`, `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`,
  `Atomics`, `eval`, `Function` removed and `Math.random` replaced by a
  throwing function; all data crosses as JSON text. `fetch`, `WebSocket`,
  `process.getBuiltinModule`, `process.binding`, `process.dlopen` are deleted
  in the child before the artifact is parsed.
- `sdk/conformance.mjs`: STATIC stage (no execution) then SANDBOX stage. The
  purity regex is documented as a lint. `installRuleset` refuses statically
  before handing bytes anywhere, and remembers refusals by hash.
- Trust policy: `TITLE_TRUST=trusted` (default) admits a peer's build only
  with `sign('build', {rulesetId, buildHash})` by a key in
  `TRUSTED_PUBLISHERS`; local `RULESETS` load regardless; `TITLE_TRUST=open`
  is the operator's explicit choice.
- Regressions: `demo/audit.test.mjs` probes 1–2 (pre-rejection execution
  now impossible in-process; `Math['random']` fails at run time in the
  sandbox); `demo/conformance.test.mjs` (static vs sandbox refusal, the node
  refuses both, a spinning title is killed at the deadline, a hungry one
  aborts at 64 MB, none blocks the node, no host global is visible to a title).
- **Acceptance met**: rejected modules execute no code in the node process;
  an adversarial title sees no filesystem, network, process or clock, and
  cannot block the daemon (kill on deadline). **Boundary stated honestly**:
  a V8 escape is out of scope, which is why trusted publishers remain the
  default gate.

### 2 & 3 — Result authentication and witness verification

- `node/settle.js` rewritten. A submission is bound to the mesh's sealed
  placement descriptor (participants as a set, rulesetId, buildHash, mode,
  host = this node, beacon and its block, protocol version); seed =
  `H(beacon, matchId)`; a ranked submission without a descriptor is refused;
  an empty log is refused; an unfinished ranked log is refused; ranked
  participants must be player keys.
- Provenance: `players` (both signatures verified at intake and again by
  every witness over the build and hydration hash), `relay` (a relay key in
  the host's `RELAY_KEYS`, advertised in its heartbeat, signed
  `{matchId, head, ticks, expected}`; `expected` alone establishes nothing),
  `host` (casual only), `attested` (signer must be in the manifest's
  `attestors` or the node's `COURTS`).
- `protocol/result.js`: `resultHash` over every field a ranking or
  settlement consumes; the witness recomputes all of them (binding, its own
  registry reads, its own sandboxed replay, provenance) and signs
  `{matchId, resultHash}` only on a byte-identical commitment; otherwise a
  signed dispute goes to `POST /dispute`. `acceptCosign` recomputes the
  commitment from the stored delta.
- Official standings by default: ranked + placed + `players`/`attested` +
  ≥1 independent co-signature + not disputed. Everything else is labelled.
- Regressions (`demo/settle.test.mjs`, `demo/audit.test.mjs`,
  `demo/attested.test.mjs`): empty unsigned ranked `expected:{}` → 400;
  unplaced ranked → 400; complete unsigned ranked → 400; rogue relay key →
  400; stranger's signature → 400; participants ≠ placement → 400; tampered
  entry → 400; altered scores → witness refuses and files a dispute; altered
  ticks → same; attestation claimed `players` without signatures → refused
  at the witness; valid signature from an unauthorized court → 400; a node
  with no authorized court refuses the title's reports; a disputed delta
  leaves the official ladder.
- **Acceptance met** for the listed probes.

### 4 — Epoch finalization and settlement authority

- `contracts/EpochAnchor.sol` v2: `propose(epoch, root, nodeKey)` only by
  the operator of an actively bonded key, one proposal per operator per
  epoch, finalized at `quorum` distinct operators, conflicts visible.
- Node: hours freeze 15 minutes after they end (`data/epochs/<hour>.json`);
  leaves commit to `resultHash`, `verified` and the witness set as of the
  freeze; late co-signatures never move a leaf; `/proof` reports
  `finalized`/`open`, `verified`, `cosignersAtFreeze` vs `cosignersNow`.
  `tools/anchor-epoch.mjs` proposes frozen batches only and reports support.
- Migration designed in `contracts/MIGRATION.md`; the one existing v1 anchor
  (epoch 497006, 12 Sep) is recorded as protocol-1 history.
- **Acceptance**: unauthorized roots are rejected **by the v2 contract in
  source** (compiled; not deployed); conflicting results follow the defined
  dispute rule; finalized proofs reproduce from the frozen batch
  (`demo/custody.test.mjs`). On Liteforge, v1 remains until the migration
  is executed.

### 5 — Character hydration

- `protocol/registry.js` + `chain.agentAt`: block-pinned reads of
  ERC6699Registry v2 (`ownerOf`, `coreStats`, `manifestOf` with config hash
  and nonces, `equipped` per slot); `mayPlay` requires the player key's
  PlayerProfile owner to own or control the token. Wired into settlement
  and the witness. Submitted stats are ignored when a registry is configured;
  submission-only characters are `fixture`, refused in ranked, always
  labelled (`hydrationSource`, per-entry `source`).
- `contracts/ERC6699Registry.sol` v2: MINTER-only `forge`, PROGRESSOR-only
  `progress(tokenId, stats, expectedNonce)`, `characterConfigHash`,
  `statsNonce`, `manifestNonce`, item ownership on `equip`, explicit
  ownership and `transferFrom`.
- `demo/hydration.test.mjs`: inflated stats do not survive; a token the
  player neither owns nor controls is refused; an unknown token is refused;
  reads are pinned to the placement block; the witness reads the same block
  and agrees.
- **Acceptance met against a mock registry**; **not demonstrated on
  Liteforge** — v2 is not deployed and `ERC6699` is unset on every node, so
  live hydration is labelled `fixture`/`external` and no live ranked result
  is registry-verified today.

### 6 — Compromised authority

- `npm run authority` (read-only) at block **51790431**: the exposed
  address `0xa6d840…` still holds NodeStake `slasher`, `treasury` and the
  desktop node key's operator binding; EpochAnchor v1 and ERC6699Registry v1
  have no authority at all (anyone may anchor / forge). Snapshot:
  `audit/authority-51790431.json`.
- NodeStake gains `transferOperator`; `deploy:testnet --fresh` deploys the
  v2 set from a new wallet and archives the old addresses; the runbook
  (§5.2) and `contracts/MIGRATION.md` give the exact sequence.
- **Not executed.** It needs a new funded wallet and its key in a shell —
  a user action; nothing in this session touched the chain beyond reads.

### 7 — Availability concentration

- `tools/custody.mjs` export/import/verify and `demo/custody.test.mjs`:
  a keeper node started from an archive alone re-verifies every commitment
  and serves the finalized proof after the host is shut down.
- **Not demonstrated**: a second independently operated gameplay relay,
  gameplay continuing with the publisher's relay and services down, a
  replacement for Quick Tunnels. These need a second operator's machine
  and line; the runbook §6 is the procedure.

### 8 — Discovery and rollout

- Proof of possession: `GET /whoami?nonce=`; nodes (`admitSeed`) and the
  hosted cabinet (`seeds.reachableSeed`) require it before a directory URL
  becomes a peer (`demo/discovery.test.mjs`).
- Clients re-verify membership from signed heartbeats
  (`/snapshot?envelopes=1`) and check a chain beacon against the block the
  descriptor names; the bonded set they fold is still the node's read of
  NodeStake and is labelled `stakesFrom: 'node'`.
- Protocol version pinned in heartbeats and descriptors; incompatible peers
  listed and excluded; descriptors on another protocol not adopted.
- Releases: canary channel, protocol floor, one-step rollback, release-key
  rotation and retirement carried in signed manifests (`demo/update.test.mjs`).

## What passed

`npm test` — 19 suites, 61 tests passed, 1 skipped (the manual imported-
ledger check), 0 failed, 248 s. The audit's four probes are asserted
fail-closed in `demo/audit.test.mjs`. The suite hang the audit reported
(and this session reproduced in `client.test`) was keep-alive sockets
holding `server.close()`; `stop()` now closes all connections.

Measured on the audit machine (single observations, not benchmarks):
sandbox process start + manifest read 49 ms; a full Agent Fighter match
(5,604 ticks) replays in the sandbox in 80–94 ms against 63 ms in-process
(the audit machine's measured play); the 28-check conformance suite over
Agent Fighter's 93 KB build takes 122 ms; a spinning title is killed within
~20 ms of a 1,500 ms deadline; a 64 MB heap bomb aborts in ~120 ms.

## What was deployed

Nothing on chain. The desktop node was not updated during this work: it is
on 0.6.5, protocol 1, and once a 0.8.0 release is published and applied it
will list any 0.6.x laptop as incompatible until those update too. The
cabinet on Vercel was not redeployed (its `client.js`/`seeds.js` changes —
proof of possession, verified snapshots, verification labels — ship with
the next `vercel deploy --prod` from `cabinet/`).

## What remains unresolved

1. **Authority rotation / v2 migration** — designed and tooled; not
   executed (needs the user's new wallet). Until then the exposed key holds
   what the snapshot lists and the v1 anchor/registry stay open to anyone.
2. **Registry hydration on Liteforge** — reads nothing until v2 is deployed
   and nodes set `ERC6699`; then a minter and a progressor must be named and
   at least one character forged for a live ranked match to be
   registry-verified.
3. **Agent Fighter player signatures** — the AF client still does not sign
   the chain head, so every live AF result is `relay`-attested: authenticated
   (relay key) but unofficial. The honest path is the SDK contract
   (`{matchId, ticks, head}` reported to the shell; the cabinet signs).
4. **The complete two-player demonstration across independent networks**
   (placement → gameplay → signatures → witness → official ranking →
   finalized proof) has not been run live. Every stage is exercised in
   tests on one machine; the live run needs the laptops on 0.8.0, item 3,
   and an hour for the freeze.
5. **Second operator, second relay, no Quick Tunnels** — procedure written,
   not done.
6. **Two-title demonstration with one authenticated character** — needs
   items 1–2; TUG is the second title in source and reads `ctx.agents`
   through `defineBalance`, but no authorized progression update exists yet.
7. **Load, success-rate, tail-latency and recovery measurements under a
   documented workload** — only the single observations above.
8. **Slashing** — disputes are recorded and exclude results; nothing slashes,
   and the slasher is the exposed key until item 1.

## Wording

Throughout the repo, "ERC-6699" is now described as this project's proposed
interface; no number in the official ERC index is claimed. No rewards,
reserve backing, universal interoperability or publisher independence are
claimed beyond the tests and snapshots cited here.
