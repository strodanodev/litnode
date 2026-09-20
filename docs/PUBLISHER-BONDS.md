# Publisher bonds — titles, host grants, escalation

Status: **spec, nothing built.** Decisions taken 21 Sep 2026; contracts and
cabinet flows follow this document. Reasoning that led here is in the
session notes; only the decisions are kept.

## 0. Why

Today a title is a file in a node's manifest. Any bonded node may host any
title, "BONDED HOST" in the cabinet means only that the *node* holds a
NodeStake bond, and a publisher has no on-chain existence: nothing to own,
nothing to stake, no way to say which nodes are their official hosts, no
way to see who wants to host them, and no seat in a dispute.

This spec gives a publisher four things, in order of build:

1. **A title they own** (`TitleRegistry`, ERC-721, soulbound until §1.4).
2. **Host grants** with expiry, requested by nodes, signed by the publisher
   through AIR's proxy wallet, submitted on chain by the operator.
3. **A publisher tab** in the cabinet: inbox, hosts, settings, renewals.
4. **A seat at the top of escalation**, backed by their stake, with every
   ruling documented on chain.

Revenue share is a *field*, not a constant, and is wired only once revenue
exists on chain (§6).

## 1. TitleRegistry (litVM, new contract)

### 1.1 Identity

```
titleId  = uint256(keccak256(rulesetId))       // one title per ruleset id
ownerOf(titleId)                                // the publisher, and the ONLY place the publisher's address is stored
```

The rule that makes §1.4 possible: **no contract stores "the publisher's
address" anywhere except as `ownerOf(titleId)`.** Grants, stake, settings,
rulings and revenue share all key on `titleId`. Whoever owns the token is
the publisher; that can be an EOA, an AIR proxy wallet, a multisig, or a
vault.

### 1.2 Mint

```solidity
function mint(bytes32 rulesetId, bytes32 buildHash, string calldata name) external;
```

- Caller must hold the **publisher stake tier** (§1.3) before the mint lands
  — the mint and the first stake are one transaction from the cabinet's
  point of view (the node's proxy wallet does both; §4).
- `buildHash` must be the current build the caller's node serves for
  `rulesetId`, signed by a key in that node's `TRUSTED_PUBLISHERS`
  (HOST-YOUR-TITLE.md §build attestation). This is the proof the minter is
  the publisher and not a squatter: the ruleset's own signing key vouches.
- One mint per `rulesetId`. A contested ruleset id (two parties with
  different signing keys) is an escalation case, not a race.
- Soulbound: `transferFrom` reverts unless the `vault` flag is set (§1.4).

### 1.3 Publisher stake tier

A title carries its own bond on `NodeStake`, under a *title key* rather
than a node key, so slashing, unbonding and adjudicators are reused, not
rewritten:

```
titleKey  = keccak256("title", rulesetId)
minStake  = NodeStake.minStake × PUBLISHER_MULT         // PUBLISHER_MULT = 10 (params, admin-settable)
```

What it backs, and what can slash it (via the existing adjudicator list):

| backed | slashed when |
|---|---|
| the title's listing and settings (§2) | settings were changed in a way that voided in-flight matches (adjudicator: MatchBook) |
| the publisher's grants (§3) | a granted host was slashed for the title and the publisher had been notified and did not revoke within `revokeGrace` |
| the publisher's tier-3 rulings (§5) | a ruling is reversed by the admin panel with cause |

The publisher's bond may **not** be unstaked while any grant it issued is
still valid (`unstake` reverts until the latest `validUntil`).

### 1.4 Tokenisation later

Not built now; the mint above is designed so it costs nothing later.

- `setVault(titleId, address vault)` by the owner, one-way: after it the
  title may be transferred **only** to `vault`.
- The vault (a separate, later contract) holds the NFT and issues the
  fungible token. Ownership of the title, and therefore every right in this
  spec, is then whatever the vault's governance says.
- Trigger, in words: a title launches a token when its microtransaction
  revenue has reconciled to chain for N epochs. Not a contract rule yet;
  there is no revenue on chain (§6).

## 2. Hosting settings (on the title, flat, five fields)

```solidity
struct Hosting {
    uint256 minHostStake;     // operator NodeStake required to be granted; 0 = mesh minimum
    uint16  maxHosts;         // concurrent valid grants; 0 = unlimited
    bytes32 regions;          // bitmask of region codes the node advertises; 0 = any
    bool    unofficialAllowed;// may an ungranted bonded node still host, labelled UNOFFICIAL
    uint8   witnesses;        // witness count above the mesh default (3); 0 = default
}
function setHosting(uint256 titleId, Hosting calldata h) external onlyOwner;
event HostingSet(uint256 indexed titleId, bytes32 hostingHash, Hosting h);
```

- `hostingHash = keccak256(abi.encode(h))` goes into every placement
  descriptor for the title (MatchBook `descriptorHash` already commits the
  descriptor), so a node proves which settings it applied.
- A change takes effect for **new placements only**; in-flight matches keep
  the hash they were committed with.
- Anything else about how a game is hosted stays in the title's manifest
  (`display`, assets, transport). These five fields are the ones nodes need
  at placement and nowhere else. Adding a sixth needs a reason written here.

## 3. Host grants

### 3.1 Request (off chain, signed, free)

A node that wants to host a title asks. Same transport as every other
signed message on the mesh: ed25519 by the node key, carried by the node
itself and the directory, never a transaction.

```
HostRequest {
  v: 1, rulesetId, nodeKey, operator, stake,         // stake = NodeStake.standingOf(nodeKey) at request time
  regions, url, message?,                            // message ≤ 280 chars, shown in the inbox
  requestedAt, expiresAt (≤ 14 d),
  sig: ed25519(nodeKey, canonical(request))
}
```

- `POST /title/:rulesetId/request` on **any** node hosting the title (or the
  seed). The receiving node verifies the signature and the stake claim
  against chain, stores it, and gossips it like a delta advertisement.
- `GET /title/:rulesetId/requests` lists open requests; the cabinet's
  publisher tab reads it from the publisher's own node.
- A request is a courtesy. A publisher can also grant unasked (§3.2).

### 3.2 Grant (signed by the publisher, submitted by the operator)

EIP-712, domain `litVM TitleRegistry`:

```
HostGrant {
  titleId, nodeKey, hostingHash,      // the settings the grant was made under
  validFrom, validUntil,              // validUntil − validFrom ≤ 180 d
  nonce
}
```

```solidity
function grant(HostGrant calldata g, bytes calldata publisherSig) external;   // anyone may submit; the operator does and pays
function revoke(uint256 titleId, bytes32 nodeKey) external onlyOwner;
function grantOf(uint256 titleId, bytes32 nodeKey) external view returns (uint64 validFrom, uint64 validUntil, bytes32 hostingHash, bool revoked);
function isOfficialHost(uint256 titleId, bytes32 nodeKey) external view returns (bool);   // valid window ∧ not revoked ∧ NodeStake active ∧ stake ≥ minHostStake
event Granted(uint256 indexed titleId, bytes32 indexed nodeKey, uint64 validFrom, uint64 validUntil, bytes32 hostingHash);
event Revoked(uint256 indexed titleId, bytes32 indexed nodeKey);
```

- The signature comes from `ownerOf(titleId)`. For an AIR publisher that is
  the node's proxy wallet signing typed data on the publisher's behalf
  (§4); for a wallet publisher it is MetaMask in a browser tab.
- `grant` checks `maxHosts`, `minHostStake` and `regions` at submission.
- **Expiry demotes, never cuts.** An expired grant makes the node an
  UNOFFICIAL host for the title (if `unofficialAllowed`), else the node
  stops *placing* new matches for it; matches already committed finish.
- Renewal is a new grant with `validFrom = old.validUntil`. The cabinet
  surfaces grants ending within 30 days as "renewals due".

### 3.3 What nodes do with it

- Placement for a title reads `isOfficialHost` for the candidate host at
  the placement block. Official hosts are chosen first; ungranted bonded
  nodes only when `unofficialAllowed` and no official host has capacity.
- A match settled by an unofficial host is labelled `unofficial` in the
  delta and on the cabinet, next to the existing `relay` / `players`
  attestation labels. It is not on the OFFICIAL ladder for the title.
- The directory entry for a node lists `official: [rulesetId…]` so the
  cabinet can show "official host" without a chain read per card.

## 4. Signing from the cabinet (AIR first, wallet second)

The profile mint (UNIVERSAL-LOGIN.md) showed the shape: an installed PWA
cannot open the wallet extension, and a player signed in with AIR has a
litVM proxy wallet held by their node. Publisher actions use the same path.

```
POST /air/title/mint      { token, rulesetId, name }                 → node: stake title tier + mint from the proxy wallet
POST /air/title/hosting   { token, rulesetId, hosting }              → node: setHosting
POST /air/title/grant     { token, rulesetId, nodeKey, validUntil }  → node: proxy signs the EIP-712 HostGrant, returns {grant, sig}
POST /air/title/revoke    { token, rulesetId, nodeKey }
```

- The node verifies the AIR token against JWKS as today, resolves the AIR
  id → proxy wallet, and checks `ownerOf(titleId) == proxy` for every
  action but `mint`.
- `grant` does **not** submit: it hands the signed grant back, the cabinet
  delivers it to the requesting node (`POST /title/:rulesetId/grant` on that
  node), and *that* node's operator submits it and pays the gas — the
  settlement rule that operators pay, kept.
- The publisher's title stake is funded by the node's sponsor the same way
  the profile mint was, up to a per-node cap the operator sets
  (`AIR_SPONSOR_TITLE_MAX`); above it the publisher tops up from a wallet.
- Wallet publishers (MetaMask) get the same four actions from the Nodes-page
  operator panel, in a browser tab. Nothing is wallet-only.

## 5. Escalation, rulings, tickets

Extends MatchBook's existing dispute path; nothing here replaces the
witness quorum or the escalation panel draw.

### 5.1 The ladder

| tier | who rules | signs with | at stake |
|---|---|---|---|
| 1 | the witness node's adjudicator (an LLM run by the operator) | node key | operator's NodeStake |
| 2 | the escalation panel (nine drawn nodes, each running its adjudicator) | panel keys | each panellist's NodeStake |
| 3 | the title's publisher | `ownerOf(titleId)` | the title stake (§1.3) |
| — | admin panel (multisig) | admin | reverses tier 3 with cause; may slash |

A case moves up when the tier below is **unresolved**: no quorum in the
window, a tie, or an explicit `escalate` in the ruling. Tier 3 is reached
only for the publisher's own title. The same ladder handles reports and
tickets (a player report against a match, a host, or another player) —
they are cases with a different `kind`.

### 5.2 A model output is an attestation, not an oracle

An LLM ruling is signed by the party that ran the model and backed by that
party's stake. What goes on chain is the *record*, not the reasoning:

```solidity
struct Ruling {
    bytes32 caseId;        // keccak256(kind, subjectId)   subjectId = matchId | reportId
    uint8   tier;
    bytes32 rulerKey;      // node key, or bytes32(uint160(owner)) for tier 3
    bytes32 caseFileHash;  // content hash of the full case file (evidence hashes, model id, prompt version, transcript, verdict)
    uint8   verdict;       // 0 uphold · 1 overturn · 2 escalate · 3 dismiss
    uint64  at;
}
event Ruled(bytes32 indexed caseId, uint8 tier, bytes32 indexed rulerKey, bytes32 caseFileHash, uint8 verdict);
```

- The case file is content-addressed and served by the ruling node
  (`GET /case/:caseFileHash`), replicated like deltas. Anyone can fetch it
  and check the hash against the event. **Decision-making is documented on
  chain** in exactly this sense: the hash and the signer are on chain, the
  words are one fetch away and cannot be changed after the fact.
- The case file schema is fixed: `{ caseId, kind, evidence: [{hash, uri}],
  model: {id, promptHash}, transcript, verdict, reason }`. A ruling whose
  case file does not parse to this schema is void.
- Tier 1 and 2 rulings use the adjudicator the node operator configures
  (`ADJUDICATOR_MODEL`, `ADJUDICATOR_PROMPT` — the prompt is versioned by
  hash and published; the mesh default prompt lives in `protocol/adjudicate/`).
  Operators may run any model; they are slashed for wrong rulings, not for
  model choice.

### 5.3 Windows

Tier 3 gets `publisherWindow` (proposed 72 h). No ruling in the window
means the tier-2 outcome stands and the publisher's absence is recorded
(`verdict = 3 dismiss`, `rulerKey = 0`). Repeated absence is not slashed;
it is visible on the title's page.

`NodeStake.unbondingPeriod` must exceed `MatchBook.totalWindow() +
publisherWindow` — the deploy tool's existing check extends to the new term.

## 6. Revenue share (a field, unwired)

```solidity
uint16 publisherBps;   // on Hosting, default 5000; range 0–10000
```

Stored from day one so no migration is needed, **read by nothing** until a
revenue contract exists. The 50/50 default is a placeholder, chosen so the
field is not zero; the real default is set when the first title has
microtransaction revenue flowing through a contract this repository
controls. Credits still reconcile against nothing (SPEC §4).

## 7. Cabinet: the Publisher tab

Visible when the signed-in account (AIR or wallet) owns at least one title,
or when it holds a `TRUSTED_PUBLISHERS` key for a ruleset the node serves
(→ "mint your title" call to action).

| view | shows | actions |
|---|---|---|
| **Inbox** | open HostRequests: node, operator, stake vs `minHostStake`, uptime (cabinet already samples it), witness record, region, message, expiry | Grant (choose `validUntil`, default 90 d) · Decline (signed, so the node stops asking) |
| **Hosts** | current grants: node, valid window, official / expiring / expired, matches settled for this title | Revoke · Renew |
| **Settings** | the five Hosting fields + `publisherBps` (greyed, "not yet wired") | Save (one transaction) |
| **Cases** | tier-3 cases awaiting the publisher, with the case file rendered; past rulings | Uphold · Overturn · Dismiss, each with a reason that becomes the case file |
| **Title** | token id, owner, stake, build hash, vault status | Top up stake · Set vault (one-way, confirm twice) |

Operator side, on the Nodes page: "Request to host…" picks a title from the
mesh roster and sends the HostRequest; "Grants" lists this node's grants
and their expiry.

Every write goes through §4: AIR sessions sign via the proxy; wallets sign
in a tab. The in-page dialog and the working pill (0.10.x) carry the
prompts and the waiting.

## 8. Order of work

1. `TitleRegistry.sol` (mint, hosting, grant/revoke, vault flag), NodeStake
   `PUBLISHER_MULT` param, deploy tool check for `publisherWindow`.
   Tests: `demo/title-registry.test.mjs`.
2. Node: `/title/:rulesetId/request|requests|grant`, placement reads
   `isOfficialHost`, `unofficial` label on deltas, directory `official[]`.
3. Node: `/air/title/*` proxy actions with sponsor cap.
4. Cabinet: Publisher tab, operator "Request to host".
5. MatchBook: `Ruled` event + tier 3 + `publisherWindow`; `protocol/adjudicate/`
   default prompt; node adjudicator hook; Cases view.
6. Revenue: nothing until there is revenue.

## 9. Honest zeroes

- No contract in this document is written or deployed.
- litVM throughput is the settlement blocker already recorded; grants and
  rulings add a few transactions per title per month, requests add none.
- The publisher tier multiplier (10×), grant term (180 d), request expiry
  (14 d), `publisherWindow` (72 h) and `revokeGrace` are proposals to be
  set at deploy, not measured values.
- An LLM adjudicator has not been run on a real dispute. Tier 1 and 2 will
  ship as "record the ruling" before any model is trusted to produce one
  unattended.
