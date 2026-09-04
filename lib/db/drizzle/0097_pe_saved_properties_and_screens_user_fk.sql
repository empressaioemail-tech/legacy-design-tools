-- OPS-16 P-111 (A-075/A-076): pe_saved_properties and pe_screens had NO
-- foreign key to users at all, so deleting a users row orphaned every saved
-- property and every screen permanently -- never cleaned up, never
-- reachable by anyone, dead rows tied to a user id that no longer exists.
-- Twelve other tables already cascade correctly from users (pe_property_unlocks,
-- pe_workbench_state, pe_user_identities, pe_user_entitlements, etc.); these
-- two, the exact tables holding a customer's saved property list and Studio
-- screens, did not.
--
-- Operator ruling 2026-09-02 (OPS-16 A-076): "it is all beta data and a
-- clean wipe is preferred, so the account-deletion orphan does not need a
-- careful migration -- the FK and a wipe are enough." So this migration:
--
--   1. Deletes existing orphaned rows (owner_user_id with no matching
--      users.id row) BEFORE adding the constraint. Required either way --
--      ADD CONSTRAINT fails outright against existing violations -- and it
--      is also the "clean wipe" the ruling asked for rather than a careful
--      backfill.
--   2. Adds the FK with ON DELETE CASCADE, matching the other thirteen
--      users.id references in this schema. Constraint names follow the
--      `<table>_<column>_users_id_fk` convention already used for
--      pe_property_unlocks and pe_chat_message_counts (0063).
--
-- pe_screen_rows is NOT touched directly here: it already cascades off
-- pe_screens.id (ON DELETE CASCADE, migration 0088), so deleting an
-- orphaned pe_screens row here also removes its pe_screen_rows rows.
--
-- Both the delete and the ADD CONSTRAINT are written to be safe to run
-- against a schema with zero orphans (the common case in CI, and true of
-- every freshly-pushed test schema) and safe to re-run: the delete's WHERE
-- clause matches nothing once orphans are gone, and each constraint add is
-- gated on pg_constraint so a second run is a no-op rather than an error.
-- The pg_constraint check is scoped with `::regclass` (resolves the table
-- name through search_path, exactly like the ALTER TABLE right below it)
-- rather than a bare conname match -- pg_constraint is a flat, database-wide
-- catalog, so an unscoped check would also match a same-named constraint on
-- an identically-named table living in a completely different schema.
--
-- Counts are surfaced via RAISE NOTICE (migrate-prod.mjs attaches a
-- 'notice' listener that prints them) so there is a record of how many rows
-- were actually affected when this runs against prod, per the operator's
-- own requirement -- a separate deliberate run-migrations dispatch, not
-- part of this PR.

DO $$
DECLARE
  saved_orphans integer;
  screen_orphans integer;
BEGIN
  DELETE FROM pe_saved_properties t
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.owner_user_id);
  GET DIAGNOSTICS saved_orphans = ROW_COUNT;
  RAISE NOTICE 'P-111: deleted % orphaned pe_saved_properties row(s) (owner_user_id with no matching users.id)', saved_orphans;

  DELETE FROM pe_screens t
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.owner_user_id);
  GET DIAGNOSTICS screen_orphans = ROW_COUNT;
  RAISE NOTICE 'P-111: deleted % orphaned pe_screens row(s) (owner_user_id with no matching users.id; pe_screen_rows for these cascaded automatically)', screen_orphans;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pe_saved_properties_owner_user_id_users_id_fk'
      AND conrelid = 'pe_saved_properties'::regclass
  ) THEN
    ALTER TABLE pe_saved_properties
      ADD CONSTRAINT pe_saved_properties_owner_user_id_users_id_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pe_screens_owner_user_id_users_id_fk'
      AND conrelid = 'pe_screens'::regclass
  ) THEN
    ALTER TABLE pe_screens
      ADD CONSTRAINT pe_screens_owner_user_id_users_id_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
