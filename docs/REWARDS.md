# Season Zero rewards — points from the chain

**Status: points only.** `npm run rewards` computes what every operator and
publisher *would* earn, from what the chain recorded. Nothing is paid: there is
no rewards contract yet (BUILD-SPEC §16). The numbers are the ones a future
claim root would carry, so they are exact to the wei and anyone can recompute
them.

Code: `protocol/rewards.js` (the fold, pure), `protocol/rewards-chain.js` (reading
the chain), `tools/rewards.mjs` (the command). Parameters: `contracts/deploy.testnet.json`
→ `Rewards.params`. Tests: `demo/rewards.test.mjs`.

## The gate: 10 or more, or nothing

Rewards run only while **10 or more operators are active**, and pause below 10
(decided 27 Sep 2026). An hour with the gate shut releases nothing; the pool
keeps it.

*Active* means the operator's node did work the chain can prove in the last
24 hours: hosted a match, attested one, finalized one, or proposed an hourly
epoch root. It is counted **per operator wallet**, so one person cannot open the
gate with ten machines (`countBy: "node"` counts machines instead). With an
`allowlist`, only listed wallets count and earn.

A node that is online but idle is not "active" here: gossip is each node's own
view and cannot be checked, the chain can. Rewards need ranked matches anyway,
and in a session with ten operators playing, the random draws reach every one
of them within an hour or two.

## Emission

Each hour with the gate open and at least one match that counts releases

    released = pool left × r₀ × m
    r₀ = ln 2 ÷ (180 days × 24)           ≈ 0.016 % of what is left, per hour
    m  = min(3, 1 + 2·√(Q̄ ÷ 400))

**Q̄** is the quality-weighted number of counted matches per hour, averaged over
the last 24 hours, so bunching matches into one quiet hour does not pay. At
baseline half the pool is paid out every 180 days; more traffic pays out faster,
up to 3× (60 days). The release is split between the hour's counted matches in
proportion to their weight.

## What a match must be to count

Finalized as `final` on MatchBook, with the host's result standing, two or more
agreeing witnesses, two or more players, every player's key bound to a player
profile (`requireProfiles`), and no player owned by the host's or a witness's
operator (self-play).

Its **weight** starts at 1 and falls for patterns that cost a cheater nothing:

| Rule | Weight |
|---|---|
| The same players again the same day | 1, ½, ¼, ⅛, 1/16, then 0 after 5 |
| A player's 31st counted match of the day | 0 |
| Diversity: distinct opponents each player met in the last 7 days | × min(1, opponents ÷ 3) for the less varied player |

Why: without weights, a title owner adding 60 bot matches an hour to 60 real
ones took 12 % of the hour's release and cut everyone else's by 41 %. With
them, those 60 bot matches weigh about 0.65 — roughly 1 % of the hour
(`demo/rewards.test.mjs`, "wash trading").

## How one match's share is paid

The match's allocation splits host 35 % · each agreeing witness 10 % (three
seats) · the title's publisher 20 % · guardian 15 %. The guardian share goes to
the escalation panel members who sided with the final result, or else to
whoever finalized the match. **In practice that is the host:** the node sends
`finalize` from the host first and from each seat only 20 s × seat later
(`node/matchbook.js`), so until a dispute escalates the host collects 50 % of
every match it hosts, its three witnesses 30 % between them, the publisher 20 %.

**Gas is not paid from the pool.** Since 8 Oct 2026 GasRefund pays the host's
and each agreeing witness's gas back on chain (docs/GAS-REFUND.md). Until
19 Oct the fold refunded each duty's receipt out of the hour's release first,
which would have paid the same gas twice.

Operator shares are then scaled by **reliability**: witness seats answered ÷
seats drawn over the last 7 days (a settled match counts for its host). At
90 % or more it pays in full; at 50 % or less nothing; a straight line between
(70 % pays half). A placement that never settles is not held against its host:
it is almost always players leaving, which the chain cannot tell from an
outage, and the host already earns nothing for it.

**Forfeits.** An operator forfeits a whole week (Monday to Monday UTC): the
week one of its nodes is slashed, or the week a match voided after it dissented
alone on it — the week of the void, not of the dissent, so a Sunday-night
dissent whose match voids on Monday forfeits the new week. Until 13 operators
exist, a lone wrong attestation voids a match for free (BUILD-SPEC §16); this
rule makes it cost the week. A dissent that was a genuine report — a replay
bug, say — can be exempted by adding the match to `waivers`.

Everything not paid — seats that did not agree, missing publishers,
reliability cuts, forfeits, rounding — **rolls back into the pool**. For every
hour, paid + rolled back = released, and the pool only ever shrinks by what was
paid.

## Where the numbers come from

The chain's own `eth_getLogs` over MatchBook, NodeStake, TitleRegistry,
PlayerProfile and EpochAnchor, each log joined with its receipt for the sender,
so a `finalize` is credited to the bonded node that sent it.
Not the block explorer: on 27 Sep 2026 its index lacked the `Staked` events of
two bonded nodes, both title registrations of 26 Sep and a MatchBook
`Finalized`, and a payout computed from it would silently skip people.

The RPC answers ~1.5 ms per block with an address filter and takes parallel
requests; Liteforge adds ~350,000 blocks a day, so a season is millions and the
first run takes tens of minutes. The scan is read in 200,000-block segments and
`data/rewards/<chainId>.json` is written after each, so a run that stops (a
rate limit, Ctrl-C) keeps what it read and the next run continues from there;
later runs read only the new blocks. A request the node times out is split in
half and asked again. A 429 holds every request until the gateway's
Retry-After (else 1 s, doubling to a minute); eight in a row give up. On
19 Oct 2026 the first sync since 27 Sep died at 30 % of 7.4 million blocks on
one 429 and lost all of it; this is why.

## Running it

    npm run rewards                         sync and report from the season start
    npm run rewards -- --hours 48           the hour table: the last 48 hours with work
    npm run rewards -- --json               everything, amounts in wei
    npm run rewards -- --min-active 4       what the rules would pay with the gate at 4 (a test)
    npm run rewards -- --pool 50000 --from 2026-09-28T00:00:00Z
    npm run rewards -- --no-profiles        count matches whose players have no profile yet
    npm run rewards -- --no-sync            use the cache as it is

`seasonStart: null` starts at the hour of the first finalized ranked match.
The pool (`"200"`) is the zkLTC in the rewards treasury
0xeA09E9B9Acf53462dC4490c9174fdB41B3f62eF2; raise it when the litVM allocation
lands. At 200 zkLTC the formula releases 1–2.3 zkLTC a day at most.

## Not built yet

- **Payouts.** A contract that accepts hourly reward roots by stake quorum
  (as EpochAnchor does for the ladder) and lets each wallet claim.
- **Proof of replay.** A witness attests a result hash the host already
  published, so a witness can copy it without replaying and still earn. The
  fix — witnesses also commit a hash of the game state at a tick chosen after
  the settle, which only a replay can produce, spot-checked by guardians — needs
  the witness path and the titles to expose that state. Until then, witness
  pay rewards answering, not verifying.
- **The Node page panel**, showing each operator its points. The calculation
  is isomorphic and ready; reading a season of logs belongs on the node, not in
  a browser.
- **Escalation at scale.** The nine-seat dispute panel needs 13 operators;
  below that, the lone-dissent forfeit stands in for slashing.
