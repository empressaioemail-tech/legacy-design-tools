/**
 * Pure R1 brief composition from baked facets + live atom reads.
 * Kept DB-free so route tests can exercise refusal wiring without a store.
 *
 * Every section carries a `disposition` (P-91 v2, triage D2/D3): present is
 * a determination, refused is a producer refusal about the parcel, absent is
 * no determination and no refusal (data null, an empty record, a typed
 * absence that is not promoted, or an atom that is not there), unread is a
 * producer that has not run for this parcel. The stub depth projects these
 * into the rail vocabulary through `smartSiteStub.railStateFromSectionDisposition`;
 * the predicates below are the one derivation both depths share.
 */

import type {
  FloodHazardFactPresent,
  FloodHazardFactRead,
} from "./floodHazardFactRead";
import type {
  ParcelRecordFloodRead,
  ParcelRecordFloodValue,
  ParcelRecordFloodAbsentVerified,
} from "./parcelRecordFactRead";
import type { EnvelopeBriefRefusal } from "./envelopeBriefRefusal";
import { envelopeAgentGuidance } from "./envelopeBriefRefusal";

type JsonRecord = Record<string, unknown>;

export type R1BriefSectionDisposition =
  | "present"
  | "absent"
  | "refused"
  | "unread";

export type R1BriefSectionId =
  | "zoning"
  | "setbacks-envelope"
  | "flood"
  | "land-use"
  | "drainage";

export type R1BriefSection = {
  id: R1BriefSectionId;
  title: string;
  data: unknown;
  refusal?: unknown;
  citations: string[];
  /** ISO instant for when this section's determination was evaluated or baked. */
  asOf: string | null;
  disposition: R1BriefSectionDisposition;
  /** Present with `unread`: why the producer has not run for this parcel. */
  reason?: string;
  /** Present when the section carries a determination but no http citation URL. */
  citationsDegraded?: boolean;
  /** Flood-only: clarifies Zone X + outside-SFHA misreads. Withheld while citationsDegraded (F2). */
  zoneExposureSummary?: string | null;
  /** Setbacks-envelope-only: MCP guard when data is refused. */
  agentGuidance?: string | null;
};

/** Why the drainage section is unread until the facet exists (F7). */
export const DRAINAGE_UNREAD_REASON =
  "drainage facet not produced for this parcel";

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function urlsFrom(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (candidate: unknown, key?: string): void => {
    if (typeof candidate === "string") {
      if (
        key &&
        /(?:citation|source).*url|url.*(?:citation|source)/i.test(key) &&
        /^https?:\/\//i.test(candidate)
      ) {
        urls.add(candidate);
      }
      if (
        key &&
        (key === "sourceCitation" ||
          key === "citationUrl" ||
          key === "sourceUrl") &&
        /^https?:\/\//i.test(candidate)
      ) {
        urls.add(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, key));
      return;
    }
    const record = asRecord(candidate);
    if (record) {
      Object.entries(record).forEach(([nestedKey, nestedValue]) =>
        visit(nestedValue, nestedKey),
      );
    }
  };
  visit(value);
  return [...urls];
}

function asOfFrom(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["evaluatedAt", "asOf", "vintage", "bakedAt", "snapshotAt"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  const provenance = asRecord(record.provenance);
  if (provenance && typeof provenance.vintage === "string" && provenance.vintage.trim()) {
    return provenance.vintage;
  }
  return null;
}

function verbatimValues(value: unknown, keys: ReadonlySet<string>): string[] {
  const values = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      if (keys.has(key) && typeof nested === "string" && nested.trim()) {
        values.add(nested);
      }
      visit(nested);
    }
  };
  visit(value);
  return [...values];
}

function envelopeHasProductData(envelope: unknown): boolean {
  const record = asRecord(envelope);
  if (!record) return false;
  if (asRecord(record.geojson)) return true;
  if (record.status === "ok" || record.status === "no-buildable-area") {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Disposition predicates: the one derivation node and stub share.     */
/* ------------------------------------------------------------------ */

/**
 * A zoning determination is a district. The Tier-1 bake writes
 * `{ district, jurisdictionKey?, provenance? } | null`; a record without a
 * district (an empty record, a note) is not a determination.
 */
export function zoningDisposition(zoning: unknown): "present" | "absent" {
  if (nonEmptyString(zoning)) return "present";
  const record = asRecord(zoning);
  if (!record) return "absent";
  return ["district", "zone", "code", "zoningCode"].some((key) =>
    nonEmptyString(record[key]),
  )
    ? "present"
    : "absent";
}

/**
 * A land-use determination is a code. The Tier-1 bake writes
 * `{ code, description, source, vintage } | null`; the land-use-fact atom
 * shape carries `landUseCode`. Description, source and vintage without a
 * code are not a determination.
 */
export function landUseDisposition(landUse: unknown): "present" | "absent" {
  if (nonEmptyString(landUse)) return "present";
  const record = asRecord(landUse);
  if (!record) return "absent";
  return ["code", "landUseCode"].some((key) => nonEmptyString(record[key]))
    ? "present"
    : "absent";
}

/** Envelope: product data is present; a typed refusal is refused; else absent. */
export function envelopeDisposition(
  envelope: unknown,
  refusal?: { state?: string } | null,
): "present" | "refused" | "absent" {
  if (envelopeHasProductData(envelope)) return "present";
  if (refusal?.state === "refused") return "refused";
  return "absent";
}

/**
 * Disposition of a live fact read (flood today). A typed absence is not
 * promoted at section level (WDLL item 5: absent-verified needs a positive
 * typed result the section vocabulary does not carry), and an atom that is
 * not there is absent, not a refusal about the parcel. Every other refusal
 * code is a producer refusal.
 */
export function factReadDisposition(
  read: { state: "present" | "absent" | "refused"; code?: string } | null | undefined,
): R1BriefSectionDisposition {
  if (!read) return "absent";
  if (read.state === "present") return "present";
  if (read.state === "absent") return "absent";
  return read.code === "atom-miss" ? "absent" : "refused";
}

/**
 * Drainage facet in the bake (`facets.drainage`), defined here ahead of the
 * data lane: a record with `state: "refused"` is refused; `state: "absent"`
 * is absent; any other non-empty record (or `state: "present"`) is present;
 * null or an empty record is unread because the producer has not run.
 */
export function drainageDisposition(
  drainage: unknown,
): R1BriefSectionDisposition {
  const record = asRecord(drainage);
  if (!record) return "unread";
  if (record.state === "refused") return "refused";
  if (record.state === "absent") return "absent";
  return Object.keys(record).length > 0 ? "present" : "unread";
}

/** Exported for unit tests. Zone X + inSFHA:false is often misread as minimal risk. */
export function summarizeFloodZoneExposure(
  fact: FloodHazardFactPresent,
): string | null {
  const zoneRaw = fact.floodZone?.trim() ?? "";
  const zone = zoneRaw.toUpperCase();
  const subty = fact.zoneSubtype?.toUpperCase() ?? "";

  if (!zoneRaw) {
    return (
      "Parcel does not intersect a mapped FEMA flood zone (treat as Zone X by omission). " +
      "That is a mapped negative, not a FEMA 'no risk' certificate."
    );
  }

  if (fact.inSpecialFloodHazardArea) {
    const bfe =
      typeof fact.baseFloodElevation === "number"
        ? ` Base flood elevation ${fact.baseFloodElevation} ft.`
        : "";
    return (
      `Mapped FEMA flood zone ${fact.floodZone} is in a Special Flood Hazard Area ` +
      `(1% annual-chance floodplain).${bfe}`
    );
  }

  if (zone === "X" || zone.startsWith("X")) {
    if (subty.includes("0.2 PCT") || subty.includes("0.2%")) {
      return (
        `Mapped Zone ${fact.floodZone} with 0.2% annual-chance flood hazard` +
        (fact.zoneSubtype ? ` (${fact.zoneSubtype})` : "") +
        ". Outside the SFHA but not minimal risk. Shaded Zone X still carries flood exposure."
      );
    }
    if (fact.zoneSubtype) {
      return (
        `Mapped Zone ${fact.floodZone} outside the SFHA (${fact.zoneSubtype}). ` +
        "Zone X is not automatically minimal risk. Read the zone subtype."
      );
    }
    return (
      "Mapped Zone X outside the SFHA. Zone X with inSpecialFloodHazardArea: false is " +
      "often misread as minimal risk; confirm unshaded Zone X versus 0.2% annual-chance " +
      "shaded X. Zone subtype was not recorded on this atom."
    );
  }

  return (
    `Mapped FEMA flood zone ${fact.floodZone} is outside the Special Flood Hazard Area` +
    (fact.zoneSubtype ? ` (${fact.zoneSubtype})` : "") +
    "."
  );
}

/**
 * Exported for unit tests. Parcel-record's flood companion carries a real
 * floodway boolean (unlike the atoms path, which only string-matches
 * "FLOODWAY" out of a free-text zone label -- see parcelRecordFactRead.ts's
 * own header comment) and no zoneSubtype field, so this is a distinct
 * function from summarizeFloodZoneExposure, not a reuse: the input shapes
 * genuinely differ, not just the source.
 */
export function summarizeParcelRecordFloodZoneExposure(
  fact: ParcelRecordFloodValue,
): string | null {
  const zoneRaw = fact.floodZone?.trim() ?? "";
  if (!zoneRaw) {
    return (
      "Parcel does not intersect a mapped FEMA flood zone (treat as Zone X by omission). " +
      "That is a mapped negative, not a FEMA 'no risk' certificate."
    );
  }
  const bfe =
    typeof fact.baseFloodElevation === "number"
      ? ` Base flood elevation ${fact.baseFloodElevation} ft.`
      : "";
  if (fact.floodway) {
    return (
      `Mapped FEMA flood zone ${zoneRaw} is within the regulatory floodway.${bfe} ` +
      "The floodway carries the most restrictive federal and local development standards."
    );
  }
  const zone = zoneRaw.toUpperCase();
  const inSpecialFloodHazardArea = zone !== "X" && !zone.startsWith("X");
  if (inSpecialFloodHazardArea) {
    return (
      `Mapped FEMA flood zone ${zoneRaw} is in a Special Flood Hazard Area ` +
      `(1% annual-chance floodplain).${bfe}`
    );
  }
  return (
    `Mapped Zone ${zoneRaw} outside the Special Flood Hazard Area. ` +
    "Zone X is not automatically minimal risk."
  );
}

/**
 * Parcel-record is the preferred flood source when it has earned a
 * determination (value or absent-verified) -- the reconciled point-on-surface
 * rule the old atoms/bake path does not have (parcelRecordFactRead.ts).
 * "unaccounted" (nothing has looked yet) and "refused" fall through to the
 * existing atoms-based path in composeFloodBriefSection, never silently
 * treated as an absence.
 */
function composeFloodBriefSectionFromParcelRecord(
  fact: ParcelRecordFloodValue | ParcelRecordFloodAbsentVerified,
): BriefSectionParts {
  if (fact.state === "value") {
    const posture = withCitationPosture({
      data: fact,
      // parcel_record's flood companion carries provenance (method, source
      // vintage) rather than a clickable URL; urlsFrom only recognizes real
      // http(s) URLs, so this is honestly empty, not a citation we chose to
      // drop. F2's own rule (withhold the quotable prose until a citation
      // exists behind it) is respected as written: the structured zone/
      // floodway/BFE values still ship in `data` either way; only the
      // narrative sentence is conditionally withheld.
      citations: [],
      asOf: fact.sourceVintage,
      disposition: "present",
    });
    return {
      ...posture,
      zoneExposureSummary: posture.citationsDegraded
        ? null
        : summarizeParcelRecordFloodZoneExposure(fact),
    };
  }
  // absent-verified: a real determination (the sweep looked, found nothing),
  // never promoted past "absent" at section level -- same rule
  // factReadDisposition already applies to floodHazardFactRead's own typed
  // absence (WDLL item 5, this file's existing comment on factReadDisposition).
  return {
    data: fact,
    citations: [],
    asOf: null,
    disposition: "absent",
    zoneExposureSummary: null,
  };
}

type BriefSectionParts = Pick<
  R1BriefSection,
  | "data"
  | "refusal"
  | "citations"
  | "asOf"
  | "disposition"
  | "reason"
  | "citationsDegraded"
  | "zoneExposureSummary"
  | "agentGuidance"
>;

function withCitationPosture(
  parts: Pick<BriefSectionParts, "data" | "citations" | "asOf" | "disposition">,
): BriefSectionParts {
  return {
    ...parts,
    citationsDegraded:
      parts.disposition === "present" && parts.citations.length === 0,
  };
}

function composeFloodBriefSection(
  tier2: unknown,
  floodHazardFact?: FloodHazardFactRead,
  parcelRecordFloodFact?: ParcelRecordFloodRead,
): BriefSectionParts {
  if (
    parcelRecordFloodFact &&
    (parcelRecordFloodFact.state === "value" ||
      parcelRecordFloodFact.state === "absent-verified")
  ) {
    return composeFloodBriefSectionFromParcelRecord(parcelRecordFloodFact);
  }
  if (floodHazardFact) {
    if (floodHazardFact.state === "present") {
      const posture = withCitationPosture({
        data: floodHazardFact,
        citations: urlsFrom(floodHazardFact),
        asOf: floodHazardFact.evaluatedAt,
        disposition: "present",
      });
      // F2 (triage D5): the prose is the most quotable sentence in the brief
      // and is withheld until the citation behind it exists.
      return {
        ...posture,
        zoneExposureSummary: posture.citationsDegraded
          ? null
          : summarizeFloodZoneExposure(floodHazardFact),
      };
    }
    if (floodHazardFact.state === "absent") {
      return {
        data: floodHazardFact,
        citations: urlsFrom(floodHazardFact),
        asOf: asOfFrom(floodHazardFact),
        disposition: factReadDisposition(floodHazardFact),
        zoneExposureSummary: null,
      };
    }
    const disposition = factReadDisposition(floodHazardFact);
    if (floodHazardFact.code === "atom-miss") {
      const bakedRefusal = asRecord(tier2)?.floodDisposition ?? null;
      if (bakedRefusal) {
        return {
          data: null,
          refusal: bakedRefusal,
          citations: urlsFrom(bakedRefusal),
          asOf: asOfFrom(bakedRefusal),
          disposition,
        };
      }
    }
    return {
      data: null,
      refusal: floodHazardFact,
      citations: [],
      asOf: null,
      disposition,
    };
  }
  const refusal = asRecord(tier2)?.floodDisposition ?? null;
  return {
    data: null,
    refusal,
    citations: urlsFrom(refusal),
    asOf: asOfFrom(refusal),
    disposition: refusal != null ? "refused" : "absent",
  };
}

function composeSetbacksEnvelopeBriefSection(
  envelope: unknown,
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null,
  bakedAt?: string | null,
): BriefSectionParts {
  const disposition = envelopeDisposition(envelope, envelopeBriefRefusal);
  if (disposition === "present") {
    return withCitationPosture({
      data: envelope,
      citations: urlsFrom(envelope),
      asOf: asOfFrom(envelope) ?? bakedAt ?? null,
      disposition,
    });
  }
  if (disposition === "refused" && envelopeBriefRefusal) {
    return {
      data: null,
      refusal: envelopeBriefRefusal,
      citations: [],
      asOf: bakedAt ?? null,
      disposition,
      agentGuidance: envelopeAgentGuidance(envelopeBriefRefusal),
    };
  }
  return withCitationPosture({
    data: envelope ?? null,
    citations: urlsFrom(envelope),
    asOf: asOfFrom(envelope) ?? bakedAt ?? null,
    disposition: "absent",
  });
}

function composeDrainageBriefSection(
  drainage: unknown,
  bakedAt: string | null,
): BriefSectionParts {
  const disposition = drainageDisposition(drainage);
  if (disposition === "unread") {
    return {
      data: null,
      citations: [],
      asOf: bakedAt,
      disposition,
      reason: DRAINAGE_UNREAD_REASON,
    };
  }
  if (disposition === "refused") {
    return {
      data: null,
      refusal: drainage,
      citations: urlsFrom(drainage),
      asOf: asOfFrom(drainage) ?? bakedAt,
      disposition,
    };
  }
  return withCitationPosture({
    data: drainage,
    citations: urlsFrom(drainage),
    asOf: asOfFrom(drainage) ?? bakedAt,
    disposition,
  });
}

function sectionFromParts(
  id: R1BriefSectionId,
  title: string,
  parts: BriefSectionParts,
): R1BriefSection {
  return {
    id,
    title,
    data: parts.data,
    ...(parts.refusal != null ? { refusal: parts.refusal } : {}),
    citations: parts.citations,
    asOf: parts.asOf,
    disposition: parts.disposition,
    ...(parts.reason != null ? { reason: parts.reason } : {}),
    ...(parts.citationsDegraded ? { citationsDegraded: true } : {}),
    ...(parts.zoneExposureSummary != null
      ? { zoneExposureSummary: parts.zoneExposureSummary }
      : {}),
    ...(parts.agentGuidance != null
      ? { agentGuidance: parts.agentGuidance }
      : {}),
  };
}

export function buildR1Brief(
  facets: unknown,
  tier2: unknown,
  options?: {
    floodHazardFact?: FloodHazardFactRead;
    parcelRecordFloodFact?: ParcelRecordFloodRead;
    envelopeBriefRefusal?: EnvelopeBriefRefusal | null;
  },
): {
  sections: R1BriefSection[];
  disclosure: string[];
  citations: string[];
} {
  const root = asRecord(facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  const envelope = root.envelope ?? null;
  const bakedAt =
    typeof root.bakedAt === "string" && root.bakedAt.trim()
      ? root.bakedAt
      : null;
  const zoningSection = withCitationPosture({
    data: root.zoning ?? null,
    citations: urlsFrom(root.zoning),
    asOf: asOfFrom(root.zoning) ?? bakedAt,
    disposition: zoningDisposition(root.zoning),
  });
  const envelopeSection = composeSetbacksEnvelopeBriefSection(
    envelope,
    options?.envelopeBriefRefusal,
    bakedAt,
  );
  const floodSection = composeFloodBriefSection(
    tier2,
    options?.floodHazardFact,
    options?.parcelRecordFloodFact,
  );
  const landUseSection = withCitationPosture({
    data: baseFacts.landUse ?? null,
    citations: urlsFrom(baseFacts.landUse),
    asOf: asOfFrom(baseFacts.landUse) ?? bakedAt,
    disposition: landUseDisposition(baseFacts.landUse),
  });
  const drainageSection = composeDrainageBriefSection(
    root.drainage ?? null,
    bakedAt,
  );
  const sections: R1BriefSection[] = [
    sectionFromParts("zoning", "Zoning", zoningSection),
    sectionFromParts(
      "setbacks-envelope",
      "Setbacks and buildable envelope",
      envelopeSection,
    ),
    sectionFromParts("flood", "Flood", floodSection),
    sectionFromParts("land-use", "Land use", landUseSection),
    sectionFromParts("drainage", "Drainage", drainageSection),
  ];
  const disclosures = verbatimValues(
    { facets, tier2 },
    new Set(["districtNote", "disclosure", "emptyReason"]),
  );
  return {
    sections,
    disclosure: disclosures,
    citations: [...new Set(sections.flatMap((section) => section.citations))],
  };
}
