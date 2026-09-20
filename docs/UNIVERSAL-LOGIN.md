# Universal login — AIR Kit, litVM proxy wallets, one profile

Status: **built, tested against a mocked chain, not yet exercised live** (21 Sep 2026).
`node/air.js`, `node/proxy.js`, `protocol/air.js`, `cabinet/air.js`, `cabinet/nodeops.js`,
`demo/air.test.mjs`. The AIR partner (id `62e01755-…`, allowed domains
arcade.litvm.games and litvm.games) is in `cabinet/config.js`; the node reads
`AIR_PARTNER_ID` from node.env.

## What it is

A player opens the arcade and clicks **Sign in with AIR**. AIR Kit's dialog
takes Google, a passwordless email or a wallet, and the player is signed in the
same way on agentfighter.wtf, in the arcade and in any title that uses the same
partner. That is the "universal" part, and it was already true for Agent
Fighter. What was missing was the mesh side: the arcade's identity is an
ed25519 key in the browser, the ladder folds by the wallet that owns a key
(docs/WALLET-IDENTITY.md), and an AIR account had no wallet on litVM at all —
AIR's smart accounts live on Base, BSC, Gnosis, Kaia, Soneium and their
testnets, not on Liteforge.

So the node gives the AIR account one. On first sign-in the node the cabinet
talks to:

1. verifies the AIR session token against AIR's JWKS (`node/air.js`; the same
   zero-dependency verifier Agent Fighter's relay has used since July);
2. creates a **proxy wallet** for the account — a plain litVM key under
   `<dataDir>/proxies/` — and sponsors it with a little gas from the node's
   announcer key, which the operator already funds;
3. mints the account's **PlayerProfile** from that proxy, with the AIR user id
   bound to the profile as a key of its own: `airKey(sub) = keccak("litvm-games:air:" + sub)`;
4. binds the browser's ed25519 player key to that profile.

From then on nothing changes for play: the browser key signs queue entries and
ledgers with no prompt, the node reads `ownerOfKey` and folds the ladder by the
proxy address, and characters (ERC-6699) forged to the proxy are the account's.
A second device signs in with AIR and gets its own key bound to the same
profile. Losing a device is `POST /air/revoke`.

```
BROWSER                         NODE (the one the cabinet talks to)            litVM
AIR dialog → session JWT ──►    verify vs JWKS → sub
                                proxies/<airKey>.json  (create once)
                                sponsor → proxy  (gas)                ──►  transfer
                                proxy: register(airKey(sub), name)    ──►  PlayerProfile mints #N to proxy, binds airKey
                                proxy: bindKey(playerKey)             ──►  binds this browser
◄── { address, tokenId, name, custody, playerKey, steps }
ed25519 key signs play ──►      ownerOfKey(playerKey) → proxy  ──►  the fold, mayPlay(), ERC-6699 ownership
```

## Why a proxy, and what it is not

- **Any node can resolve, one node can sign.** `ownerOfKey(airKey(sub))` is a
  public read: every node and every browser can go from an AIR user id to the
  wallet that stands for it. Only the node holding `proxies/<airKey>.json`
  can sign for that wallet; another node answers `custody: 'elsewhere'` and
  still resolves the profile. The profile is the source of truth, not the
  node's file.
- **The proxy signs one contract.** `node/proxy.js` builds calldata for
  PlayerProfile only — register, bindKey, revokeKey. There is no "send this
  transaction" endpoint, so a leaked proxy key can re-bind keys on one profile
  and nothing else; a leaked announcer/sponsor key can waste gas.
- **It is custody, and it says so.** The node holds the key, like it holds the
  announcer key (BUILD-SPEC §11 threat model). A player who wants their own
  wallet on litVM binds it with *Bind with my own wallet* (MetaMask) to the
  same profile, or transfers later once PlayerProfile learns to; the proxy
  simply stops being used.
- **Not an ERC-4337 account.** AIR's smart account cannot act on litVM today,
  and a smart-account signature (ERC-1271) cannot be verified on a chain where
  the account is not deployed. When AIR adds an Arbitrum-Orbit chain or litVM
  itself, the proxy can be replaced by binding the AIR smart account address
  to the profile; the `airKey` binding and everything downstream stay as they are.

## ERC-6699 alignment

The registry (`contracts/ERC6699Registry.sol`, `protocol/registry.js mayPlay`)
already asks one question of a player: does the wallet that owns the player's
profile own or control the character? With universal login that wallet is the
proxy. A minter forges characters to `resolve(sub).address`; the "registry
entry is the keccak of the AIR identity" line in BUILD-SPEC §6 is exactly the
`airKey(sub)` binding on the profile. Progression (`progress`) stays with the
settlement pipeline, never with the player or the proxy.

## Endpoints

| | |
|---|---|
| `GET /air` | `{ enabled, partnerId, jwksUrl, keys, sponsor, contract }` |
| `POST /air/session` `{ token, playerKey?, name? }` | verify → proxy → profile → bind. `{ sub, address, tokenId, name, custody, playerKey, steps, email, airAddress }`. 401 on a bad token, 502 when the chain or sponsor fails. |
| `POST /air/revoke` `{ token, playerKey }` | revoke a browser key from the caller's own profile |
| `GET /air/resolve?sub=` | public read: the profile an AIR user id maps to, or null |

`node.env`: `AIR_PARTNER_ID=<partner id>` (recommended; without it any AIR
partner's token is accepted), `AIR_JWKS_URL` (override), `AIR=0` (off). On by
default whenever PlayerProfile is set and the chain is reachable. The sponsor
is the announcer key; `/health.directory.announcer.address` is the address to fund.

## Signing from the dashboard (operators)

The Nodes page has an **Operator** panel: connect the operator's own wallet
(MetaMask on litVM, added automatically) and bond this node (approve +
stake at the contract minimum), take testnet tLITVM from the faucet, delegate
and fund the node's announcer, or transfer the node to another operator. The
calldata is the node's own `protocol/staking.js` / `protocol/directory.js`;
the wallet signs; the cabinet never sees a key. The CLI tools remain the
scripted path (`npm run bond`, `npm run transfer`, `npm run announcer`).

Player-side transactions are the proxy's job; there is nothing for a player
to sign in the dashboard, and that is the point.

## Honest zeroes

- Not run against a real AIR token yet. AIR allows the partner's domains
  only, so the first live sign-in happens on arcade.litvm.games after a
  deploy, against a node with `AIR_PARTNER_ID` set and a funded announcer.
- `buildEnv` must match the environment the partner was created in
  (`cabinet/config.js AIR.buildEnv`, `?airenv=` to test). Sandbox and
  production JWKS are both tried by the node.
- Proxy keys are plain JSON files, like the announcer key. Encrypting them at
  rest with an operator secret is a follow-up; so is a `custody: 'elsewhere'`
  hand-off (a node exporting a proxy to the node the player now uses).
- Rename is not exposed yet (`PlayerProfile.rename` exists).
