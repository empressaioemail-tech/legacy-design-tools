/**
 * P-85 — PE Records Request engagement bridge.
 *
 * Smart Site callers supply parcelNodeId; cortex jobs remain engagement-scoped.
 * This helper find-or-creates a PE-owned engagement with a briefing_source row
 * carrying parcel polygon geometry so `resolveParcelInput` succeeds.
 */

import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  briefingSources,
  engagements as engagementsTable,
  parcelBriefings,
  peSavedProperties,
} from "@workspace/db";
import { P85_CLERK_PORTALS } from "./p85ClerkPortalRegistry";
import { countyFipsFromParcelNodeId } from "./verdictLayerServe";
import { queryTxgioParcelByPropId } from "./txgioParcelStore";
import {
  extractParcelGeometryFromPayload,
  type GeoJsonGeometry,
} from "./siteTopographyGeometry";
import { resolveParcelInput } from "./siteTopographyIngest";
import { isValidParcelNodeId } from "../routes/brokerageNodeFacets";

export const PE_RECORDS_ENGAGEMENT_PREFIX = "pe-records:";
/** Layer kind seeded on the briefing; listed in siteTopographyIngest parcel resolver. */
export const PE_RECORDS_PARCEL_LAYER_KIND = "pe-records-parcel";

export type EnsurePeRecordsEngagementResult =
  | {
      ok: true;
      engagementId: string;
      created: boolean;
      geometrySeeded: boolean;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export type FindPeRecordsEngagementResult =
  | { ok: true; engagementId: string }
  | { ok: false };

function engagementNameForParcel(parcelNodeId: string): string {
  return `${PE_RECORDS_ENGAGEMENT_PREFIX}${parcelNodeId}`;
}

function propIdFromParcelNodeId(parcelNodeId: string): string | null {
  const idx = parcelNodeId.indexOf(":");
  if (idx <= 0) return null;
  const propId = parcelNodeId.slice(idx + 1).trim();
  return propId || null;
}

function countyNameForFips(countyFips: string): string {
  const hit = P85_CLERK_PORTALS.find((p) => p.countyFips === countyFips);
  return hit?.countyName ?? `County ${countyFips}`;
}

function parcelFeaturePayload(
  parcelNodeId: string,
  geometry: GeoJsonGeometry,
  propId: string,
): Record<string, unknown> {
  return {
    kind: "parcel",
    parcel: {
      type: "Feature",
      geometry,
      properties: {
        parcel_node_id: parcelNodeId,
        apn: propId,
        source: "pe-records-bridge",
      },
    },
  };
}

async function loadSavedPropertyEngagementId(
  tenantId: string,
  ownerUserId: string,
  parcelNodeId: string,
): Promise<string | null> {
  const rows = await db
    .select({ snapshot: peSavedProperties.snapshot })
    .from(peSavedProperties)
    .where(
      and(
        eq(peSavedProperties.tenantId, tenantId),
        eq(peSavedProperties.ownerUserId, ownerUserId),
        eq(peSavedProperties.parcelNodeId, parcelNodeId),
      ),
    )
    .limit(1);
  const snapshot = rows[0]?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const engagementId = (snapshot as Record<string, unknown>).engagementId;
  return typeof engagementId === "string" && engagementId.trim()
    ? engagementId.trim()
    : null;
}

async function engagementOwnedByUser(
  engagementId: string,
  tenantId: string,
  ownerUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.id, engagementId),
        eq(engagementsTable.tenantId, tenantId),
        eq(engagementsTable.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function resolveParcelGeometryFromStore(
  parcelNodeId: string,
  countyFips: string,
): Promise<GeoJsonGeometry | null> {
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) return null;

  const txgio = await queryTxgioParcelByPropId({
    countyFips,
    countyName: countyNameForFips(countyFips),
    propId,
  });
  const feature = txgio?.geojson.features[0];
  if (!feature || typeof feature !== "object") return null;
  const geometry = (feature as { geometry?: unknown }).geometry;
  if (
    !geometry ||
    typeof geometry !== "object" ||
    !("type" in geometry) ||
    !("coordinates" in geometry)
  ) {
    return null;
  }
  const g = geometry as GeoJsonGeometry;
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") return null;
  return g;
}

async function seedBriefingParcelGeometry(
  engagementId: string,
  parcelNodeId: string,
  geometry: GeoJsonGeometry,
): Promise<boolean> {
  const propId = propIdFromParcelNodeId(parcelNodeId);
  if (!propId) return false;

  const payload = parcelFeaturePayload(parcelNodeId, geometry, propId);
  if (!extractParcelGeometryFromPayload(payload)) return false;

  await db.transaction(async (tx) => {
    const [briefing] = await tx
      .insert(parcelBriefings)
      .values({ engagementId })
      .onConflictDoUpdate({
        target: parcelBriefings.engagementId,
        set: { updatedAt: new Date() },
      })
      .returning({ id: parcelBriefings.id });

    const priorRows = await tx
      .select({ id: briefingSources.id })
      .from(briefingSources)
      .where(
        and(
          eq(briefingSources.briefingId, briefing.id),
          eq(briefingSources.layerKind, PE_RECORDS_PARCEL_LAYER_KIND),
          isNull(briefingSources.supersededAt),
        ),
      )
      .limit(1);
    const priorId = priorRows[0]?.id ?? null;
    const supersededAt = new Date();
    if (priorId) {
      await tx
        .update(briefingSources)
        .set({ supersededAt })
        .where(eq(briefingSources.id, priorId));
    }

    const [newSource] = await tx
      .insert(briefingSources)
      .values({
        briefingId: briefing.id,
        layerKind: PE_RECORDS_PARCEL_LAYER_KIND,
        sourceKind: "local-adapter",
        provider: "PE Records Request bridge (TxGIO parcel store)",
        snapshotDate: new Date(),
        payload,
      })
      .returning({ id: briefingSources.id });

    if (priorId && newSource?.id) {
      await tx
        .update(briefingSources)
        .set({ supersededById: newSource.id })
        .where(eq(briefingSources.id, priorId));
    }
  });

  const parcel = await resolveParcelInput(engagementId);
  return parcel?.geometry != null;
}

async function ensureEngagementHasGeometry(
  engagementId: string,
  parcelNodeId: string,
  countyFips: string,
): Promise<boolean> {
  const existing = await resolveParcelInput(engagementId);
  if (existing?.geometry) return true;

  const geometry = await resolveParcelGeometryFromStore(parcelNodeId, countyFips);
  if (!geometry) return false;

  return seedBriefingParcelGeometry(engagementId, parcelNodeId, geometry);
}

export async function findPeRecordsEngagement(
  userId: string,
  tenantId: string,
  parcelNodeId: string,
): Promise<FindPeRecordsEngagementResult> {
  const nameLower = engagementNameForParcel(parcelNodeId).toLowerCase();
  const rows = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.ownerUserId, userId),
        eq(engagementsTable.tenantId, tenantId),
        eq(engagementsTable.nameLower, nameLower),
      ),
    )
    .limit(1);
  const hit = rows[0];
  return hit ? { ok: true, engagementId: hit.id } : { ok: false };
}

/**
 * Find-or-create a PE-scoped engagement with briefing parcel geometry.
 * Fail-closed when geometry cannot be resolved (no sentinel defaults).
 */
export async function ensurePeRecordsEngagement(
  userId: string,
  tenantId: string,
  parcelNodeId: string,
  parcelKey: string,
  countyFips: string,
): Promise<EnsurePeRecordsEngagementResult> {
  const trimmedNode = parcelNodeId.trim();
  if (!isValidParcelNodeId(trimmedNode)) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_parcel_node_id" },
    };
  }

  const fips = countyFips.trim();
  if (!/^\d{5}$/.test(fips)) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_county_fips" },
    };
  }

  const nodeFips = countyFipsFromParcelNodeId(trimmedNode);
  if (nodeFips && nodeFips !== fips) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "parcel_node_county_mismatch",
        parcelNodeId: trimmedNode,
        countyFips: fips,
        nodeCountyFips: nodeFips,
      },
    };
  }

  if (!parcelKey.startsWith("apn:")) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_parcel_key" },
    };
  }

  const savedEngagementId = await loadSavedPropertyEngagementId(
    tenantId,
    userId,
    trimmedNode,
  );
  if (savedEngagementId) {
    const owned = await engagementOwnedByUser(
      savedEngagementId,
      tenantId,
      userId,
    );
    if (owned) {
      const hasGeometry = await ensureEngagementHasGeometry(
        savedEngagementId,
        trimmedNode,
        fips,
      );
      if (hasGeometry) {
        return {
          ok: true,
          engagementId: savedEngagementId,
          created: false,
          geometrySeeded: true,
        };
      }
    }
  }

  const existing = await findPeRecordsEngagement(userId, tenantId, trimmedNode);
  if (existing.ok) {
    const hasGeometry = await ensureEngagementHasGeometry(
      existing.engagementId,
      trimmedNode,
      fips,
    );
    if (!hasGeometry) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "no_parcel_geometry",
          message:
            "No derivable parcel polygon for this parcel; saved-property linkage or TxGIO geometry required",
          blocker:
            "pe_records_geometry_bridge: txgio lookup returned no polygon for this parcelNodeId",
        },
      };
    }
    return {
      ok: true,
      engagementId: existing.engagementId,
      created: false,
      geometrySeeded: false,
    };
  }

  const geometry = await resolveParcelGeometryFromStore(trimmedNode, fips);
  if (!geometry) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "no_parcel_geometry",
        message:
          "No derivable parcel polygon for this parcel; cannot start Records Request without geometry",
        blocker:
          "pe_records_geometry_bridge: txgio store has no polygon for this parcelNodeId in county",
      },
    };
  }

  const name = engagementNameForParcel(trimmedNode);
  const [created] = await db
    .insert(engagementsTable)
    .values({
      name,
      nameLower: name.toLowerCase(),
      address: trimmedNode,
      status: "active",
      ownerUserId: userId,
      tenantId,
      geocodeSource: "pe-records-bridge",
    })
    .returning({ id: engagementsTable.id });

  if (!created?.id) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "internal_error",
        message: "Failed to create PE records engagement",
      },
    };
  }

  const seeded = await seedBriefingParcelGeometry(
    created.id,
    trimmedNode,
    geometry,
  );
  if (!seeded) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "no_parcel_geometry",
        message: "Briefing geometry seed failed after engagement create",
      },
    };
  }

  return {
    ok: true,
    engagementId: created.id,
    created: true,
    geometrySeeded: true,
  };
}
