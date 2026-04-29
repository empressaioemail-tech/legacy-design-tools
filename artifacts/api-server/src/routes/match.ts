/**
 * POST /api/engagements/match — A04.7 engagement-identity resolver.
 *
 * Called by the Revit add-in BEFORE uploading a snapshot, to decide which
 * engagement (if any) the file belongs to. Returns one of three actions:
 *   - "auto-bind"  : exact match on revitCentralGuid OR revitDocumentPath.
 *   - "choose"     : case-insensitive projectName collision; up to 10
 *                    candidates returned, newest first. Surfaces a dropdown
 *                    in the add-in regardless of GUID presence.
 *   - "create-new" : nothing matched; the add-in should call POST /snapshots
 *                    with `createNewEngagement: true`.
 *
 * Auth: same `x-snapshot-secret` header as POST /snapshots.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, snapshots } from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  MatchEngagementBody,
  MatchEngagementHeader,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { getSnapshotSecret } from "../lib/snapshotSecret";

const snapshotSecret = getSnapshotSecret();

/** Cap chosen for the "choose" response. See A04.7 plan §1, candidate cap. */
const CHOOSE_CANDIDATE_LIMIT = 10;

const router: IRouter = Router();

interface CandidateRow {
  id: string;
  name: string;
  address: string | null;
  jurisdiction: string | null;
  revitCentralGuid: string | null;
  revitDocumentPath: string | null;
  snapshotCount: number;
  updatedAt: string;
}

function toCandidate(
  row: typeof engagements.$inferSelect,
  snapshotCount: number,
): CandidateRow {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    jurisdiction: row.jurisdiction,
    revitCentralGuid: row.revitCentralGuid,
    revitDocumentPath: row.revitDocumentPath,
    snapshotCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Count snapshots per engagement id. Two-query approach (one engagements
 * SELECT, one snapshots COUNT...GROUP BY) instead of a correlated
 * subquery so the SQL stays unqualified and respects the per-test schema's
 * search_path. Bounded by the candidate cap above.
 */
async function snapshotCountsFor(
  engagementIds: string[],
): Promise<Map<string, number>> {
  if (engagementIds.length === 0) return new Map();
  const rows = await db
    .select({
      engagementId: snapshots.engagementId,
      // ::int so pg returns number, not the bigint string COUNT(*) gives.
      count: sql<number>`COUNT(*)::int`,
    })
    .from(snapshots)
    .where(inArray(snapshots.engagementId, engagementIds))
    .groupBy(snapshots.engagementId);
  return new Map(rows.map((r) => [r.engagementId, r.count]));
}

router.post("/engagements/match", async (req: Request, res: Response) => {
  // Auth — identical pattern to POST /snapshots so a single secret rotates.
  const headerParse = MatchEngagementHeader.safeParse({
    "x-snapshot-secret": req.header("x-snapshot-secret"),
  });
  if (
    !headerParse.success ||
    headerParse.data["x-snapshot-secret"] !== snapshotSecret
  ) {
    res.status(401).json({ error: "Invalid snapshot secret" });
    return;
  }

  const bodyParse = MatchEngagementBody.safeParse(req.body);
  if (!bodyParse.success) {
    res.status(400).json({ error: "projectName is required" });
    return;
  }

  const { projectName, revitCentralGuid, revitDocumentPath } = bodyParse.data;
  const nameLower = projectName.trim().toLowerCase();
  const guid = revitCentralGuid?.trim() || null;
  const path = revitDocumentPath?.trim() || null;

  try {
    // 1. GUID exact match → silent auto-bind. The partial unique index
    //    guarantees at most one row matches; the LIMIT 1 is belt-and-
    //    suspenders.
    if (guid) {
      const hit = await db
        .select()
        .from(engagements)
        .where(eq(engagements.revitCentralGuid, guid))
        .limit(1);
      const row = hit[0];
      if (row) {
        logger.info(
          { matchedBy: "revitCentralGuid", engagementId: row.id },
          "match: auto-bind by GUID",
        );
        res.json({
          action: "auto-bind",
          engagementId: row.id,
          engagementName: row.name,
          matchedBy: "revitCentralGuid",
        });
        return;
      }
    }

    // 2. Path exact match → silent auto-bind. Only consulted if no GUID
    //    match (or no GUID supplied). For non-workshared files where GUID
    //    is unavailable.
    if (path) {
      const hit = await db
        .select()
        .from(engagements)
        .where(eq(engagements.revitDocumentPath, path))
        .limit(1);
      const row = hit[0];
      if (row) {
        logger.info(
          { matchedBy: "revitDocumentPath", engagementId: row.id },
          "match: auto-bind by path",
        );
        res.json({
          action: "auto-bind",
          engagementId: row.id,
          engagementName: row.name,
          matchedBy: "revitDocumentPath",
        });
        return;
      }
    }

    // 3. name_lower collision → ALWAYS surface dropdown (locked decision
    //    #2: the dropdown is the user-facing identity, GUID is just the
    //    silent backstop). Cap candidates per A04.7 plan.
    const collisions = await db
      .select()
      .from(engagements)
      .where(eq(engagements.nameLower, nameLower))
      .orderBy(desc(engagements.updatedAt))
      .limit(CHOOSE_CANDIDATE_LIMIT);

    if (collisions.length > 0) {
      const counts = await snapshotCountsFor(collisions.map((c) => c.id));
      logger.info(
        { count: collisions.length, projectName },
        "match: name collision → choose",
      );
      res.json({
        action: "choose",
        candidates: collisions.map((c) => toCandidate(c, counts.get(c.id) ?? 0)),
      });
      return;
    }

    // 4. No match anywhere → caller should send createNewEngagement.
    logger.info(
      { projectName, hasGuid: !!guid, hasPath: !!path },
      "match: no match → create-new",
    );
    res.json({ action: "create-new" });
  } catch (err) {
    logger.error({ err, projectName }, "match: lookup failed");
    res.status(500).json({ error: "Failed to match engagement" });
  }
});

export default router;
