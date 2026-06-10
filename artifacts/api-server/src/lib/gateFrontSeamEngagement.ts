/**
 * Engagement-scoped tenant checks for gate-front engine routes.
 */

import type { Request } from "express";
import { db, engagements, submissions, findings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveJurisdictionTenant } from "./atomAdjudicationEvidenceLedger";
import { assertServiceTenantScope } from "./gateFrontSeam";

type TenantScopeFailure = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
};

type TenantScopeOk = {
  ok: true;
  jurisdictionTenant: string | null;
};

export async function loadEngagementTenantFields(
  engagementId: string,
): Promise<
  | ({ found: true } & Parameters<typeof resolveJurisdictionTenant>[0])
  | { found: false }
> {
  const [row] = await db
    .select({
      cortexJurisdictionKey: engagements.cortexJurisdictionKey,
      jurisdictionCity: engagements.jurisdictionCity,
      jurisdictionState: engagements.jurisdictionState,
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
    })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!row) return { found: false };
  return { found: true, ...row };
}

export async function assertEngagementServiceTenantScope(
  req: Request,
  engagementId: string,
): Promise<TenantScopeOk | TenantScopeFailure> {
  const eng = await loadEngagementTenantFields(engagementId);
  if (!eng.found) {
    return {
      ok: false,
      status: 404,
      body: { error: "engagement_not_found" },
    };
  }
  const jurisdictionTenant = resolveJurisdictionTenant(eng);
  const scope = assertServiceTenantScope(req, jurisdictionTenant);
  if (!scope.ok) {
    return {
      ok: false,
      status: 403,
      body: { error: "tenant_scope_denied" },
    };
  }
  return { ok: true, jurisdictionTenant };
}

export async function assertSubmissionServiceTenantScope(
  req: Request,
  submissionId: string,
): Promise<
  | (TenantScopeOk & { engagementId: string })
  | TenantScopeFailure
> {
  const [sub] = await db
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (!sub) {
    return {
      ok: false,
      status: 404,
      body: { error: "submission_not_found" },
    };
  }
  const scoped = await assertEngagementServiceTenantScope(
    req,
    sub.engagementId,
  );
  if (!scoped.ok) return scoped;
  return { ...scoped, engagementId: sub.engagementId };
}

export async function resolveFindingJurisdictionTenant(
  findingAtomId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      cortexJurisdictionKey: engagements.cortexJurisdictionKey,
      jurisdictionCity: engagements.jurisdictionCity,
      jurisdictionState: engagements.jurisdictionState,
      jurisdiction: engagements.jurisdiction,
      address: engagements.address,
    })
    .from(findings)
    .innerJoin(submissions, eq(submissions.id, findings.submissionId))
    .innerJoin(engagements, eq(engagements.id, submissions.engagementId))
    .where(eq(findings.atomId, findingAtomId))
    .limit(1);
  if (!row) return null;
  return resolveJurisdictionTenant(row);
}
