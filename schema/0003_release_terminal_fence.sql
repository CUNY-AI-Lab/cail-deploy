-- Keep the durable row monotonic even while an older Worker version overlaps
-- a newer one. Application transitions carry the same fence in their CAS
-- predicate; this trigger protects direct SQL writers and migration overlap.
CREATE TRIGGER IF NOT EXISTS release_terminal_status_fence
BEFORE UPDATE OF status ON releases
WHEN (
    OLD.status IN ('live', 'failed', 'rejected')
    OR EXISTS (
      SELECT 1 FROM release_events
      WHERE release_id = OLD.release_id
        AND type IN ('release.live', 'release.failed', 'release.rejected')
    )
  )
  AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal release status cannot regress');
END;
