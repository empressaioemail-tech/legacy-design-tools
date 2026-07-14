/**
 * W1/W4/W5 — warming-and-QA harness scaffold (Calibrated Spine End-state B).
 *
 * W4: Cotality parcel fields come ONLY from place_layer_snapshots — no live call.
 * W5: warming reads tagged synthetic (excluded from query-frequency / M1).
 */

import { eq } from "drizzle-orm";
import { db, placeLayerSnapshots } from "@workspace/db";
import { runAdapters, type AdapterRunOutcome, resolveJurisdiction } from "@workspace/adapters";
import { FEDERAL_ADAPTERS } from "@workspace/adapters/registry";
import { geocodeAddress } from "@workspace/site-context/server";
import { keyFromEngagement } from "@workspace/codes";
import { fetchBrokerageSiteContext } from "./brokerageSiteContext";
import { isMeteredAdapter } from "./brokerageTierGate";

/** Cotality adapter keys that MUST be snapshot-backed during warming. */
export const WARMING_COTALITY_ADAPTER_KEYS = [
  "cotality:parcels",
  "cotality:zoning",
  "cotality:property",
  "cotality:rent-avm",
  "cotality:liens-mortgage-tax",
  "cotality:permits",
  "cotality:propensity",
  "cotality:owner-occupancy",
  "cotality:hoa",
  "cotality:comparables",
  "cotality:climate",
  "cotality:hazards",
  "cotality:replacementcost",
  "cotality:mineral",
  "cotality:utility",
  "cotality:sinkhole",
  "cotality:foundation",
] as const;

/** Free live federal layers allowed during warming (W4). */
export const WARMING_FREE_LIVE_ADAPTER_KEYS = new Set([
  "fema:nfhl-flood-zone",
  "usgs:ned-elevation",
  "epa:ejscreen",
]);

export interface SnapshotCoverageReport {
  placeKey: string;
  requiredCotalityKeys: string[];
  presentKeys: string[];
  missingKeys: string[];
  coverageRate: number;
  canWarm: boolean;
  message: string;
}

export interface WarmingCascadeInput {
  address: string;
  /** W5 — tag as synthetic read (excluded from real query-frequency). */
  synthetic: true;
}

export interface WarmingCascadeResult {
  placeKey: string;
  jurisdictionKey: string | null;
  synthetic: true;
  snapshotCoverage: SnapshotCoverageReport;
  siteContextLayerCount: number;
  federalLiveLayerCount: number;
  reasoningDepositCount: number;
  qaFlags: string[];
  status: "completed" | "blocked" | "partial";
}

export async function verifySnapshotCoverage(
  placeKey: string,
): Promise<SnapshotCoverageReport> {
  const required = [...WARMING_COTALITY_ADAPTER_KEYS];
  const rows = await db
    .select({ adapterKey: placeLayerSnapshots.adapterKey })
    .from(placeLayerSnapshots)
    .where(eq(placeLayerSnapshots.placeKey, placeKey));

  const present = new Set(rows.map((r) => r.adapterKey));
  const presentKeys = required.filter((k) => present.has(k));
  const missingKeys = required.filter((k) => !present.has(k));
  const coverageRate =
    required.length === 0 ? 1 : presentKeys.length / required.length;

  const canWarm = present.has("cotality:parcels");
  const message = canWarm
    ? missingKeys.length === 0
      ? "Full Cotality snapshot coverage"
      : `Partial snapshot coverage (${presentKeys.length}/${required.length}); parcel spine present`
    : "BLOCKED: no cotality:parcels snapshot — warming cannot proceed (W4)";

  return {
    placeKey,
    requiredCotalityKeys: required,
    presentKeys,
    missingKeys,
    coverageRate,
    canWarm,
    message,
  };
}

async function runFreeFederalLiveLayers(args: {
  latitude: number;
  longitude: number;
  address?: string;
  city?: string | null;
  state?: string | null;
}): Promise<AdapterRunOutcome[]> {
  const adapters = FEDERAL_ADAPTERS.filter((a) =>
    WARMING_FREE_LIVE_ADAPTER_KEYS.has(a.adapterKey),
  );
  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: args.city,
    jurisdictionState: args.state,
    address: args.address,
  });
  return runAdapters({
    adapters,
    context: {
      parcel: {
        latitude: args.latitude,
        longitude: args.longitude,
        address: args.address ?? null,
        city: args.city ?? null,
        state: args.state ?? null,
      },
      jurisdiction,
    },
  });
}

/**
 * W1 cascade scaffold — geocode → jurisdiction → snapshot-only site-context
 * → free federal live → QA flags. Does not call live Cotality.
 */
export async function runWarmingCascade(
  input: WarmingCascadeInput,
): Promise<WarmingCascadeResult> {
  const qaFlags: string[] = [];
  if (!input.synthetic) {
    qaFlags.push("non-synthetic-read-rejected");
  }

  const geo = await geocodeAddress(input.address);
  if (!geo) {
    return {
      placeKey: "",
      jurisdictionKey: null,
      synthetic: true,
      snapshotCoverage: {
        placeKey: "",
        requiredCotalityKeys: [...WARMING_COTALITY_ADAPTER_KEYS],
        presentKeys: [],
        missingKeys: [...WARMING_COTALITY_ADAPTER_KEYS],
        coverageRate: 0,
        canWarm: false,
        message: "Geocode failed: no match",
      },
      siteContextLayerCount: 0,
      federalLiveLayerCount: 0,
      reasoningDepositCount: 0,
      qaFlags: [...qaFlags, "geocode-failed"],
      status: "blocked",
    };
  }

  const placeKey = `coord:${geo.latitude.toFixed(4)},${geo.longitude.toFixed(4)}`;
  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: geo.jurisdictionCity ?? null,
    jurisdictionState: geo.jurisdictionState ?? null,
    jurisdiction: null,
    address: input.address,
  });

  const snapshotCoverage = await verifySnapshotCoverage(placeKey);
  if (!snapshotCoverage.canWarm) {
    return {
      placeKey,
      jurisdictionKey,
      synthetic: true,
      snapshotCoverage,
      siteContextLayerCount: 0,
      federalLiveLayerCount: 0,
      reasoningDepositCount: 0,
      qaFlags: [...qaFlags, "snapshot-coverage-blocked"],
      status: "blocked",
    };
  }

  // Snapshot-only site context — snapshotsOnly skips live Cotality upstream
  const siteContext = await fetchBrokerageSiteContext({
    latitude: geo.latitude,
    longitude: geo.longitude,
    address: input.address,
    jurisdictionCity: geo.jurisdictionCity ?? null,
    jurisdictionState: geo.jurisdictionState ?? null,
    packageTier: "max",
    brokerageAuthTier: "operator",
    snapshotsOnly: true,
  });

  for (const layer of siteContext.layers) {
    if (
      isMeteredAdapter(layer.adapterKey) &&
      !layer.fromArchive &&
      layer.status === "ok"
    ) {
      qaFlags.push(`live-cotality-leak:${layer.adapterKey}`);
    }
  }

  const federalOutcomes = await runFreeFederalLiveLayers({
    latitude: geo.latitude,
    longitude: geo.longitude,
    address: input.address,
    city: geo.jurisdictionCity ?? null,
    state: geo.jurisdictionState ?? null,
  });
  const federalOk = federalOutcomes.filter((o) => o.status === "ok").length;

  if (snapshotCoverage.missingKeys.length > 0) {
    qaFlags.push(`snapshot-partial:${snapshotCoverage.missingKeys.join(",")}`);
  }

  return {
    placeKey,
    jurisdictionKey,
    synthetic: true,
    snapshotCoverage,
    siteContextLayerCount: siteContext.layers.length,
    federalLiveLayerCount: federalOk,
    reasoningDepositCount: 0,
    qaFlags,
    status: qaFlags.some((f) => f.startsWith("live-cotality-leak"))
      ? "partial"
      : "completed",
  };
}

/** K1 — landing schema for public-record outcome rows (acquisition agent). */
export const K1_OUTCOME_LANDING_SCHEMA = {
  schemaVersion: "k1-outcome-v1",
  requiredFields: [
    "outcomeId",
    "sourceEventType",
    "subjectKey",
    "jurisdictionTenant",
    "parcelKey",
    "outcomeRecordedAt",
    "outcomeKind",
    "outcomeStatus",
    "sourceProvenance",
    "sourceVintage",
    "editionInEffect",
    "citedAtomIds",
    "rawCounts",
  ],
  fieldDefinitions: {
    outcomeId: "Stable uuid for the outcome row",
    sourceEventType: "k1.public-record.outcome",
    subjectKey: "Permit/inspection/case id from AHJ public record",
    jurisdictionTenant: "Normalized jurisdiction key (e.g. bastrop_tx)",
    parcelKey: "placeKey or assessor parcel id",
    outcomeRecordedAt: "ISO-8601 when AHJ recorded the outcome",
    outcomeKind: "permit | inspection | variance | incident | appeal",
    outcomeStatus:
      "approved-clean | approved-with-variance | denied | withdrawn | unknown",
    sourceProvenance: "portal-url | bulk-download | public-records-request",
    sourceVintage: "ISO-8601 when the record was acquired",
    editionInEffect: "Code edition label in effect at outcomeRecordedAt",
    citedAtomIds: "Code-section atom ids the prediction cited",
    rawCounts: "{ successCount, trialCount } at finest grain — never derived confidence",
    modelAttribution: "Optional — omitted for pure public-record rows",
    adjudicator: "Optional — omitted unless human adjudication joined",
  },
  appendTarget: "atom_events",
  entityType: "k1-outcome",
  notes:
    "K2 retrodiction consumes these rows once edition/amendment ingest lands (engine). Do not persist derived calibration numbers.",
} as const;

export type K1OutcomeLandingSchema = typeof K1_OUTCOME_LANDING_SCHEMA;
