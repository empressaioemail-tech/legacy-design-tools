/**
 * P-85 WDLL item 14 — clerk_portal_terms canary status (raw pg, worker-local).
 */

import pg from "pg";

const { Pool } = pg;

export type PortalCanaryStatus = "ok" | "lookup-failed";

export interface PortalCanaryRow {
  portalId: string;
  canaryStatus: PortalCanaryStatus | null;
  canaryCheckedAt: Date | null;
  canaryFailureReason: string | null;
  canaryRecipeVersion: string | null;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL must be set");
  }
  return url;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  }
  return pool;
}

/** Test seam — closes the shared pool. */
export async function closePortalCanaryStorePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function loadPortalCanaryStatus(
  portalId: string,
): Promise<PortalCanaryRow | null> {
  const result = await getPool().query<{
    portalId: string;
    canaryStatus: PortalCanaryStatus | null;
    canaryCheckedAt: Date | null;
    canaryFailureReason: string | null;
    canaryRecipeVersion: string | null;
  }>(
    `SELECT
      portal_id AS "portalId",
      canary_status AS "canaryStatus",
      canary_checked_at AS "canaryCheckedAt",
      canary_failure_reason AS "canaryFailureReason",
      canary_recipe_version AS "canaryRecipeVersion"
    FROM clerk_portal_terms
    WHERE portal_id = $1
    LIMIT 1`,
    [portalId],
  );
  return result.rows[0] ?? null;
}

export function portalCanaryBlocksRun(row: PortalCanaryRow | null): boolean {
  return row?.canaryStatus === "lookup-failed";
}

export async function markPortalCanaryResult(input: {
  portalId: string;
  ok: boolean;
  recipeVersion: string;
  reason?: string;
}): Promise<void> {
  const status: PortalCanaryStatus = input.ok ? "ok" : "lookup-failed";
  const result = await getPool().query(
    `UPDATE clerk_portal_terms
     SET
       canary_status = $2,
       canary_checked_at = NOW(),
       canary_failure_reason = $3,
       canary_recipe_version = $4,
       updated_at = NOW()
     WHERE portal_id = $1`,
    [
      input.portalId,
      status,
      input.ok ? null : (input.reason ?? "canary failed"),
      input.recipeVersion,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `clerk_portal_terms ${input.portalId}: expected one row to update canary status`,
    );
  }
}
