# Sign in with a wallet — the litVM Games profile

Status: **built, not deployed** (17 Sep 2026). `contracts/PlayerProfile.sol`
and `contracts/NodeBadge.sol` compile; `protocol/profile.js` (reads, calldata,
the fold by owner), the node's profile cache, `/profile`, the revoked-key
refusal at `/queue` and `?by=owner` are exercised by `demo/profile.test.mjs`
against a mocked chain; the cabinet's *Sign in with wallet* is wired
(`cabinet/wallet.js`) and hidden until `CHAIN.PlayerProfile` is set. What is
missing is the one thing a test cannot do: `npm run deploy:testnet` with the
deployer key, then the address into `contracts/deployed.testnet.json` (the
node reads it) and `cabinet/config.js` (the cabinet reads it).

## The idea, and the one constraint on it

A player opens the cabinet, clicks *Sign in with wallet*, MetaMask asks once,
and from then on everything they do on the mesh — every ladder row, every
settled match, every agent they own — is attributed to that wallet. One
transaction registers them. The registration *is* an NFT: the litVM Games
profile, owned by the wallet.

The constraint: **the wallet cannot be the key that signs play.** A queue
entry is signed every time a player queues; a ledger head is signed at the
end of every match; in the P2P target both players sign continuously. Each
of those is an ed25519 signature made by `protocol/keys.js` in WebCrypto with
no prompt. A wallet signature is a MetaMask popup, and secp256k1 verification
is something neither the node nor the browser client has today (the protocol
has keccak for selectors, nothing else). So the design is the one the rest of
the system already uses for nodes:

> The wallet **authorizes** a key; the key **signs**; the chain **says which
> wallet a key belongs to**; the node **reads** that with `eth_call`.

That is exactly `NodeStake.standingOf(nodeKey)` — the wallet that bonded a
node key is its operator — applied to players. Same read path, same
`protocol/staking.js` shape, same "nothing self-asserted survives into the
fold" rule.

```
BROWSER                                  litVM LITEFORGE                     NODE
player key kp (ed25519, localStorage)
   |
   |  Sign in with wallet
   |  eth_requestAccounts, wallet_addEthereumChain(4441)
   |
   |  PlayerProfile.register(bytes32 kp.pub, name)  ───►  mints profile #n to wallet
   |     one transaction; MetaMask asks once                 binds kp.pub → #n
   |
   |  (later, another device) bindKey(bytes32 kp2.pub) ───►  kp2.pub → #n
   |  (compromised browser)   revokeKey(bytes32 kp.pub) ───►  kp.pub inactive
   |
   |  queue / play / sign ledger with kp exactly as today
   |                                                                    every tick, for keys it has seen:
   |                                                          ◄────────  eth_call ownerOfKey(kp.pub)
   |                                                                    → {owner, tokenId, active}
   |                                                                    fold counts owners, not keys (§9)
   |                                                                    revoked key: queue entry refused
```

## What one transaction buys

| Today | With a profile |
|---|---|
| `playerId` is a browser key; a new browser is a new player | Any number of keys, one profile; ladders merge by owner |
| A leaked `localStorage` key is a leaked identity forever | `revokeKey` — the node stops accepting it within a tick |
| "Register against the AIR account" (BUILD-SPEC §2.1) is unbuilt | The wallet is the account; AIR can be bound to the same profile later or not at all |
| Agents (ERC-6699) are owned by a wallet; players are not | "My agents" and "my record" are the same `ownerOf` query |
| Rewards, if ever, have nowhere to go | The profile owner is the payout address |
| Sign-in inside the framed titles is blocked by their `frame-ancestors` | The cabinet owns identity and hands `player.id` to the title over the SDK; the title never signs in |

## Contract — `PlayerProfile` (ERC-721, built)

```solidity
// The interface contracts/PlayerProfile.sol implements (registerWithSig excepted — later).
interface IPlayerProfile /* is IERC721 */ {
    event KeyBound(uint256 indexed tokenId, bytes32 indexed key);
    event KeyRevoked(uint256 indexed tokenId, bytes32 indexed key);

    /// One transaction: mint a profile to msg.sender and bind its first key.
    /// Reverts if msg.sender already has a profile or the key is bound anywhere.
    function register(bytes32 key, string calldata name) external returns (uint256 tokenId);

    /// Add / remove a device key on the caller's profile.
    function bindKey(bytes32 key) external;
    function revokeKey(bytes32 key) external;

    /// The node's read, mirroring NodeStake.standingOf(bytes32).
    function ownerOfKey(bytes32 key) external view returns (address owner, uint256 tokenId, bool active);
    function profileOf(address owner) external view returns (uint256 tokenId);
    function nameOf(uint256 tokenId) external view returns (string memory);

    /// Gasless variant for later: the wallet signs EIP-712 {key, name, nonce, deadline};
    /// anyone relays. ecrecover happens ON CHAIN, so the node still needs no secp256k1.
    function registerWithSig(address owner, bytes32 key, string calldata name, uint256 deadline, bytes calldata sig) external returns (uint256);
}
```

Decisions, with the recommendation marked:

- **Soulbound.** The profile does not transfer. A ladder position that can be
  sold is not a ladder position; and a transfer mid-epoch would move settled
  deltas between owners after the fact. *Recommend: non-transferable;*
  `revokeKey` + `bindKey` is how a person moves devices, and a lost wallet is
  a new profile, as it is everywhere else on chain.
- **One profile per wallet.** `register` reverts on a second call. Sybil
  cost is a wallet plus gas — small, but identical to every other chain
  identity; ranked eligibility (co-signed matches, distinct opponents,
  BUILD-SPEC §9) stays the real gate.
- **Key = ed25519 public key as `bytes32`.** Exactly what `nodeKeyBytes32`
  does for nodes. The contract stores it; it never verifies an ed25519
  signature (it cannot, cheaply). Binding proves *the wallet claims this
  key*, not that the wallet holds it — sufficient, because a key bound to a
  wallet that does not hold it earns that wallet nothing and costs it gas.
- **Gas.** Liteforge's native token is zkLTC; the faucet at
  `liteforge.hub.caldera.xyz` funds it. Two MetaMask prompts on first use
  (add chain, send). `registerWithSig` removes gas from the player and moves
  it to a relayer — an operator tool like `tools/anchor-epoch.mjs`, **never
  the node**, which holds no chain key (BUILD-SPEC §11). Build `register`
  first; add the relayer when gas is the measured drop-off.

## Node — reads only, as always

- `protocol/profile.js`: `ownerOfKeyCall(contract, key)` and `decodeOwner(hex)`,
  the same twenty lines as `staking.js`.
- `node/chain.js`: `profiles(keys)` beside `standings(nodeIds)`; merge, never
  replace (the lesson from stake reads, litnode.js tick).
- Config: `PLAYER_PROFILE=0x…`; unset means "keys are players", reported in
  `/health` as `profiles: unset | chain | unreadable`, same three words as
  `staking`.
- `/queue`: a key the chain reports as revoked is refused (`403 key revoked`).
  An unbound key is accepted — a guest is a valid player; they just do not
  merge across devices.
- `/leaderboard?by=owner` (and `/stats`, `/credits`): the fold maps each
  participant key to its owner before applying the delta, so a person with
  three browsers is one row. This is the "counts identities, not keys" clause
  of BUILD-SPEC §9 made concrete. The default stays `by=key` until profiles
  exist on the live mesh; the digest carries the mode.
- `/profile?player=<key>` → `{owner, tokenId, name, keys[]}` for the cabinet.

## Cabinet

- Profile card: *Sign in with wallet* when `window.ethereum` exists and the
  current key is unbound; the wallet short address and profile name once
  bound; *Add this device* when the wallet has a profile but this browser's
  key is not on it.
- Flow: `eth_requestAccounts` → `wallet_addEthereumChain` for 4441 (id,
  RPC, explorer, `zkLTC`) → `eth_call profileOf(wallet)` → either
  `register(key, name)` or `bindKey(key)` as an `eth_sendTransaction` with
  calldata built by the vendored `keccak.js`/`profile.js` — no wallet
  library, the same zero-dependency rule as `chain.js`.
- Nothing about play changes. `cabinet:init.player.id` is still the ed25519
  key; a title that wants the wallet asks the node `/profile?player=`.
- The `name` is on chain and public. The display name and avatar the
  cabinet keeps locally stay local.

## The node NFT — "litVM Games Node"

Operators already have the binding: `NodeStake.standingOf(nodeKey)` returns
the wallet that bonded it. What they do not have is anything a wallet can
*show*. A `NodeBadge` ERC-721 is that:

- `claim(bytes32 nodeKey)` mints to `msg.sender` iff `NodeStake.standingOf(nodeKey)`
  reports `active` and `operator == msg.sender`. No change to the deployed,
  unaudited `NodeStake`.
- `sync(bytes32 nodeKey)` — anyone may call; burns the badge if the bond is
  no longer active. The badge is only ever as true as the bond.
- Soulbound, for the same reason as the profile and one more: a witness must
  be under a *different staking address* than the host (`/cosign`). A
  transferable badge would suggest the operator can change hands, and it
  cannot without unbonding.
- `tokenURI` renders the node's key, operator, region and — once epoch roots
  are being anchored routinely — the count of leaves the node hosted or
  co-signed, read from the same delta set that builds `/epoch`. That is the
  reputation ledger of BUILD-SPEC §9 given a picture, and it is derived, so
  it cannot be edited.

What it deliberately is **not**: a reward. There is no rewards contract
(BUILD-SPEC §16), the bond is a cost of misbehaviour and not a yield
(whitepaper §5.4), and the cabinet stopped projecting a figure on 17 Sep.
If a badge ever carries value, it is because the work it displays is
verifiable, not because it was minted.

## Build order

1. ~~`contracts/PlayerProfile.sol` + `NodeBadge.sol`~~ — written, compile
   under the project's solc settings, added to `tools/deploy-contracts.mjs`.
   `registerWithSig` is not in the contract yet (see 5).
2. ~~`protocol/profile.js` + node reads + `/profile` + `by=owner` + the
   revoked-key refusal~~ — `demo/profile.test.mjs` (3 tests) covers the
   calldata layout, the decoders, the fold, and a node against a mocked
   `PlayerProfile`.
3. ~~Cabinet sign-in~~ — `cabinet/wallet.js`; `register` when the wallet has
   no profile, `bindKey` when it does (*add this device*); the card shows the
   profile name and wallet once bound. `demo/cabinet.test.mjs` asserts
   `/profile` and `/health.profiles`.
4. **Deploy** (operator, with `DEPLOYER_KEY`): `npm run deploy:testnet`
   deploys both contracts idempotently; set `CHAIN.PlayerProfile` in
   `cabinet/config.js`; redeploy the cabinet. Then exercise `register /
   bindKey / revokeKey` once for real and record the tx in the CHANGELOG.
5. `NodeBadge.claim` in the operator README and `tools/bond-node.mjs`;
   `registerWithSig` + an operator relayer tool when gas is the measured
   drop-off; AIR binding as a second attestation on the same profile if the
   AIR partnership needs it.

## Honest zeroes for this design

- The chain cannot verify that a wallet holds the ed25519 key it binds. A
  wallet can bind someone else's public key. It gains nothing by doing so
  and the true holder can be bound by their own wallet only if the key is
  free, so the rule is first-come — the same as any registry. If this
  matters, `register` can take an ed25519 signature over the wallet address
  and the node can verify it off chain before relaying; the contract still
  cannot.
- Ladders keyed by owner change the digest. Two nodes agree only if they
  read the same profile state; a profile bound between two reads makes two
  digests differ until both catch up — the same eventual-consistency window
  as stake reads, closed the same way (merge, never replace; pin reads to a
  block if it becomes a problem).
- A soulbound profile on a lost wallet is lost. That is the trade.
- None of this is audited, and the deployer wallet that would deploy it is
  the one BUILD-SPEC §16 says to rotate first.
