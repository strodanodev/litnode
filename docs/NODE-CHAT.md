# Node chat — build and integration plan

**What this is.** One global, public, signed chat between the operators of the
litVM Games mesh, shown in the Control Plane under the Activity panel. It rides
the gossip the node already pushes every tick, carries no server, no account and
no new contract, and every ranked match a node settles stamps the chat it held at
that moment into the ledger the chain already commits to. Planned 21 Oct 2026.
**Phase A built 21 Oct 2026** (`protocol/chat.js`, `node/litnode.js`, `node/settle.js`,
`demo/chat.test.mjs`; CHANGELOG 0.11.29, unreleased). Two details settled in the build
that §2 states loosely: the rate limit is "at most three lines whose timestamps fall in
any fifteen-second window", checked over the lines' own `at` so every node refuses the
same flood in any order; and seen-by counts peer **nodes** (the sender's heartbeat leads
every push and reply), not sockets. **Phase B built 21 Oct 2026** on the website
repo's `control-plane-phase1` branch (`NodeConsole.tsx` `NodeChat`, `fleet.ts`,
`node-console.css`), verified against a two-node offline fixture and a 0.11.28 node;
it ships with the next Control Plane MSI. Phase C is not started.

Decisions taken (change them here before building, not in code):

| question | decision |
|---|---|
| who may speak | a bonded node key speaks and is forwarded; an unbonded key is held at a small cap and shown muted; a key the chain never saw is dropped |
| display name | the operator label from the heartbeat, with a bonded badge and the wallet short; several nodes under one wallet read as one operator |
| who sees it | operators: the Control Plane, `npm run fleet`, optionally the cabinet's `#/node` page read-only. Never the arcade's player pages |
| message | ≤ 280 characters, plain text, no links rendered |
| retention on a node | the newest 200 messages or 24 hours, whichever is smaller; memory only |
| on chain | a host-asserted stamp inside every ranked ledger (free); hourly quorum anchoring and minting are phase C and optional |

---

## 1. Phases and owners

| phase | ships in | owner | depends on |
|---|---|---|---|
| **A. Node** — chat envelopes over gossip, limits, `POST /chat`, `/fleet.chat`, ledger stamp, tests, docs | litnode **0.11.29** | this checkout (Claude); release + ReleaseRegistry registration are user steps; fleet rollout is Codex A's | nothing |
| **B. Control Plane** — the panel under Activity | Control Plane **0.1.15** (MSI) | UI on branch `control-plane-phase1` in the website repo (Claude); MSI build and publish per the Control Plane process (Codex B / user) | A on the desktop node, else the panel shows "update the node" |
| **C. Optional, later** — per-match room chat in the submission; hourly chat root on a second EpochAnchor instance; mint-on-proof Cards | separate litnode and contract releases | decided when someone asks for it | A, and real demand |

Old nodes ignore unknown gossip keys and unknown ledger fields, so A is safe on a
mixed-version mesh and B degrades cleanly on an old node. Coordinate the 0.11.29
number with the Pickle Brawl session before cutting.

---

## 2. Protocol (phase A)

### 2.1 The envelope
`seal('chat', body, identity)` → `{ body, signer, sig }`, verified with the same
`checked(tag, env)` cache as heartbeats and queue entries, **before** it is held
or forwarded.

```
body = { v: 1, at: <ms since epoch>, text: <string> }
id   = h('chat', { signer, at, text })          // protocol/canonical.js
```

`id` is derived, never sent; two envelopes with the same id are one message.
No room, no reply-to, no edits, no deletes in v1.

### 2.2 Limits (everything a stranger can add to has a ceiling)

| limit | value | refused as |
|---|---|---|
| text length | 1..280 code points after trim; no control characters except newline | `chat.malformed` |
| clock | `at` within −24 h..+60 s of the receiver's clock | `chat.window` |
| per key | 1 message / 5 s, burst 3 (token bucket per signer, in memory) | `chat.rate` |
| held | 200 messages, 24 h TTL, oldest pruned first | `chat.full` |
| unbonded keys | 16 messages held in total, never forwarded | `chat.unbonded` |
| unknown keys | with NodeStake configured, a signer the stake table has never listed is dropped | `chat.unknown` |
| per gossip message | first 64 chat envelopes looked at (`MAX_PER_MESSAGE` is too generous here) | counted |

Counters join `guard` and appear in `/health.gossipLimits` and the once-a-minute
`gossip.guard` event, like the queue's.

### 2.3 Transport: what a tick pushes, and catch-up
- **Push:** `payload.chat` = the messages held with `at` in the last **2 minutes**,
  plus `payload.chatNewest` = the `at` of the newest message held. Gossip delivers
  in 1–3 s; two minutes covers a tunnel rotation.
- **Reply:** the `/gossip` answer carries the same window, **or the whole ring**
  when the pusher's `chatNewest` is older than ours by more than the window. That
  is how a restarted node, or one that was partitioned, catches up in its first
  round trip — the same way it catches up on heartbeats.
- Worst case on the wire: 2 min × (12 msgs/min per bonded key) × ~400 B. For the
  mesh's size this is well under a heartbeat's manifests. Revisit at 50 operators.

### 2.4 Seen-by
`absorb()` records, per id, the set of peer URLs whose gossip carried it (bounded
to 64 per id). `/fleet.chat[].seenBy` is that count. The sender's own message
shows "pending" until a peer echoes it, then "seen by N peers". That is the only
delivery receipt, and it is an honest one.

### 2.5 The ledger stamp
In `node/settle.js finish()`, beside `descriptor`:

```
stored.meta = { chat: { hour, root, newest, count } }   // this host's ring at settle time
```

`root` is `buildTree(ids)` from `protocol/epoch.js` over the ids held; `newest`
is the newest id; `count` the ring size. It travels in `ledgerHash` into the
`Settled` event, is custodied by the drawn witnesses, and is ignored by replay.
**`meta` never enters `resultFields`** (`protocol/result.js`); a test proves a
witness with a different ring still agrees. Casual matches get the stamp in their
ledger too; only ranked placed matches reach the chain.

---

## 3. Node changes, file by file

| file | change |
|---|---|
| `protocol/chat.js` (new, pure) | `CHAT_TAG`, the limits as named constants, `chatId(env)`, `chatProblem(env, { now, bonded })` → null or a refusal code, `chatRoot(ids)` via `buildTree` |
| `node/litnode.js` | `chat` Map id → `{ env, seenBy }` in insertion order; `mergeChat(list, from)` with the guard; `payload.chat` + `chatNewest` in `tick()`; the reply rule in `/gossip`; `POST /chat` (loopback-only like `/update`, body `{ text }`, answers the sealed envelope and id); `fleetNow().chat` = ring newest-last with `{ id, at, signer, operator, wallet, bonded, text, seenBy, mine }`; `emit('chat', { id, signer, operator, text })` on each new message held (not QUIET: it belongs on Logs); `chatStamp()` handed to `createSettlement` |
| `node/settle.js` | `finish()` adds `stored.meta` from the injected `stamp()`; nothing else reads it |
| `node/tui.js` | last three chat lines under the events pane (cheap, optional) |
| `tools/fleet.mjs` | print the last five chat lines after the peers table — the reference consumer |
| `docs/FLEET-TELEMETRY.md` | new `chat` field, its shape, the 0.11.29 note |
| `demo/fleet.test.mjs` | add `chat` to the exact key list (line 49) |
| `CHANGELOG.md`, `BUILD-SPEC.md` | 0.11.29 entry; a row in the status table |
| `docs/OPERATORS.md`, `docs/RUNBOOK.md` | one paragraph: public, signed, plain text; the never-paste-a-key rule applies |

Nothing new on disk. No `node.env` key. No protocol version bump.

---

## 4. Tests (phase A, all under `node --test`)

`demo/chat.test.mjs`, on the three-node harness `demo/mesh.test.mjs` uses:

1. A posts on loopback; B and C hold the id within 3 ticks; `seenBy` on A ≥ 1.
2. A forged signature is refused and never forwarded (B never sees it; `guard.chat.badSig` on A = 1).
3. 281 characters, a control character, `at` an hour ahead, 4 messages in 5 s: each refused with its code; the first three in the burst are held.
4. Restart B: its first push carries `chatNewest: 0`; A's reply carries the whole ring; B is caught up before its second tick.
5. 24 h TTL and the 200 cap prune oldest-first (fake clock).
6. `/fleet` digest and proof still verify with `chat` present (`readFleet()` from `tools/fleet.mjs`).
7. Unbonded signer (stake table says inactive): held on the receiver, absent from its pushes.

`demo/settle.test.mjs` (extend): host settles with a stamp; a witness whose ring
differs replays and agrees; `ledgerHash` of what `/ledger/:id` serves equals the
hash the host sent; `resultFields(delta)` has no `meta`.

`demo/gossip-limits.test.mjs` (extend): a flood of 1,000 chat envelopes from 100
keys costs no eth_calls and leaves the ring at 200.

---

## 5. Control Plane changes (phase B, website repo, branch `control-plane-phase1`)

| file | change |
|---|---|
| `src/lib/litnode/fleet.ts` | `FleetChatLine` type; `chat: FleetChatLine[]` on `Fleet`; `describeEvent` case `chat` → `"<operator>: <text>"` |
| `src/components/NodeConsole.tsx` | a `NodeChat` card after `.overview-activity`: head "Node chat · N online · public", the last 6 lines in the Activity style (`time · name · text`, own lines labelled `you`, muted lines dimmed), an input with a 280 counter, Enter sends `POST http://127.0.0.1:<port>/chat`; optimistic line marked pending until it appears in `/fleet.chat` with `seenBy ≥ 1`; the Activity card filters `kind === 'chat'` out of its four lines (Logs keeps them) |
| `src/components/node-console.css` | `.chat-lines`, `.chat-input`, `.is-pending`, `.is-muted`; mobile breakpoint stacks like the rest |
| mute | per wallet, in `localStorage` key `litnode.chat.muted`; a muted line collapses to "muted · <operator>" |
| states | no `/fleet` → card says "appears once the node answers"; node `version < 0.11.29` (no `chat` key) → "update the node to chat"; `self.bonded === false` → read-only with "bond to speak"; node attached but not local → send disabled (loopback rule) |
| copy | one line under the input: "Public. Signed by this node's key. Plain text only." |

The MSI is the only way this ships to operators; it never rides a litnode update.

---

## 6. Rollout sequence

1. Build phase A in this checkout, `npm test` green, `npm run fleet` shows chat lines against the desktop node. Commit.
2. `npm run release -- --channel canary` → desktop + witness-2 on canary (Codex A applies, per the 0.11.17 pattern). Two operators chat across the public mesh; `/health.gossipLimits.refused.chat` stays at zero for a day.
3. `npm run release` (stable), then **user step:** register the zip hash in ReleaseRegistry (classifier-blocked for agents). Nodes apply on their hourly check.
4. Phase B lands on `control-plane-phase1`; preview on the `control-plane-ui` launch config against the desktop node; MSI 0.1.15 built and published; arcade `#/download` updated.
5. Only then decide phase C from what operators actually say and ask for.

---

## 7. Risks and what rules them out

- **Spam from free keys.** Verified-before-cached, bonded-only forwarding, per-key rate, hard caps — the queue's defences, reused.
- **Payload growth.** The 2-minute push window plus ring-on-demand keeps every push bounded by the rate limit, not by history.
- **Attestation drift.** `meta` is outside `resultFields`; the settle test enforces it.
- **Phishing.** No link rendering, no markdown, no images. Text is text.
- **Operator confusion.** Labels are not identity: the wallet short is always beside the label, and a label collision shows both.
- **Privacy.** Public by construction and said so in the panel. Nothing is encrypted; DMs are phase C or never.

---

## 8. Still open

- Whether the cabinet's `#/node` page (`cabinet/nodeops.js`) shows the ring read-only in the same release. Cheap; a yes means the arcade must be redeployed with 0.11.29.
- Whether guardians (browser nodes, not litnodes) should be able to read it. They are not on gossip today, so no unless `/fleet` is their path.
- Phase C's shape, if ever: per-match `meta.chat` written by the client (SDK change), a second EpochAnchor instance for hourly chat roots, a forty-line mint-on-proof contract. None of it is needed for A or B.
