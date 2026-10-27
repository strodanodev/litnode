# Follow-up: Pickle Brawl, unified settlement phase 1

**Run this only after the user has approved `docs/SETTLEMENT-ARCHITECTURE.md`
(rev 2) in strodanodev/litnode (`E:\NPC\AGENT 24 NODE`).** That file is the
plan. Read its §0, §3, §6, §8, §11 and §18 (phase 1) first.
`docs/SETTLEMENT-STANDARD.md` stays canonical.

You work in `E:\NPC\PICKLEBRAWLv2\PickleBrawl` (master `b6192ca`, 38 commits
unpushed). Don't touch `pb-runtime`, which is the live runtime; the user
promotes it.

## Why

- Pickle Brawl's court key `09b2b849…7e23` was copied to m16
  (`STANDBY-HOST.md` §3). Phase 1 ends that by running the court on the
  desktop only, with **no new key and no new PB build**. Phase 2 retires the
  court key altogether: the match loop becomes a server bundle and the
  mesh replays results with PB's verifier.
- The matchmaker receives each player's AIR JWT on every `/lobby/*` and
  `/social/poll` call and forwards it to the API (`lib/directory.ts`).
  Under rev 2, no player token may reach anything a node runs.

## Do

1. **Matchmaker tickets instead of AIR JWTs.**
   - The API gains `POST /api/matchmaker/ticket`. It takes the AIR JWT and
     an optional `{ key, sig }` proof (`cabinet:sign-seat` over an API
     nonce). It returns a ticket signed by a new API key from Vercel env
     (`MATCHMAKER_TICKET_KEY`):
     ```
     { sub, key?, name, scope: ['lobby', 'friends:read'], aud: 'pb-matchmaker', exp ≤ 10 min }
     ```
   - The matchmaker accepts only that ticket, verified with the API's public
     key from config (not a secret). It refuses a raw AIR JWT.
   - `GET /api/friends` and `/api/friends/lookup` accept the ticket for
     `friends:read` only.
   - The web client fetches and refreshes the ticket, and sends it instead
     of the JWT.
2. **No join without a secret.** Delete the legacy `COURT_TICKET_SECRET`
   lines from the two `.env` templates and docs, and make the court refuse
   every join when it has no per-match secret. Today it admits anyone
   (`PickleBrawlGameMode.canPlayerJoin`).
3. **Seats are keys inside the arcade.**
   - A ticket that carries a proven `key` seats that key, even without a
     PlayerProfile binding.
   - The court's `LITNODE_SEATS` fallback keeps `key` (`court.ts:397`).
   - `/api/court/result` resolves a mesh key to an account through the
     wallet link or PlayerProfile, so placed matches stop answering
     `unknown-player` (`courtResult.ts:189-191`).
4. **Drop m16 from the web build.** `web/litnodeBackend.ts` lists only the
   desktop node until phase 2 removes the allowlist.
5. **Register before promote.** Hold the uncommitted `PlayerPawnPB.ts`
   change until verifier `11203288` is active. Then commit it only together
   with its new verifier pack, and note both hashes in the hand-back.
6. Tests:
   - matchmaker: a raw JWT is refused, a forged or expired ticket is
     refused, and `friends:read` is the only API scope;
   - court: no secret means no join;
   - API: ticket mint, scope and key resolution;
   - the existing court, matchmaker and verifier suites, all green.

   Commit locally (only your files).

## Phase 2 notes (don't build; check feasibility and report)

Phase 2 makes PB's court loop a hashed server bundle on any opted-in node
and makes the verifier the judge (architecture §3, §4, §8). Report:

- whether the court loop can run from a bundle without its `.env`
  (what it reads today, by name only);
- where the client could sign an input head every 30 s (`{ matchId, seat,
  ticks, head }` through `cabinet:sign`) and what the log needs to record
  (client tick and applied tick per input);
- whether the verifier replays under `node --permission` with read access
  to its own unpacked bundle only.

## Don't

- Don't change game or engine code beyond item 5.
- Don't copy any `.env` or key file.
- Don't push, deploy or register.

## User steps to list in your hand-back (don't do them)

1. Set `MATCHMAKER_TICKET_KEY` in the PB API's Vercel env.
2. Confirm the API is the Vercel deployment. Its README still says the
   Vercel project is retired.
3. Deploy the API, then the web build. Restart the desktop's services.
4. On m16, stop the PB court and matchmaker, and delete the copied
   `pickle-brawl-court.json` and `services/*/.env`.

## Hand-back

Append a "unified phase 1" section to `docs/LITNODE-V4-HANDBACK.md` with:
- the ticket format;
- test results;
- the phase 2 feasibility notes;
- anything litnode must change.
