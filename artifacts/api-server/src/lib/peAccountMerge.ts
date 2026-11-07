/**
 * T1-A (2026-10-22) — one-time merge of duplicate Property Explorer accounts
 * that share a VERIFIED email (operator ruling 3: duplicates merge
 * automatically and the paid plan wins).
 *
 * WRITTEN, NOT RUN. The integration seat runs it through
 * `src/peAccountMergeCli.ts` (dry run by default; `--apply` to write). The
 * psql-only dry run is `sql/pe_account_merge_DRY_RUN.sql`.
 *
 * Grouping. Users are joined when they hold identities whose email is
 * verified (`pe_user_identities.email_verified`, migration 0115) and equal.
 * Joins are transitive (a user verified on two addresses bridges two
 * groups), computed as connected components. Unverified emails never join.
 *
 * Survivor. Within a group: the paid plan (`access_tier = 'paid'`, the
 * stored mirror of an active Stripe subscription) wins; ties go to the most
 * recent paid period (latest Stripe webhook delivery for that user, else the
 * entitlement's last update), then the oldest account, then the lowest id.
 * `findPeUserByVerifiedEmail` (sign-in linking) uses the same order.
 *
 * Move. Every user-owned row of each merged-away user moves to the survivor
 * (TABLES below; every table with a user-id column in the schema is either
 * here or listed in NOT_MOVED with the reason). Where the survivor already
 * holds the same natural key, the duplicate is DROPPED (or COMBINED into the
 * survivor's row: counts summed, first-seen kept earliest). Every touched row
 * is logged to `pe_account_merge_rows` with its full before-image, and one
 * `pe_account_merges` row per merged user records survivor, email and run.
 *
 * Idempotent. `pe_account_merges.merged_user_id` is the primary key and a
 * merged user is excluded from grouping; a merged user also holds no
 * identities afterwards. A re-run therefore finds nothing to do.
 *
 * The merged-away `users` row is KEPT (an empty shell: no identities, no
 * sessions) so the merge can be reversed by hand from the log. All its
 * sessions are revoked and a token cutoff is set, so a device still signed
 * in to it is signed out and lands on the survivor at next sign-in.
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";

type Client = Pick<pg.PoolClient, "query">;

export type MergeUser = {
  id: string;
  createdAt: Date;
  paid: boolean;
  subscriptionTier: string | null;
  paidAt: Date | null;
  stripeCustomerId: string | null;
  devRole: boolean;
};

export type MergeGroup = {
  emails: string[];
  survivor: MergeUser;
  merged: MergeUser[];
  /** Operator attention items; the merge still runs. */
  flags: string[];
};

/**
 * How each user-keyed table moves.
 *   keys: the natural key besides the owner column; a merged user's row whose
 *         keys match a survivor row is a duplicate.
 *   onConflict: "drop" (keep the survivor's row), or a SET clause folding the
 *         duplicate into the survivor's row (`s` = survivor row, `l` = merged).
 */
type TableSpec = {
  table: string;
  column: string;
  keys?: string[];
  combine?: string;
};

export const TABLES: ReadonlyArray<TableSpec> = [
  { table: "pe_user_identities", column: "user_id" },
  { table: "pe_saved_properties", column: "owner_user_id", keys: ["tenant_id", "parcel_node_id"] },
  { table: "pe_screens", column: "owner_user_id" },
  {
    table: "pe_property_unlocks",
    column: "owner_user_id",
    keys: ["tenant_id", "parcel_node_id"],
    combine:
      "expires_at = CASE WHEN s.expires_at IS NULL OR l.expires_at IS NULL THEN NULL ELSE GREATEST(s.expires_at, l.expires_at) END, unlocked_at = LEAST(s.unlocked_at, l.unlocked_at)",
  },
  { table: "pe_workbench_state", column: "owner_user_id", keys: [] },
  {
    table: "pe_chat_message_counts",
    column: "owner_user_id",
    keys: ["parcel_node_id"],
    combine: "count = s.count + l.count, updated_at = GREATEST(s.updated_at, l.updated_at)",
  },
  {
    table: "pe_account_activations",
    column: "owner_user_id",
    keys: ["milestone"],
    combine: "first_at = LEAST(s.first_at, l.first_at)",
  },
  {
    table: "pe_ai_connections",
    column: "owner_user_id",
    keys: ["client_name"],
    combine:
      "first_seen_at = LEAST(s.first_seen_at, l.first_seen_at), last_seen_at = GREATEST(s.last_seen_at, l.last_seen_at)",
  },
  { table: "pe_activation_events", column: "owner_user_id" },
  { table: "pe_share_grants", column: "grantor_user_id" },
  { table: "pe_share_attributions", column: "recipient_user_id", keys: [] },
  { table: "pe_user_entitlement_history", column: "owner_user_id" },
  { table: "pe_stripe_webhook_events", column: "owner_user_id" },
  { table: "pe_lifecycle_outbox", column: "owner_user_id" },
  { table: "ss_contact", column: "user_id", keys: [] },
  { table: "records_request_jobs", column: "user_id" },
  { table: "engagements", column: "owner_user_id" },
  { table: "brokerage_brief_runs", column: "owner_user_id" },
  { table: "brokerage_workspaces", column: "owner_user_id" },
  { table: "brokerage_install_claims", column: "owner_user_id" },
  { table: "brokerage_user_profiles", column: "owner_user_id", keys: [] },
  { table: "canva_connections", column: "owner_user_id" },
  { table: "canva_oauth_states", column: "owner_user_id" },
  {
    table: "user_usage_metering",
    column: "owner_user_id",
    keys: ["meter_key", "period_start"],
    combine: "count = s.count + l.count",
  },
  { table: "pe_team_members", column: "account_owner_user_id", keys: ["email"] },
  { table: "pe_team_members", column: "member_user_id", keys: [] },
  { table: "pe_team_invitations", column: "account_owner_user_id", keys: ["email"] },
  { table: "architect_notification_reads", column: "user_id", keys: [] },
  { table: "user_auth_credentials", column: "user_id", keys: [] },
  // T2-WATCH: the survivor keeps its own snapshot of a parcel both watch (the
  // merged one is dropped, logged); changes move as-is; a push endpoint is
  // unique per device, so subscriptions just move.
  { table: "pe_watch_snapshots", column: "owner_user_id", keys: ["parcel_node_id"] },
  { table: "pe_watch_changes", column: "owner_user_id" },
  { table: "pe_push_subscriptions", column: "owner_user_id", keys: ["endpoint"] },
];

/**
 * User-id columns deliberately NOT moved, with the reason (kept here so the
 * "every table" claim is checkable against the schema in one place).
 */
export const NOT_MOVED: Readonly<Record<string, string>> = {
  users: "the merged-away row is kept as an empty shell so the merge is reversible",
  pe_user_entitlements:
    "PK per user; the survivor keeps its own plan. dev_role is OR-ed in and a Stripe customer id moves only when the survivor has none (see mergeEntitlement)",
  saved_workspace_spaces:
    "unique (tenant, owner, name): moved with a renamed name on conflict (see moveSavedWorkspaceSpaces)",
  pe_sessions: "revoked, not moved: a merged-away user's devices sign in again and land on the survivor",
  pe_session_cutoffs: "written for the merged-away user, not moved",
  pe_magic_link_tokens: "keyed by email, not by user",
  pe_account_merges: "the merge log itself",
  pe_account_merge_rows: "the merge log itself",
};

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS ok",
    [table],
  );
  return r.rows[0]?.ok === true;
}

/** Union-find grouping of users that share a verified email. */
export async function planPeAccountMerge(client: Client): Promise<MergeGroup[]> {
  const pairs = await client.query<{ email: string; user_id: string }>(`
    SELECT DISTINCT lower(i.email) AS email, i.user_id
      FROM pe_user_identities i
      JOIN users u ON u.id = i.user_id
     WHERE i.email_verified
       AND i.email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pe_account_merges m WHERE m.merged_user_id = i.user_id)
     ORDER BY 1, 2`);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const firstUserByEmail = new Map<string, string>();
  for (const { email, user_id } of pairs.rows) {
    if (!parent.has(user_id)) parent.set(user_id, user_id);
    const first = firstUserByEmail.get(email);
    if (first) union(first, user_id);
    else firstUserByEmail.set(email, user_id);
  }

  const members = new Map<string, Set<string>>();
  const emailsOf = new Map<string, Set<string>>();
  for (const { email, user_id } of pairs.rows) {
    const root = find(user_id);
    if (!members.has(root)) members.set(root, new Set());
    members.get(root)!.add(user_id);
    if (!emailsOf.has(root)) emailsOf.set(root, new Set());
    emailsOf.get(root)!.add(email);
  }
  const multi = [...members.entries()].filter(([, s]) => s.size > 1);
  if (multi.length === 0) return [];

  const ids = multi.flatMap(([, s]) => [...s]);
  const info = await client.query<{
    id: string;
    created_at: Date;
    paid: boolean;
    subscription_tier: string | null;
    paid_at: Date | null;
    stripe_customer_id: string | null;
    dev_role: boolean | null;
  }>(
    `SELECT u.id, u.created_at,
            COALESCE(e.access_tier = 'paid', false) AS paid,
            e.subscription_tier,
            CASE WHEN e.access_tier = 'paid' THEN COALESCE(
              (SELECT max(w.received_at) FROM pe_stripe_webhook_events w WHERE w.owner_user_id = u.id),
              e.updated_at) END AS paid_at,
            e.stripe_customer_id,
            e.dev_role
       FROM users u
       LEFT JOIN pe_user_entitlements e ON e.owner_user_id = u.id
      WHERE u.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(
    info.rows.map((r) => [
      r.id,
      {
        id: r.id,
        createdAt: r.created_at,
        paid: r.paid,
        subscriptionTier: r.subscription_tier,
        paidAt: r.paid_at,
        stripeCustomerId: r.stripe_customer_id,
        devRole: r.dev_role === true,
      } satisfies MergeUser,
    ]),
  );

  const rank = (a: MergeUser, b: MergeUser): number => {
    if (a.paid !== b.paid) return a.paid ? -1 : 1;
    const ap = a.paidAt?.getTime() ?? -Infinity;
    const bp = b.paidAt?.getTime() ?? -Infinity;
    if (ap !== bp) return bp - ap;
    const ac = a.createdAt.getTime();
    const bc = b.createdAt.getTime();
    if (ac !== bc) return ac - bc;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  return multi
    .map(([root, set]) => {
      const users = [...set].map((id) => byId.get(id)!).filter(Boolean).sort(rank);
      const [survivor, ...merged] = users;
      const flags: string[] = [];
      if (merged.some((m) => m.paid)) flags.push("more_than_one_paid_account");
      if (merged.some((m) => m.stripeCustomerId)) flags.push("merged_user_has_stripe_customer");
      return {
        emails: [...emailsOf.get(root)!].sort(),
        survivor: survivor!,
        merged,
        flags,
      };
    })
    .sort((a, b) => (a.emails[0]! < b.emails[0]! ? -1 : 1));
}

export type TableCount = { table: string; column: string; rows: number };

/** Read-only: how many rows each merged-away user owns, per table. */
export async function countRowsToMove(
  client: Client,
  mergedUserIds: string[],
): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const spec of TABLES) {
    if (!(await tableExists(client, spec.table))) continue;
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${ident(spec.table)} WHERE ${ident(spec.column)} = ANY($1::text[])`,
      [mergedUserIds],
    );
    out.push({ table: spec.table, column: spec.column, rows: Number(r.rows[0]?.n ?? 0) });
  }
  return out;
}

async function logRows(
  client: Client,
  mergedUserId: string,
  table: string,
  action: string,
  rowsSql: string,
  params: unknown[],
): Promise<void> {
  await client.query(
    `INSERT INTO pe_account_merge_rows (merged_user_id, table_name, action, before)
     SELECT $1, $2, $3, to_jsonb(x) FROM (${rowsSql}) x`,
    [mergedUserId, table, action, ...params],
  );
}

/** Move one table's rows from `from` to `to`, handling natural-key duplicates. */
async function moveTable(
  client: Client,
  spec: TableSpec,
  from: string,
  to: string,
): Promise<void> {
  const t = ident(spec.table);
  const c = ident(spec.column);
  if (spec.keys) {
    const match = spec.keys.map((k) => `s.${ident(k)} IS NOT DISTINCT FROM l.${ident(k)}`);
    const on = [`s.${c} = $5`, `l.${c} = $4`, ...match].join(" AND ");
    if (spec.combine) {
      // Before-image of each survivor row about to absorb a duplicate.
      await logRows(
        client,
        from,
        spec.table,
        "updated",
        `SELECT s.* FROM ${t} s, ${t} l WHERE ${on}`,
        [from, to],
      );
      await client.query(
        `UPDATE ${t} s SET ${spec.combine} FROM ${t} l WHERE ${on.replace(/\$4/g, "$1").replace(/\$5/g, "$2")}`,
        [from, to],
      );
    }
    await logRows(
      client,
      from,
      spec.table,
      spec.combine ? "combined" : "dropped",
      `SELECT l.* FROM ${t} l WHERE EXISTS (SELECT 1 FROM ${t} s WHERE ${on})`,
      [from, to],
    );
    await client.query(
      `DELETE FROM ${t} l WHERE EXISTS (SELECT 1 FROM ${t} s WHERE ${on.replace(/\$4/g, "$1").replace(/\$5/g, "$2")})`,
      [from, to],
    );
  }
  await logRows(client, from, spec.table, "moved", `SELECT * FROM ${t} WHERE ${c} = $4`, [from]);
  await client.query(`UPDATE ${t} SET ${c} = $2 WHERE ${c} = $1`, [from, to]);
}

async function moveSavedWorkspaceSpaces(client: Client, from: string, to: string): Promise<void> {
  if (!(await tableExists(client, "saved_workspace_spaces"))) return;
  const conflict = `l.owner_user_id = $1 AND EXISTS (SELECT 1 FROM saved_workspace_spaces s
      WHERE s.owner_user_id = $2 AND s.tenant_id = l.tenant_id AND s.name = l.name)`;
  await logRows(
    client,
    from,
    "saved_workspace_spaces",
    "moved",
    "SELECT * FROM saved_workspace_spaces WHERE owner_user_id = $4",
    [from],
  );
  await client.query(
    `UPDATE saved_workspace_spaces l SET name = l.name || ' (merged)' WHERE ${conflict}`,
    [from, to],
  );
  await client.query(
    "UPDATE saved_workspace_spaces SET owner_user_id = $2 WHERE owner_user_id = $1",
    [from, to],
  );
}

/** dev_role is OR-ed in; a Stripe customer id moves only to a survivor without one. */
async function mergeEntitlement(client: Client, from: string, to: string): Promise<void> {
  const r = await client.query<{ s_dev: boolean | null; l_dev: boolean | null; s_cus: string | null; l_cus: string | null }>(
    `SELECT s.dev_role AS s_dev, l.dev_role AS l_dev,
            s.stripe_customer_id AS s_cus, l.stripe_customer_id AS l_cus
       FROM pe_user_entitlements l
       LEFT JOIN pe_user_entitlements s ON s.owner_user_id = $2
      WHERE l.owner_user_id = $1`,
    [from, to],
  );
  const row = r.rows[0];
  if (!row) return;
  const giveDev = row.l_dev === true && row.s_dev !== true;
  const giveCustomer = Boolean(row.l_cus) && !row.s_cus;
  if (!giveDev && !giveCustomer) return;
  await logRows(
    client,
    from,
    "pe_user_entitlements",
    "updated",
    "SELECT * FROM pe_user_entitlements WHERE owner_user_id = ANY(ARRAY[$4, $5]::text[])",
    [from, to],
  );
  await client.query(
    `INSERT INTO pe_user_entitlements (owner_user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [to],
  );
  if (giveCustomer) {
    // Detach from the merged user FIRST: a customer id must map to one user.
    await client.query(
      "UPDATE pe_user_entitlements SET stripe_customer_id = NULL, updated_at = now() WHERE owner_user_id = $1",
      [from],
    );
  }
  await client.query(
    `UPDATE pe_user_entitlements
        SET dev_role = dev_role OR $2::boolean,
            stripe_customer_id = COALESCE(stripe_customer_id, $3::text),
            updated_at = now()
      WHERE owner_user_id = $1`,
    [to, giveDev, giveCustomer ? row.l_cus : null],
  );
}

export type MergeRunResult = {
  runId: string;
  groups: MergeGroup[];
  mergedUsers: number;
  skippedAlreadyMerged: number;
};

/**
 * Apply the merge. Each group runs in its own transaction. Never call this
 * against production from a lane: the integration seat runs it.
 */
export async function applyPeAccountMerge(
  client: Client,
  opts: { runId?: string; now?: Date } = {},
): Promise<MergeRunResult> {
  const runId = opts.runId ?? `merge_${new Date().toISOString().slice(0, 10)}_${randomBytes(4).toString("hex")}`;
  const groups = await planPeAccountMerge(client);
  let mergedUsers = 0;
  let skippedAlreadyMerged = 0;
  for (const group of groups) {
    await client.query("BEGIN");
    try {
      for (const loser of group.merged) {
        const claimed = await client.query(
          `INSERT INTO pe_account_merges (merged_user_id, survivor_user_id, email, run_id, reason)
           VALUES ($1, $2, $3, $4, 'verified_email_duplicate')
           ON CONFLICT (merged_user_id) DO NOTHING
           RETURNING merged_user_id`,
          [loser.id, group.survivor.id, group.emails.join(","), runId],
        );
        if (claimed.rowCount === 0) {
          skippedAlreadyMerged += 1;
          continue;
        }
        for (const spec of TABLES) {
          if (!(await tableExists(client, spec.table))) continue;
          await moveTable(client, spec, loser.id, group.survivor.id);
        }
        await moveSavedWorkspaceSpaces(client, loser.id, group.survivor.id);
        await mergeEntitlement(client, loser.id, group.survivor.id);
        await client.query(
          `UPDATE pe_sessions SET revoked_at = now(), revoked_reason = 'account_merged'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [loser.id],
        );
        await client.query(
          `INSERT INTO pe_session_cutoffs (user_id, not_before, reason)
           VALUES ($1, now(), 'account_merged')
           ON CONFLICT (user_id) DO UPDATE SET not_before = EXCLUDED.not_before, reason = EXCLUDED.reason`,
          [loser.id],
        );
        mergedUsers += 1;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  return { runId, groups, mergedUsers, skippedAlreadyMerged };
}
