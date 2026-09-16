# Annorak — not an adapter, on purpose

Annorak never goes down and never rolls back, so it is not a match that ends and
it cannot be an ephemeral container that dies at match end. `defineTitle` has no
honest shape for it in this build.

What it actually needs, and what none of it shares with the other three:

- Sharded authoritative **regions**, not matches. Placement draws a region host
  for a term, not a bout.
- **Live handoff** between region hosts with no rollback, where the resume path
  in section 4.2 is continuous rather than triggered by failure.
- Periodic **world snapshots** into the mesh, since there is no end-of-match
  moment at which to write a delta.
- A witness that verifies **continuity** — that no unexplained state jump
  occurred between two snapshots — rather than verifying a result.

The right move for the first build is to leave Annorak on its own backend and
take only the parts that already fit: ERC-6699 hydration for characters walking
in, and settlement of discrete events (trades, duels, region captures) as deltas.

Folding a persistent world into `host` and hoping is how the match path gets
compromised to serve the one title that does not fit it.
