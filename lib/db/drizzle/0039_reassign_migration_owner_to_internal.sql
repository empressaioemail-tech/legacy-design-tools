-- Task #29 follow-up — isolate legacy backfill from anonymous demo sessions.
-- Migration 0038 assigned pre-existing engagements to `migration-owner`, which
-- PR #168 mapped to the anonymous session path. Reassign to a dedicated internal
-- owner that no unauthenticated caller resolves to.

UPDATE "engagements"
SET "owner_user_id" = 'legacy-internal-owner'
WHERE "owner_user_id" = 'migration-owner';
