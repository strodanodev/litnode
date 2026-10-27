# Follow-up: Agent Fighter, unified settlement

**Run this only after the user has approved `docs/SETTLEMENT-ARCHITECTURE.md`
(rev 2) in strodanodev/litnode (`E:\NPC\AGENT 24 NODE`).** Read its §1, §6,
§11 and §17 rows 2 and 9.

You work in `E:\NPC\AGENT FIGHTER\agent-fighter` (master `9c1ca39`).

## Why

Ranked Agent Fighter already matches the target: a hashed server bundle on
any opted-in node, both players sign, and witnesses replay. Nothing changes
there.

Casual is what doesn't match. The relay (`packages/server/src/server.ts`,
`persist.ts`) holds `SUPABASE_SERVICE_KEY` and the AIR partner key, and it
receives players' AIR tokens. It runs on the desktop as a litnode task, and
m16 has a copied `.env` (`STANDBY-HOST.md` §2). Under rev 2 litnode holds
no secret but the node's own key, and Season 0 doesn't launch until that is
true, so the relay split is a **Season 0 blocker**, not "someday".

## Phase 1 (docs and small cleanups)

- Update `docs/deploy.md`: the relay runs only on the publisher's own
  machine until the split, the `.env` is never copied, and m16 runs no
  relay.
- Drop the "blank `AIR_PARTNER_ID`" instruction; litnode's relay env
  allowlist (`93fc3b0`) is on master.
- Drop the client-side participant filter in `packages/client/src/proof.ts`.
  Every node is 0.12.1.
- Shrink `DEFAULT_RPCS` to one last-resort entry, because the arcade serves
  `rpcFallback`.

## Phase 2 (design first; build when the user says so)

Split the relay in two:

1. **The account API** (sign-in, credits, escrow, items, pets, tickets)
   moves to Vercel functions. Supabase stays. It takes the AIR token the
   arcade lends (`cabinet:air`); nothing else does.
2. **The rooms relay** becomes secret-free. It seats players with tickets
   the API signs (the same shape as Pickle Brawl's matchmaker ticket), or
   with match orders (architecture §7), and holds no database key. It then
   runs on any node as a server bundle, and `PREFERRED_RELAYS` goes away.

Write `docs/adr/0015-relay-split.md`. It must cover:
- the routes that move;
- the ticket format;
- what the relay keeps in memory;
- how a casual match survives the desktop being off.

Keep AF's own Elo and season board, labelled as the studio's
(architecture §10).

## Don't

- Don't change `packages/core`; that would mean a new build hash.
- Don't push or deploy. Commit locally (only your files).

## Hand-back

Report:
- the phase 1 commits;
- the ADR;
- the env each half needs, by name only.
