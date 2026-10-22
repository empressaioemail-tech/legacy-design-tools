-- T1-A (2026-10-22) — duplicate-account merge, DRY RUN. READ ONLY.
--
-- Prints counts only (no emails, no ids). Run after migration 0115, inside a
-- read-only transaction:
--
--   BEGIN READ ONLY;
--   \i artifacts/api-server/sql/pe_account_merge_DRY_RUN.sql
--   ROLLBACK;
--
-- The merge itself is src/peAccountMergeCli.ts (dry run by default; --apply
-- writes). Its grouping is transitive (a user verified on two addresses joins
-- both groups); the counts below group by one shared address at a time, so
-- they can only be equal to or larger than the CLI's group count, never
-- smaller.

WITH v AS (
  SELECT DISTINCT lower(i.email) AS email, i.user_id
    FROM pe_user_identities i
   WHERE i.email_verified
     AND i.email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pe_account_merges m WHERE m.merged_user_id = i.user_id)
),
dup AS (
  SELECT email FROM v GROUP BY email HAVING count(*) > 1
),
members AS (
  SELECT v.email, v.user_id, COALESCE(e.access_tier = 'paid', false) AS paid,
         e.stripe_customer_id IS NOT NULL AS has_customer
    FROM v JOIN dup USING (email)
    LEFT JOIN pe_user_entitlements e ON e.owner_user_id = v.user_id
)
SELECT
  (SELECT count(*) FROM dup)                                        AS duplicate_email_groups,
  (SELECT count(DISTINCT user_id) FROM members)                     AS users_in_groups,
  (SELECT count(DISTINCT user_id) FROM members) - (SELECT count(*) FROM dup)
                                                                    AS users_to_merge_away_upper_bound,
  (SELECT count(*) FROM (SELECT email FROM members GROUP BY email HAVING bool_or(paid)) x)
                                                                    AS groups_with_a_paid_user,
  (SELECT count(*) FROM (SELECT email FROM members GROUP BY email HAVING count(*) FILTER (WHERE paid) > 1) x)
                                                                    AS groups_with_two_paid_users,
  (SELECT count(*) FROM (SELECT email FROM members GROUP BY email HAVING count(*) FILTER (WHERE has_customer) > 1) x)
                                                                    AS groups_with_two_stripe_customers;

-- Verified vs unverified identities (unverified never merge).
SELECT provider, email_verified, count(*) AS identities
  FROM pe_user_identities
 GROUP BY provider, email_verified
 ORDER BY provider, email_verified;

-- Rows owned by users in duplicate groups, per table (includes survivors;
-- the CLI dry run prints the exact merged-away counts).
WITH v AS (
  SELECT DISTINCT lower(i.email) AS email, i.user_id
    FROM pe_user_identities i
   WHERE i.email_verified AND i.email IS NOT NULL
),
dup_users AS (
  SELECT DISTINCT user_id FROM v
   WHERE email IN (SELECT email FROM v GROUP BY email HAVING count(*) > 1)
)
SELECT 'pe_user_identities' AS table_name, count(*) AS rows FROM pe_user_identities WHERE user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_saved_properties', count(*) FROM pe_saved_properties WHERE owner_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_screens', count(*) FROM pe_screens WHERE owner_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_property_unlocks', count(*) FROM pe_property_unlocks WHERE owner_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_user_entitlements_paid', count(*) FROM pe_user_entitlements WHERE access_tier = 'paid' AND owner_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'records_request_jobs', count(*) FROM records_request_jobs WHERE user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'brokerage_brief_runs', count(*) FROM brokerage_brief_runs WHERE owner_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_share_grants', count(*) FROM pe_share_grants WHERE grantor_user_id IN (SELECT user_id FROM dup_users)
UNION ALL SELECT 'pe_team_members', count(*) FROM pe_team_members WHERE account_owner_user_id IN (SELECT user_id FROM dup_users) OR member_user_id IN (SELECT user_id FROM dup_users);
