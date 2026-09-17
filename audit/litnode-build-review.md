# litnode build review — 17 September 2026

**Verdict: a credible prototype for a community-operated gaming service, with useful discovery and replay machinery. It is not ready for permissionless title execution, authoritative competitive settlement, or a production claim of publisher independence.**

I read the [litnode 0.7 Live Build artifact](https://claude.ai/artifact/ViKUCMBk39VrYVWPJ8KSGe), the [whitepaper](https://www.litvm.games/whitepaper/), and its [proposed ERC-6699 interface](https://www.litvm.games/whitepaper/#article-vi). I inspected this workspace, ran harmless local probes, and read the existing local node's health and peer endpoints. This is a focused engineering review, not a comprehensive contract audit or a live two-player acceptance test. No running service was reconfigured and no chain transaction was submitted.

## What deserves credit

The architecture has a useful separation: games keep their frame-by-frame simulation; nodes discover peers, select hosts, replay inputs and sign results; a chain stores commitments. Running every frame on chain would be a different and much more constrained design.

NodeDirectory addresses a real operator problem: a machine can retain its identity when its reachable URL changes. Delegating announcement authority avoids using the operator wallet for every address update. Hash-pinned rulesets, a client that recomputes placement, explicit attestation types, and signed release manifests are substantive engineering work. The current source also provides a scaffold and conformance suite for title developers.

The artifact deserves credit for admitting the missing complete live match, old peer versions, lack of player signatures, dependence on Cloudflare, exposed deployer key, and absent monetization. Its timings are explicitly single observations rather than benchmarks. These qualifications should remain prominent in product messaging.

## Evidence boundaries and current state

- Artifact: claims v0.7.0, three fresh bonded nodes, two operators, 51 tests, and 27 conformance checks; §8 says the complete latest two-player flow is still pending.
- Workspace: package version 0.7.0; HEAD `c915601ee3b3ecb0b9941b516d5ec3f08843673a`; substantial pre-existing modified and untracked files, including the SDK and conformance tests. HEAD alone does not reproduce this working tree.
- Local read during this audit: `http://127.0.0.1:7801/health` reported **0.6.5**, bonded; `/peers` returned **one entry, the node itself**. This does not prove the artifact's earlier snapshot was false, but it does not corroborate a currently healthy three-node v0.7 deployment. See [snapshot](./live-node-snapshot.json).
- Existing documentation lags: SPEC says directory/profile deployment is pending while the deployment manifest lists them. Do not use one document's status labels as the release source of truth.

## Red flags, ranked by consequence

### 1. Critical for open hosting: conformance is not isolation

[sdk/conformance.mjs:49](../sdk/conformance.mjs) records a purity failure, then imports the source at line 54. The node supplies a normal, in-process import in [node/litnode.js:119](../node/litnode.js). Rejected code can already have executed. My harmless probe set an in-memory marker before rejection; a separate bracket-notation call to randomness passed all 27 checks.

Consequences: a hostile or compromised publisher can run code with the node process's authority or hang it. Bonding and matching a hash do not make software safe. Two short deterministic replays do not prove all-input determinism, resource bounds, or confidentiality of hidden state. Replace the artifact's claims that impurity is impossible to fake with the narrower statement that the suite catches selected mistakes. Use an isolated, capability-restricted runtime with enforceable CPU/memory/time limits before open title intake.

### 2. High: a witness can co-sign a false score

[node/settle.js:145](../node/settle.js) verifies the host signature and replay root, but does not compare the recomputed scores with `delta.scores`. My probe changed the scores, signed the changed delta using a temporary host key, and the independent witness accepted it. [protocol/derive.js](../protocol/derive.js) consumes those score fields for rankings.

This assumes a malicious or compromised host, exactly the actor independent verification should constrain. Recompute and compare the entire canonical outcome, including scores and attestation evidence, and sign the complete result commitment. The witness currently also does not independently verify player ledger signatures in its replay branch.

### 3. High: a labelled relay result need not come from a relay

The public [POST /ledger route](../node/litnode.js) passes the body into settlement. [node/settle.js:123](../node/settle.js) accepts `expected: {}` because both expected fields are optional, and labels the result `relay`. My local probe supplied no player signatures and zero input ticks; it was accepted as ranked and produced two default leaderboard rows. No terminal-state requirement or assigned-match authorization blocked it.

Require authenticated relay provenance or the required player signatures, an existing authorized match descriptor, valid participants and a finished result. Keep insufficiently attested submissions out of official standings. Enabling the existing co-sign filter alone does not repair the witness's incomplete validation. For attested titles, signature validity also needs a check that the signer is an authorized court; the current intake checks the supplied public key against its own signature.

### 4. High: anchoring proves inclusion, not correctness or consensus

[EpochAnchor.sol:29](../contracts/EpochAnchor.sol) lets any address write the first nonzero root for any epoch. There is no bond check, witness-quorum verification, epoch finalization rule or challenge process. An arbitrary early submission can occupy an epoch and prevent the intended root from being registered. This is disclosed in the contract comments, but its product implications deserve equal visibility.

An inclusion proof means a leaf belongs to a committed batch. It does not prove the match happened fairly or that independent operators agreed. Define authorized submission, complete signed leaf semantics, custody, epoch closure and dispute resolution before using roots for rewards or canonical records. Late co-signatures also change locally reconstructed leaves, so historical proofs need an explicit finalized batch.

### 5. High: the character registry does not establish trusted competitive provenance

[ERC6699Registry.sol:51](../contracts/ERC6699Registry.sol) permits anyone to forge an unused ID with arbitrary stats, owner and controller. `equip` checks control of the character but not ownership or authorization for the referenced item. There is no full ERC-721 implementation, authenticated progression update path, config-content hash, or functioning identity-attestation write path.

Moreover, [node/settle.js:51](../node/settle.js) builds hydration from submission-provided agent data. The independent registry lookup helper in [protocol/hydration.js](../protocol/hydration.js) exists but is not wired into the node settlement path. Thus the artifact's statement that every title receives registry-derived stats is stronger than this implementation supports. A matching hydration hash can merely mean two nodes hashed the same supplied claims.

### 6. High operational risk: acknowledged exposed authority

Artifact §8 reports that the deployer key was exposed and rotation deferred. Treat its remaining authority as compromised until ownership, slash permissions and delegates have been migrated or replaced and checked on chain. I did not inspect or reproduce the key and did not verify rotation status. Testnet limits financial exposure; it does not make integrity evidence from compromised authority trustworthy.

The artifact also says both “two operators” and that this wallet operates “every bonded node.” Those statements need reconciliation with a block-pinned ownership snapshot. The separate release signing key is a fleet-wide authority too; its exposure is not alleged here, but its compromise would authorize software distribution to updating nodes.

### 7. Availability is still concentrated

Artifact §§1 and 8 describe one gameplay relay on the desktop, two quick tunnels, a watcher bridging the studio database, and Cloudflare dependency. Direct browser-to-browser gameplay is not implemented in this repository. Losing that desktop still removes the reported gameplay path even if other machines retain rulesets.

[Cloudflare documents Quick Tunnels as development/testing only](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), with no uptime guarantee and a 200 in-flight request limit. That limit is not a measured player capacity. Public discovery helps people locate surviving hosts; it cannot create a surviving host. Demonstrate another operator taking over gameplay, frontend/assets and retained match evidence before claiming the game survives its publisher.

### 8. Discovery and rollout need stronger verification

[cabinet/seeds.js:38](../cabinet/seeds.js) treats any successful `/health` response as reachable; it does not prove possession of the directory node's signing key. [cabinet/client.js](../cabinet/client.js) recomputes placement from the supplied snapshot; this is useful consistency checking, but does not independently establish that the supplied membership and beacon are authoritative. The artifact's statement that readers verify identity upon arrival needs a stronger implementation, such as a signed challenge bound to the expected directory identity.

Old and new placement rules must not quietly coexist in competitive matches. Pin a protocol version in signed descriptors, enforce compatibility, test upgrades on a small group first and expose incompatible nodes. Ten signed releases in a day demonstrates iteration speed, not fleet compatibility or rollback safety.

## How someone uses this — plain language

Think of an arcade with a receptionist, a game table, a second referee, and a receipt book.

1. **Player:** open the cabinet, choose a supported game and find a match. The browser creates a signing identity and asks the directory where active nodes are. Players do not need to operate a node.
2. **Match assignment:** nodes choose opponents and a host. The browser recomputes the selection as a consistency check. The game must understand the assigned room, relay address and player identity.
3. **Gameplay:** the current Agent Fighter path uses its WebSocket relay. A recording of inputs becomes a ledger, currently transported by the watcher bridge.
4. **Checking:** a node replays those inputs using the exact game rules. A witness repeats the check. Today the gaps above mean this is not yet sufficient evidence for authoritative competitive results.
5. **Receipt:** rankings are calculated from stored outcomes; an operator can anchor a batch fingerprint on testnet. A batch receipt is not a payment.

**Operator:** run the portable node, give it the appropriate roles, arrange reachability, bond its identity on testnet and delegate a limited announcer if needed. Keep it online and inspect health/version/peers. Running a witness does not automatically install or operate every game's relay. No operator payout mechanism is implemented.

**Developer:** scaffold a title, implement deterministic game rules, run conformance, bundle and hash it, load it on a bonded node, and connect the actual game client and result submission flow. The existing `create-title`, `conformance` and `bundle:title` scripts are useful starting points. They do not automatically port an arbitrary engine, secure its code, host its art, supply its transport or prove a finished integration.

## Why proposed ERC-6699 matters

[Article VI](https://www.litvm.games/whitepaper/#article-vi) proposes a shared character record: four normalized attributes, progression, equipment references, a character configuration URI, a personality-document hash and a controller address. Each game interprets the shared attributes through its own balance rules.

For a simple example, imagine one character entering a fighter and an RPG. The same agility record could influence action timing in the fighter and movement in the RPG. These are possible mappings, not claims that either production title currently implements them. The shared record avoids separately inventing ownership and character metadata for every integration.

litnode could supply the missing operational part: locate games and operators, obtain the exact rules, verify matches and produce evidence that an authorized progression system can consume. The standard describes the character; nodes perform and check work involving that character. Together, if completed, they can reduce dependence on one studio's database and support independently implemented titles.

However, a shared integer range is not shared balance. Games still need compatible schemas, bounded mappings, item admission rules, model/runtime versions, authority over progression and cross-title inflation controls. A hash detects a changed document; it does not keep the document available, hide a prompt from the host, or force an AI model to obey it. TEE and autonomous-agent guarantees are not established by a Solidity interface.

The whitepaper correctly says **proposed**. I found no 6699 entry in the [official ERC index](https://ercs.ethereum.org/all) during this review. Describe it as the project's proposed interface; official number assignment, draft acceptance and ecosystem adoption are unverified.

## What I would require for the next milestone

1. Resolve compromised authority; isolate title execution; fix result authentication, full witness validation and ranked eligibility.
2. Pin and publish a reproducible release with exact source/build hashes, compatible peer versions, full transaction links and a current operator snapshot. Reconcile README/SPEC/artifact status.
3. Record the complete two-player journey across independent networks: placement, gameplay, player signatures, witness validation, leaderboard entry and finalized inclusion proof. Repeat with relay loss, reconnect, bad inputs and disagreement.
4. Demonstrate a second independent gameplay host and durable custody after shutting down the original publisher services. Measure repeated success rate, tail latency, recovery time and resource cost under defined load.
5. Demonstrate one authentically hydrated character in two genuinely different titles, with bounded mappings and an authorized progression update. This would be much stronger ERC-6699 evidence than adding more contract deployments.

The product description I would use today: **“A testnet arcade-node prototype with chain-based discovery, signed updates and replayable match records, working toward community hosting and portable game characters.”**

## Reproduction

Run `node audit/litnode-probes.mjs` for the four harmless probes. Results are saved in [probe-results.jsonl](./probe-results.jsonl). These tests use temporary audit keys and local settlement stores; they never submit to the live API or chain. Test-run evidence is in [bounded-test-output.txt](./bounded-test-output.txt). Verification status is recorded in the companion verification note.
