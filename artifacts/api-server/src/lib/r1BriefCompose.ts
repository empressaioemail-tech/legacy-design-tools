/**
 * Pure R1 brief composition from baked facets + live atom reads.
 * Kept DB-free so route tests can exercise refusal wiring without a store.
 */

import type {
  FloodHazardFactPresent,
  FloodHazardFactRead,
} from "./floodHazardFactRead";
import type { EnvelopeBriefRefusal } from "./envelopeBriefRefusal";
import { envelopeAgentGuidance } from "./envelopeBriefRefusal";

type JsonRecord = Record<string, unknown>;

export type R1BriefSection = {
  id: "zoning" | "setbacks-envelope" | "flood" | "land-use";
  title: string;
  data: unknown;
  refusal?: unknown;
  citations: string[];
  /** ISO instant for when this section's determination was evaluated or baked. */
  asOf: string | null;
  /** Present when the section carries a determination but no http citation URL. */
  citationsDegraded?: boolean;
  /** Flood-only: clarifies Zone X + outside-SFHA misreads. */
  zoneExposureSummary?: string | null;
  /** Setbacks-envelope-only: MCP guard when data is refused. */
  agentGuidance?: string | null;
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
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

/** Exported for unit tests — Zone X + inSFHA:false is often misread as minimal risk. */
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
        ". Outside the SFHA but not minimal risk — shaded Zone X still carries flood exposure."
      );
    }
    if (fact.zoneSubtype) {
      return (
        `Mapped Zone ${fact.floodZone} outside the SFHA (${fact.zoneSubtype}). ` +
        "Zone X is not automatically minimal risk — read the zone subtype."
      );
    }
    return (
      "Mapped Zone X outside the SFHA. Zone X with inSpecialFloodHazardArea: false is " +
      "often misread as minimal risk; confirm unshaded Zone X versus 0.2% annual-chance " +
      "shaded X — zone subtype was not recorded on this atom."
    );
  }

  return (
    `Mapped FEMA flood zone ${fact.floodZone} is outside the Special Flood Hazard Area` +
    (fact.zoneSubtype ? ` (${fact.zoneSubtype})` : "") +
    "."
  );
}

type BriefSectionParts = Pick<
  R1BriefSection,
  | "data"
  | "refusal"
  | "citations"
  | "asOf"
  | "citationsDegraded"
  | "zoneExposureSummary"
  | "agentGuidance"
>;

function withCitationPosture(
  parts: Pick<BriefSectionParts, "data" | "refusal" | "citations" | "asOf" | "zoneExposureSummary">,
): BriefSectionParts {
  const hasDetermination =
    parts.data !== null &&
    parts.data !== undefined &&
    parts.refusal == null;
  return {
    ...parts,
    citationsDegraded: hasDetermination && parts.citations.length === 0,
  };
}

function composeFloodBriefSection(
  tier2: unknown,
  floodHazardFact?: FloodHazardFactRead,
): BriefSectionParts {
  if (floodHazardFact) {
    if (floodHazardFact.state === "present") {
      const citations = urlsFrom(floodHazardFact);
      return withCitationPosture({
        data: floodHazardFact,
        citations,
        asOf: floodHazardFact.evaluatedAt,
        zoneExposureSummary: summarizeFloodZoneExposure(floodHazardFact),
      });
    }
    if (floodHazardFact.state === "absent") {
      const citations = urlsFrom(floodHazardFact);
      return withCitationPosture({
        data: floodHazardFact,
        citations,
        asOf: asOfFrom(floodHazardFact),
        zoneExposureSummary: null,
      });
    }
    if (
      floodHazardFact.state === "refused" &&
      floodHazardFact.code === "atom-miss"
    ) {
      const bakedRefusal = asRecord(tier2)?.floodDisposition ?? null;
      if (bakedRefusal) {
        return {
          data: null,
          refusal: bakedRefusal,
          citations: urlsFrom(bakedRefusal),
          asOf: asOfFrom(bakedRefusal),
        };
      }
    }
    return {
      data: null,
      refusal: floodHazardFact,
      citations: [],
      asOf: null,
    };
  }
  const refusal = asRecord(tier2)?.floodDisposition ?? null;
  return {
    data: null,
    refusal,
    citations: urlsFrom(refusal),
    asOf: asOfFrom(refusal),
  };
}

function composeSetbacksEnvelopeBriefSection(
  envelope: unknown,
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null,
  bakedAt?: string | null,
): BriefSectionParts {
  if (envelopeHasProductData(envelope)) {
    return withCitationPosture({
      data: envelope,
      citations: urlsFrom(envelope),
      asOf: asOfFrom(envelope) ?? bakedAt ?? null,
    });
  }
  if (envelopeBriefRefusal) {
    return {
      data: null,
      refusal: envelopeBriefRefusal,
      citations: [],
      asOf: bakedAt ?? null,
      agentGuidance: envelopeAgentGuidance(envelopeBriefRefusal),
    };
  }
  return withCitationPosture({
    data: envelope ?? null,
    citations: urlsFrom(envelope),
    asOf: asOfFrom(envelope) ?? bakedAt ?? null,
  });
}

export function buildR1Brief(
  facets: unknown,
  tier2: unknown,
  options?: {
    floodHazardFact?: FloodHazardFactRead;
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
  const floodSection = composeFloodBriefSection(
    tier2,
    options?.floodHazardFact,
  );
  const envelopeSection = composeSetbacksEnvelopeBriefSection(
    envelope,
    options?.envelopeBriefRefusal,
    bakedAt,
  );
  const sections: R1BriefSection[] = [
    {
      id: "zoning",
      title: "Zoning",
      data: root.zoning ?? null,
      citations: urlsFrom(root.zoning),
      asOf: asOfFrom(root.zoning) ?? bakedAt,
      ...(urlsFrom(root.zoning).length === 0 && root.zoning != null
        ? { citationsDegraded: true }
        : {}),
    },
    {
      id: "setbacks-envelope",
      title: "Setbacks and buildable envelope",
      data: envelopeSection.data,
      ...(envelopeSection.refusal != null
        ? { refusal: envelopeSection.refusal }
        : {}),
      citations: envelopeSection.citations,
      asOf: envelopeSection.asOf,
      ...(envelopeSection.citationsDegraded ? { citationsDegraded: true } : {}),
      ...(envelopeSection.agentGuidance != null
        ? { agentGuidance: envelopeSection.agentGuidance }
        : {}),
    },
    {
      id: "flood",
      title: "Flood",
      data: floodSection.data,
      ...(floodSection.refusal != null ? { refusal: floodSection.refusal } : {}),
      citations: floodSection.citations,
      asOf: floodSection.asOf,
      ...(floodSection.citationsDegraded ? { citationsDegraded: true } : {}),
      ...(floodSection.zoneExposureSummary != null
        ? { zoneExposureSummary: floodSection.zoneExposureSummary }
        : {}),
    },
    {
      id: "land-use",
      title: "Land use",
      data: baseFacts.landUse ?? null,
      citations: urlsFrom(baseFacts.landUse),
      asOf: asOfFrom(baseFacts.landUse) ?? bakedAt,
      ...(urlsFrom(baseFacts.landUse).length === 0 && baseFacts.landUse != null
        ? { citationsDegraded: true }
        : {}),
    },
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
