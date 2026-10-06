# Gas refunds: the treasury pays back what ranked matches cost the nodes

A ranked match costs the nodes that serve it real gas, paid in zkLTC from
each node's hot key (its delegate on NodeStake):

| Step | Sent by | Gas on Liteforge (22 Sep receipts) |
|---|---|---|
| `commit` | the host | ~279,000 |
| `settle` | the host | ~127,000 |
| `finalize` | the host (or a seat as backstop) | ~38,000 |
| `attest` | each of the three witnesses | ~75,000 each |

That is about 670,000 gas a match, roughly 0.001 zkLTC at 1.5 gwei. A key that
runs dry stops committing, and its matches quietly turn casual. Volunteers will
not keep refilling hot keys to referee strangers' games, so the treasury pays it
back.

## How it works

`contracts/GasRefund.sol`, deployed beside MatchBook and NodeStake:

1. **Funding.** The treasury sends zkLTC to the contract with a plain transfer.
   That is the only human step.
2. **Claim.** Once MatchBook says a match is FINAL, anyone may call
   `claim(matchId, callerKey)`. The contract reads MatchBook itself and pays,
   into each node's delegate (the key that spent the gas):

   | Who | Refund |
   |---|---|
   | The host | `hostGas × price × refundBps` |
   | Each witness whose vote equals the final result | `witnessGas × price × refundBps` |
   | The seat that sends the claim | `+ claimGas × price × refundBps` |

   Here `price = min(block.basefee, maxPriceWei)`.
3. **Nodes claim for themselves** (`node/matchbook.js`). The host claims about
   5 s after the match is final. Each seat claims only if the match is still
   unclaimed 2 minutes × (seat + 1) later, so a live host is never raced and a
   gone one is covered. `/health.matchBook.refunds` shows the contract, claims
   sent, claims due and the last one.

No publisher, server or signer is involved. It keeps working with the
publisher offline.

## Rules

- Once per match. A void, escalating or unfinished match pays nothing.
- An absent or dissenting witness gets nothing for that match.
- At most `dailyCapWei` per node key per UTC day.
- `refundBps` is below 100 % on purpose. Four colluding operators who stage
  ranked matches between their own keys always lose 20 % of the gas, instead of
  draining the treasury for free.
- If the contract holds less than a claim needs, the claim reverts
  (`Underfunded`), and the nodes retry later.
- A delegate that refuses the payment is skipped; the others are still paid.
- The admin (the admin wallet now, a multisig later) can `setParams` within
  bounds (at most 100 %, at most 2M gas a seat, a cap of at most 1000 gwei),
  `setPaused`, and `withdraw` funds back to the treasury.

## Parameters (contracts/deploy.testnet.json → GasRefund)

| Parameter | Value | Why |
|---|---|---|
| `hostGas` | 445,000 | commit + settle + finalize, from receipts |
| `witnessGas` | 77,000 | one attest, from receipts |
| `claimGas` | 260,000 | the claim itself (four payments, the daily counters) |
| `refundBps` | 8000 | 80 % |
| `maxPriceGwei` | 10 | a base-fee spike is refunded at the cap |
| `dailyCapZkLTC` | 0.05 | about 77 matches a day as host at 1.5 gwei |

## Deploy and fund

```
set DEPLOYER_KEY=0x...
node tools/deploy-contracts.mjs --only GasRefund
```

This writes `GasRefund` into `contracts/deployed.testnet.json`. Nodes pick it up
from that file (or `GAS_REFUND=<address>` in node.env) on the next release. Then
send zkLTC to the contract address from the treasury. 1 zkLTC covers about 1,500
host refunds at 1.5 gwei.

Tests: `demo/gasrefund-vm.test.mjs` (the contract's rules) and
`demo/matchbook-node.test.mjs` (five nodes: a ranked match to final, then the
host claims by itself and four refunds land).
