# sdk/court — the court client for an attested title

An **attested** title is one whose outcome only the studio's own server can compute (float physics, a closed
engine, no replayable input log). That server is the title's **court**: it holds an ed25519 key, signs an outcome
report, and posts the envelope to a bonded litnode's `POST /ledger`. The node checks the signature against the
courts its operator authorised (`COURTS=<rulesetId>:<court public key>`), runs the title's ruleset `validate()`
in its sandbox, and settles the match labelled `attested`, never official.

This folder is that court's client. One file (`index.js`), plain ESM, zero dependencies, no `node:` imports and
nothing from `../../protocol`, so a studio can **vendor the folder as is**. It runs on Node 20+ and in a browser
(WebCrypto needs https or localhost there). Types are in `index.d.ts`.

```js
import { attest, makeCommitments, settle } from './vendor/litnode-court/index.js';

const identity = JSON.parse(process.env.COURT_IDENTITY); // { publicKey, privateKey }, from `npm run bridge -- key --kind attested --ruleset my-game.v1`
const report = {
  matchId, /* … what your ruleset's validate() checks … */
  commitments: await makeCommitments({ logFormat: 'my-game-inputs.v1', log: logBytes, finalHash, verifierHash: null }), // optional, settlement v4
  stats: { [`mg:${playerId}`]: { kills: 3, saves: 1 } },                                                                    // optional, settlement v4
};
const env = await attest({ matchId, rulesetId: 'my-game.v1', mode: 'casual', participants, teams, report }, identity);
const r = await settle(env, { log: logBytes }); // node: 'auto' finds a live settler on NodeDirectory
// r.status: 'settled' | 'already' | 'refused' | 'unreachable'
```

## The contract

| | |
|---|---|
| envelope | `{ kind: 'attested', matchId, rulesetId, mode, participants, teams?, report, attestor: { id, sig } }` |
| signature | ed25519 over UTF-8 `"attest" ‖ 0x00 ‖ canonical({ matchId, rulesetId, report })` — canonical = JSON with object keys sorted recursively, `undefined` and functions dropped. Byte-for-byte `protocol/keys.js` `sign('attest', …)`; `demo/court.test.mjs` checks it. |
| `report.commitments` (v4) | `{ logFormat, inputsHash, finalHash, verifierHash }`; `inputsHash` = lowercase hex sha256 of the **exact** log bytes, or `null`. Inside the signed report, so any node version accepts it. |
| `report.stats` (v4) | `{ <participant>: { <name>: <non-negative integer> } }`, at most 32 names per participant, names `^[a-zA-Z][a-zA-Z0-9]{0,31}$`. |
| `log` (v4, top level) | base64 of the exact log bytes, ≤ 512 KiB decoded, sha256 = `report.commitments.inputsHash`. `settle()` sends it **only** when the node's `GET /health` says `protocol >= 4`; such a node serves it back at `GET /log/<inputsHash>`. |
| answers | 200 the delta (or the delta it already holds for that matchId) · 400 `{ error }` refused · 403 no settling role · 429 back off |

## API

**Signing**
- `canonical(value) → string`
- `signReport({ matchId, rulesetId, report }, identity) → Promise<{ id, sig }>` — `identity` is `{ publicKey, privateKey }` (64-hex each, the raw ed25519 seed) or `{ publicKey, sign(bytes) }` for a key in a KMS/HSM. A key file whose two halves do not belong together is refused here, not by every node later.
- `envelope({ matchId, rulesetId, mode = 'casual', participants, teams?, report, attestor, meta? }) → object` — throws a `TypeError` listing every problem (`checkEnvelope` returns them instead).
- `attest(fields, identity) → Promise<envelope>` — `signReport` + `envelope`.
- `checkReport(report, participants?) → string[]` — the v4 `commitments` / `stats` shape; the rest of the report is your ruleset's business.
- `verifyEnvelope(env)`, `verifySignature(tag, body, sig, publicKey)` — the node's check, for your tests.

**Input log (settlement v4)**
- `inputsHash(bytes) → Promise<hex>` (WebCrypto sha256)
- `encodeLog(bytes) → base64` — `RangeError` past `LOG_MAX_BYTES` (512 KiB); `decodeLog(b64)`
- `makeCommitments({ logFormat, log?, finalHash?, verifierHash? }) → Promise<commitments>` — computes `inputsHash` from the bytes so it is never typed by hand.

**Discovery**
- `findSettler({ rulesetId, contracts?, contractsUrl?, rpc?, fetch?, exclude?, concurrency = 4, maxRps = 8, backoffMs = 500, keysPage = 'auto' }) → Promise<{ url, nodeId, operator, updatedAt, protocol, version, roles, candidates, tried, via, rpc, contracts }>` — throws when no seed qualifies; the message names every seed tried and why it was passed over.
- `readDirectory(opts) → { seeds, keys, via, contracts, rpc }` — the raw live seed list (fresh + bonded, newest first).
- `proveNode(url, nodeId) → { ok, reason? }` — `GET /whoami?nonce=` checked against the key the directory names.

**Settling**
- `settle(envelope, { node = 'auto', log?, fetch?, retries = 3, backoffMs = 500, timeoutMs = 30000, discovery? }) → Promise<{ status, matchId, node, delta?, error?, httpStatus?, protocol?, logAttached }>`
  - reads `/health` first (unreachable → `'unreachable'`), then `GET /delta/<matchId>` — a match the node already holds is `'already'` and nothing is re-sent;
  - attaches `log` only when `protocol >= 4`, after checking its size and hash (a mismatch is your bug and throws);
  - retries network failures, timeouts, 408, 429 (honouring `Retry-After`) and 5xx with jittered exponential backoff — re-posting is safe, a node settles a matchId once;
  - 400/403/other 4xx → `'refused'` with the node's reason (resending will not help; for 403 try another node, `findSettler({ exclude: [url] })`);
  - a 200 carrying another court's delta for the same matchId → `'already'`;
  - never throws for a network failure.

Constants: `ATTEST_TAG`, `LOG_MAX_BYTES`, `LOG_PROTOCOL` (4), `SETTLING_ROLES` (`host`, `settler`, `relay`), `CONTRACTS_URL`, `DEFAULT_RPCS`, `DEFAULT_CONTRACTS` (generation 3), `SELECTORS`, `FRESH_S`.

## What this generalises from FLOOD CONTROL's client

FLOOD CONTROL's board (`bagyogame/scripts/arc/board/litnode.ts`) was the template every studio copied. Kept:
the same signing bytes, the arcade's `contracts.json` with a generation-3 fallback, and the discovery rule
(NodeDirectory `keys()` → `entryOf` → NodeStake `standingOf`; fresh within 7 days, active bond, newest first;
`/health` must answer as that node and host the ruleset). Changed or added:

- **Settling role.** FLOOD CONTROL required `settler`; any of `host`, `settler`, `relay` settles (the node's own `canSettle`).
- **Proof of key.** `/whoami?nonce=` must be signed by the key the directory names (as `cabinet/seeds.js` and the bridge do); a `/health` that merely names the right node id is not enough.
- **RPC fallback list.** One RPC became a list: `contracts.json`'s `rpc`, then `DEFAULT_RPCS` (Caldera `/http`, then `/infra-partner-http`). A transport failure moves to the next endpoint; a revert is an answer and does not; the endpoint that answered is preferred by later calls in the process.
- **429 backoff.** HTTP 429 or a JSON-RPC "rate limit / bandwidth limit" error backs off (`Retry-After`, else jittered exponential) and rotates. The same for node probes and `POST /ledger`.
- **Bounded concurrency.** FLOOD CONTROL read every key one call at a time; this reads `concurrency` at a time with a floor between RPC starts (`maxRps`, default 8: the public gateway 429s past ~25 req/s per IP, which a court shares with whatever else runs there). No standing is read for an entry that is not fresh.
- **Paging.** On a generation-4 directory (`contracts.json` `generation >= 4`, or `keysPage: true`) keys are read with `keysPage(offset, limit)`, falling back to `keys()` if the call reverts.
- **Selectors** are hard-coded (no keccak at runtime) and checked against `protocol/keccak.js` by the tests.
- **Outcomes, not exceptions.** FLOOD CONTROL threw on any non-2xx and on a re-send. `settle()` returns `settled / already / refused / unreachable`, retries what is transient, and recognises a matchId the node already settled.
- **Settlement v4.** `commitments`, `stats` and the `log` attachment, gated on the node's protocol.

## What a studio still does itself

- **Generate and guard the court key.** `npm run bridge -- key --kind attested --ruleset <id>` makes one; keep it in the server's managed secrets (never in the repo, never in a browser), and give its public key to every node operator who should settle your title (`COURTS=<rulesetId>:<key>`) or put it in the manifest's `attestors`.
- **Compute the outcome and keep the report honest.** The node checks the signature and your ruleset's `validate()`; it cannot re-run your engine. Only sign what your own server (or its replay) saw.
- **Choose matchIds and seats.** Make the matchId deterministic per match (a resend must reuse it) and map your players to participant ids (`fc:<id>`, `pb:<sub>`). Single-seat titles send one participant and `teams: [[p], []]`.
- **Record the log** if you commit to one: the exact bytes, their `logFormat`, and ≤ 512 KiB.
- **Decide what to do with each status**: queue `unreachable` for a later retry (the same envelope is safe to resend), surface `refused` reasons, treat `already` as done. Persisting that queue is yours.
- **Ship the ruleset** (`titles/<id>.mjs` → bundle) so nodes can host it; until a node lists it in `/health`, `findSettler` will not choose it.
- **Pin a node** instead of discovering one, if you run your own: `settle(env, { node: 'https://…' })`.

The bridge (`npm run bridge`, `sdk/bridge/`) uses this module for attested signing, `resolve` and `submit`; use the
bridge when you want a watcher or an HTTP intake rather than calling `settle()` from your own server.
