/**
 * Cotality investor-radar depth adapters — permits, propensity, rent AVM,
 * liens/mortgage/tax (incl. TX MUD/PID scan), owner-occupancy, sinkhole.
 *
 * Wired on the Property Brief `/brief` path via brokerageSiteContextAdapters().
 * Reasoning layers consume summaries — never raw Cotality field dumps.
 */

import { AdapterRunError, type Adapter, type AdapterContext, type AdapterResult } from "../types";
import {
  COTALITY_PROVIDER_LABEL,
  COTALITY_TIMEOUT_MS,
  cotalityAdapterMeta,
  cotalityAppliesGeocoded,
  cotalityGetWithApp,
  providerLabel,
  resolveCotalityClip,
  snapshotDateFromJson,
} from "./cotalityClient";

const COTALITY_AVM_MODEL =
  process.env.COTALITY_AVM_MODEL ?? "thvConsumers";

function isCotalityEmptyRecordSet(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.records)) return row.records.length === 0;
    if (Array.isArray(row.items)) return row.items.length === 0;
    if (row.count === 0) return true;
  }
  return false;
}

async function clipFor(ctx: AdapterContext, adapterKey: string) {
  return resolveCotalityClip({
    latitude: ctx.parcel.latitude,
    longitude: ctx.parcel.longitude,
    address: ctx.parcel.address ?? null,
    city: ctx.parcel.city ?? null,
    state: ctx.parcel.state ?? null,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
    adapterKeyForLog: adapterKey,
  });
}

function pickRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Scan tax/assessment payloads for TX MUD/PID special-district line items. */
export function extractMudPidAssessmentFlags(
  taxJson: unknown,
  assessmentJson: unknown,
): {
  mudPidDetected: boolean;
  specialDistrictLabels: string[];
  assessmentNotes: string[];
} {
  const specialDistrictLabels: string[] = [];
  const assessmentNotes: string[] = [];
  const mudPidRe =
    /\b(MUD|PID|PUD|special\s+district|municipal\s+utility\s+district|public\s+improvement\s+district)\b/i;

  const scan = (node: unknown, depth = 0): void => {
    if (depth > 6 || node == null) return;
    if (typeof node === "string") {
      if (mudPidRe.test(node)) {
        assessmentNotes.push(node.slice(0, 240));
        const match = node.match(mudPidRe);
        if (match?.[0]) specialDistrictLabels.push(match[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) scan(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (mudPidRe.test(k)) specialDistrictLabels.push(k);
        scan(v, depth + 1);
      }
    }
  };

  scan(taxJson);
  scan(assessmentJson);

  const unique = [...new Set(specialDistrictLabels.map((s) => s.toUpperCase()))];
  return {
    mudPidDetected: unique.length > 0 || assessmentNotes.length > 0,
    specialDistrictLabels: unique,
    assessmentNotes: assessmentNotes.slice(0, 8),
  };
}

export const cotalityRentAvmAdapter: Adapter = {
  adapterKey: "cotality:rent-avm",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-rent-avm",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const rentAvm = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/avms/ram`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-rent-avm",
    }).catch(() => null);

    if (!rentAvm) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality rent AVM (RAM) returned no data for this parcel.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(rentAvm),
      payload: {
        kind: "cotality-rent-avm",
        clip,
        rentAvm,
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityLiensMortgageTaxAdapter: Adapter = {
  adapterKey: "cotality:liens-mortgage-tax",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-liens-mortgage-tax",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const [taxLatest, mortgage, liens] = await Promise.all([
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/tax-assessments/latest`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-tax-latest",
      }).catch(() => null),
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/mortgage/current`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-mortgage-current",
      }).catch(() => null),
      cotalityGetWithApp({
        app: "property",
        path: `/${clip}/liens`,
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        adapterKeyForLog: this.adapterKey,
        label: "property-liens",
      }).catch(() => null),
    ]);

    if (!taxLatest && !mortgage && !liens) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality tax/mortgage/liens endpoints returned no data for this parcel.",
      );
    }

    const liensEmpty = isCotalityEmptyRecordSet(liens);
    const jurisdiction =
      ctx.jurisdiction.localKey ??
      ctx.jurisdiction.stateKey ??
      clipCtx.county ??
      "unknown";
    const checkEnd = new Date().toISOString().slice(0, 10);
    const verifiedAbsence = liensEmpty
      ? {
          absenceDomain: "lien" as const,
          whatWasChecked: "Cotality property-liens index",
          checkScope: {
            jurisdiction,
            record_type: "property-lien",
            date_range_start: "2000-01-01",
            date_range_end: checkEnd,
          },
          checkMethod: "api_query" as const,
        }
      : undefined;

    const mudPid = extractMudPidAssessmentFlags(taxLatest, taxLatest);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(taxLatest ?? mortgage ?? liens),
      payload: {
        kind: "cotality-liens-mortgage-tax",
        clip,
        taxAssessment: taxLatest,
        mortgageCurrent: mortgage,
        liens,
        mudPidAssessment: mudPid,
        mudPidNote: mudPid.mudPidDetected
          ? "Special-district (MUD/PID) assessment line items detected — verify annual bond/assessment cash flow."
          : "No MUD/PID special-district assessment flags found in Cotality tax payload (absence is not proof).",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
      verifiedAbsence,
    };
  },
};

export const cotalityPermitsAdapter: Adapter = {
  adapterKey: "cotality:permits",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-permits",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const permits = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/building-permits`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-building-permits",
    }).catch(() => null);

    if (!permits) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality building-permits returned no data for this parcel.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(permits),
      payload: {
        kind: "cotality-permits",
        clip,
        buildingPermits: permits,
        depthRole: "underwriting-on-viewed-property",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityPropensityAdapter: Adapter = {
  adapterKey: "cotality:propensity",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-propensity",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const scores = await Promise.all(
      (["sale", "purchase", "refinance"] as const).map(async (kind) => {
        try {
          const json = await cotalityGetWithApp({
            app: "property",
            path: `/${clip}/propensity-scores/${clip}/${kind}-score`,
            fetchImpl: ctx.fetchImpl,
            signal: ctx.signal,
            adapterKeyForLog: this.adapterKey,
            label: `property-propensity-${kind}`,
          });
          return [kind, json] as const;
        } catch {
          return [kind, null] as const;
        }
      }),
    );

    const populated = Object.fromEntries(scores.filter(([, v]) => v != null));
    if (Object.keys(populated).length === 0) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality propensity scores returned no data for this parcel.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "cotality-propensity",
        clip,
        propensityScores: populated,
        depthRole: "underwriting-on-viewed-property",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityOwnerOccupancyAdapter: Adapter = {
  adapterKey: "cotality:owner-occupancy",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-owner-occupancy",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const ownership = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/ownership`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-ownership",
    }).catch(() => null);

    if (!ownership) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality ownership returned no data for owner-occupancy depth.",
      );
    }

    const rec = pickRecord(ownership);
    const ownerOccupied =
      rec.ownerOccupied ??
      rec.ownerOccupancyIndicator ??
      rec.occupancyStatus ??
      null;

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(ownership),
      payload: {
        kind: "cotality-owner-occupancy",
        clip,
        ownership,
        ownerOccupiedIndicator: ownerOccupied,
        depthRole: "underwriting-on-viewed-property",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityHoaAdapter: Adapter = {
  adapterKey: "cotality:hoa",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-hoa",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const hoa = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/home-owners-association`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-hoa",
    }).catch(() => null);

    if (!hoa) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality HOA returned no data.",
      );
    }

    const rec = pickRecord(hoa);
    const hoaName = rec.hoaName ?? rec.associationName ?? rec.name ?? null;
    const hoaFee = rec.hoaFee ?? rec.fee ?? rec.dues ?? null;
    const hasHoaOnRecord = Boolean(hoaName || hoaFee);

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(hoa),
      payload: {
        kind: "cotality-hoa",
        clip,
        hoa,
        hoaName,
        hoaFee,
        hasHoaOnRecord,
        noHoaOnRecord: !hasHoaOnRecord,
        depthRole: "underwriting-on-viewed-property",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalityCompsAdapter: Adapter = {
  adapterKey: "cotality:comparables",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-comparables",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const clip = clipCtx.clip;

    const comps = await cotalityGetWithApp({
      app: "property",
      path: `/${clip}/comparables`,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "property-comparables",
    }).catch(() => null);

    if (!comps) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality comparables returned no data.",
      );
    }

    const rec = pickRecord(comps);
    const list = [rec.comparables, rec.items, rec.results, rec.data].find(
      Array.isArray,
    ) as unknown[] | undefined;

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: snapshotDateFromJson(comps),
      payload: {
        kind: "cotality-comparables",
        clip,
        comparables: comps,
        comparableCount: Array.isArray(list) ? list.length : 0,
        depthRole: "underwriting-on-viewed-property",
        ...cotalityAdapterMeta(this.adapterKey, "property"),
      },
    };
  },
};

export const cotalitySinkholeAdapter: Adapter = {
  adapterKey: "cotality:sinkhole",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-sinkhole",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const query = {
      clip: clipCtx.clip,
      lat: ctx.parcel.latitude,
      lon: ctx.parcel.longitude,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? undefined,
    };

    const sinkhole = await cotalityGetWithApp({
      app: "riskmeter",
      path: "/sinkhole-integrated",
      query,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "riskmeter-sinkhole",
    }).catch(() => null);

    if (!sinkhole) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality RiskMeter sinkhole-integrated returned no karst/sinkhole data.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "cotality-sinkhole",
        clip: clipCtx.clip,
        sinkholeIntegrated: sinkhole,
        ...cotalityAdapterMeta(this.adapterKey, "riskmeter"),
      },
    };
  },
};

export const cotalityFoundationTypeAdapter: Adapter = {
  adapterKey: "cotality:foundation",
  tier: "federal",
  sourceKind: "national-aggregator",
  layerKind: "cotality-foundation",
  provider: COTALITY_PROVIDER_LABEL,
  jurisdictionGate: {},
  timeoutMs: COTALITY_TIMEOUT_MS,
  appliesTo: cotalityAppliesGeocoded,
  async run(ctx): Promise<AdapterResult> {
    const clipCtx = await clipFor(ctx, this.adapterKey);
    const query = {
      clip: clipCtx.clip,
      lat: ctx.parcel.latitude,
      lon: ctx.parcel.longitude,
      latitude: ctx.parcel.latitude,
      longitude: ctx.parcel.longitude,
      address: ctx.parcel.address ?? undefined,
    };

    const foundation = await cotalityGetWithApp({
      app: "riskmeter",
      path: "/comprehensive-foundation-type",
      query,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      adapterKeyForLog: this.adapterKey,
      label: "riskmeter-foundation-type",
    }).catch(() => null);

    if (!foundation) {
      throw new AdapterRunError(
        "no-coverage",
        "Cotality RiskMeter foundation-type returned no data.",
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: providerLabel(clipCtx.county),
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "cotality-foundation",
        clip: clipCtx.clip,
        foundationType: foundation,
        ...cotalityAdapterMeta(this.adapterKey, "riskmeter"),
      },
    };
  },
};

/** Investor-radar depth adapters (excludes parcel/zoning + extended pack duplicates). */
export const COTALITY_INVESTOR_DEPTH_ADAPTERS = [
  cotalityRentAvmAdapter,
  cotalityLiensMortgageTaxAdapter,
  cotalityPermitsAdapter,
  cotalityPropensityAdapter,
  cotalityOwnerOccupancyAdapter,
  cotalityHoaAdapter,
  cotalityCompsAdapter,
  cotalitySinkholeAdapter,
  cotalityFoundationTypeAdapter,
] as const;
