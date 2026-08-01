# Release transition rollout

This note is the migration and restart contract for the release terminal fence.
It does not authorize a deployment or a provider mutation.

## Contract

`transitionReleaseStatus` performs the release-row compare-and-set and its
event insert in one D1 `batch()`. D1 documents that batched statements execute
sequentially and non-concurrently as one SQL transaction; a failed statement
rolls back the sequence. A terminal status or terminal event therefore fences
later nonterminal transitions. Repeating the exact transition returns
`already_applied`; a transition that loses the fence returns `fenced`.

The Workflow's publishing CAS is the authorization linearization point. If the
CAS loses to a terminal state, the Workflow returns before loader, R2, or WfP
work. If the CAS wins and a terminal reconciliation later wins, a duplicate
WfP `PUT` remains permitted only because `publishWorker` derives the same
run/project target and sends the same retained prepared bytes for that release.
The D1 terminal transition remains authoritative; D1/provider atomicity is not
claimed. Reconciliation completion and the late ambiguous-publication step are
both terminal-event-fenced, so they cannot append `release.reconciling` after a
terminal winner.

Reconciliation completes its live row CAS before inserting `release.live` in
the same D1 batch. That ordering is required by the migration trigger's
event-only fence; the batch still requires all row, event, and authority
updates to change one row, so a partial completion is not accepted.

Completed Workflow steps are cached by deterministic step name and may return
persisted state on restart. Older release Workflow steps returned no transition
state, and the older bundle/reuse steps returned prepared fields without an
`outcome`. The current code treats those shapes as legacy state, rechecks the
authoritative D1 row, exits for a terminal release, and never repeats the old
transition side effect.

References: [D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
and [Workflow sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

## Migration-first rollout

Apply `schema/0003_release_terminal_fence.sql` to the authoritative D1 database
before starting a Worker version that contains the new transition helper, and
before allowing old and new Worker versions to overlap:

The operator must resolve the exact environment-specific Wrangler configuration
and D1 database name during deployment approval, then use Wrangler's documented
`d1 migrations apply` command. This repository's `wrangler.jsonc` names the
local control plane and must not be copied into a production command. This note
intentionally contains no executable remote command or unresolved shell
placeholder.

Then verify the migration is recorded and the trigger exists with a read-only
query. The mismatch query below is also read-only and must return zero rows
before proceeding. Only after all three checks pass may the new Worker be
started. Do not run this runbook against production resources from the local
test configuration.

First inspect terminal row/event agreement:

```sql
WITH terminal_evidence AS (
  SELECT
    release_id,
    COUNT(*) AS terminal_event_count,
    GROUP_CONCAT(type, ',') AS terminal_events,
    MAX(
      CASE type
        WHEN 'release.live' THEN 'live'
        WHEN 'release.failed' THEN 'failed'
        WHEN 'release.rejected' THEN 'rejected'
      END
    ) AS event_status
  FROM release_events
  WHERE type IN ('release.live', 'release.failed', 'release.rejected')
  GROUP BY release_id
)
SELECT
  r.release_id,
  r.status,
  COALESCE(e.terminal_event_count, 0) AS terminal_event_count,
  e.terminal_events,
  e.event_status
FROM releases AS r
LEFT JOIN terminal_evidence AS e ON e.release_id = r.release_id
WHERE COALESCE(e.terminal_event_count, 0) > 1
   OR (
     COALESCE(e.terminal_event_count, 0) = 0
     AND r.status IN ('live', 'failed', 'rejected')
   )
   OR (
     COALESCE(e.terminal_event_count, 0) = 1
     AND e.event_status <> r.status
   )
ORDER BY r.release_id;
```

Then verify the migration ledger and trigger definition:

```sql
SELECT id, name, applied_at
FROM d1_migrations
WHERE name = '0003_release_terminal_fence.sql';

SELECT name, sql
FROM sqlite_master
WHERE type = 'trigger'
  AND name = 'release_terminal_status_fence';
```

Proceed only when the mismatch query returns zero rows, the migration query
returns exactly one `0003_release_terminal_fence.sql` row, and the `sqlite_master`
query returns exactly one trigger whose SQL includes the terminal-event
`EXISTS` fence. Stop for investigation if any check differs; do not auto-repair
rows or run a remote command from this change. The migration command above is
an operator runbook step and was not executed by the local tests.

The migration is additive. It does not rewrite existing rows or events; an
operator must inspect any already-terminal rows whose status and terminal event
do not agree before treating the database as repaired. The trigger protects
future direct SQL/status updates, while application CAS protects normal
transitions. Rollback of the Worker binary must not precede migration rollback:
the trigger is the overlap guard and should remain installed.

## Evidence required before deployment approval

- Focused schema tests show one row/event pair under interleaved D1 batches,
  terminal-to-nonterminal no-op behavior, and reverse-order terminal wins.
- Workflow tests show legacy `undefined` transition outputs, legacy prepared
  outputs, stale non-rollback replay with no loader/R2/provider call, and the
  deterministic duplicate WfP target/body contract after a later terminal win.
- The local Workflows/D1/R2/provider lifecycle gate passes, including retained
  rollback bytes and ambiguity/reconciliation terminal fencing.
- No deployment, remote provider mutation, or credentialed production check is
  inferred from these local tests.
