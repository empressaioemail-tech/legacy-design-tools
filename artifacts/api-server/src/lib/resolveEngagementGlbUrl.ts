/**
 * V1-5 — resolve an engagement's default BIM GLB to a signed object-
 * storage URL for headless capture (Puppeteer).
 *
 * Mirrors the FE priority in `EngagementDetail.defaultBimGlbUrl`:
 * architect-uploaded mesh (`materializable_elements.glbObjectPath`)
 * first, then briefing-source-derived GLB. Element load order matches
 * `toBimModelWire` in `routes/bimModels.ts` (IFC bundle, briefing-
 * derived, as-built entities).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bimModels,
  briefingSources,
  db,
  materializableElements,
} from "@workspace/db";
import { signObjectEntityGetUrl } from "./objectStorage";

export class EngagementGlbResolveError extends Error {
  constructor(
    public readonly code:
      | "no_bim_model"
      | "glb_not_attached"
      | "briefing_source_glb_missing",
    message: string,
  ) {
    super(message);
    this.name = "EngagementGlbResolveError";
  }
}

function normalizeObjectPath(objectPath: string): string {
  return objectPath.startsWith("/objects/")
    ? objectPath
    : `/objects/${objectPath.replace(/^\/+/, "")}`;
}

async function loadElementsForEngagementRender(
  engagementId: string,
  activeBriefingId: string | null,
): Promise<
  Array<{
    glbObjectPath: string | null;
    briefingSourceId: string | null;
  }>
> {
  const briefingElements = activeBriefingId
    ? await db
        .select({
          glbObjectPath: materializableElements.glbObjectPath,
          briefingSourceId: materializableElements.briefingSourceId,
        })
        .from(materializableElements)
        .where(
          and(
            eq(materializableElements.briefingId, activeBriefingId),
            eq(materializableElements.sourceKind, "briefing-derived"),
          ),
        )
    : [];

  const asBuiltRows = await db
    .select({
      glbObjectPath: materializableElements.glbObjectPath,
      briefingSourceId: materializableElements.briefingSourceId,
      sourceKind: materializableElements.sourceKind,
    })
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.engagementId, engagementId),
        isNull(materializableElements.supersededAt),
        inArray(materializableElements.sourceKind, [
          "as-built-ifc-bundle",
          "as-built-ifc",
        ]),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${materializableElements.sourceKind} = 'as-built-ifc-bundle' THEN 0 ELSE 1 END`,
      materializableElements.createdAt,
    );

  const ifcBundle = asBuiltRows.filter((e) => e.sourceKind === "as-built-ifc-bundle");
  const ifcEntities = asBuiltRows.filter((e) => e.sourceKind === "as-built-ifc");
  return [...ifcBundle, ...briefingElements, ...ifcEntities];
}

/**
 * Mint a short-lived signed GET URL for the engagement's primary GLB.
 * Used when kickoff omits `glbUrl` or when normalizing API-relative
 * GLB paths before Puppeteer capture.
 */
export async function resolveEngagementGlbSignedUrl(
  engagementId: string,
): Promise<string> {
  const [bimModel] = await db
    .select({
      id: bimModels.id,
      activeBriefingId: bimModels.activeBriefingId,
    })
    .from(bimModels)
    .where(eq(bimModels.engagementId, engagementId))
    .limit(1);
  if (!bimModel) {
    throw new EngagementGlbResolveError(
      "no_bim_model",
      `no bim model for engagement ${engagementId}`,
    );
  }

  const elements = await loadElementsForEngagementRender(
    engagementId,
    bimModel.activeBriefingId,
  );

  const ownMesh = elements.find(
    (el) => el.glbObjectPath !== null && el.glbObjectPath !== "",
  );
  if (ownMesh?.glbObjectPath) {
    return signObjectEntityGetUrl(
      normalizeObjectPath(ownMesh.glbObjectPath),
      1800,
    );
  }

  const sourceBacked = elements.find(
    (el) => el.briefingSourceId !== null && el.briefingSourceId !== "",
  );
  if (sourceBacked?.briefingSourceId) {
    const [src] = await db
      .select({ glbObjectPath: briefingSources.glbObjectPath })
      .from(briefingSources)
      .where(eq(briefingSources.id, sourceBacked.briefingSourceId))
      .limit(1);
    if (src?.glbObjectPath) {
      return signObjectEntityGetUrl(
        normalizeObjectPath(src.glbObjectPath),
        1800,
      );
    }
    throw new EngagementGlbResolveError(
      "briefing_source_glb_missing",
      `briefing source ${sourceBacked.briefingSourceId} has no glbObjectPath`,
    );
  }

  throw new EngagementGlbResolveError(
    "glb_not_attached",
    `no GLB attached on bim model ${bimModel.id} for engagement ${engagementId}`,
  );
}
