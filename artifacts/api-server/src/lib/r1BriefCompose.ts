/**
 * Pure R1 brief composition from baked facets + live atom reads.
 * Kept DB-free so route tests can exercise refusal wiring without a store.
 */

import type { FloodHazardFactRead } from "./floodHazardFactRead";
import type { EnvelopeBriefRefusal } from "./envelopeBriefRefusal";

type JsonRecord = Record<string, unknown>;

export type R1BriefSection = {
  id: "zoning" | "setbacks-envelope" | "flood" | "land-use";
  title: string;
  data: unknown;
  refusal?: unknown;
  citations: string[];
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

function composeFloodBriefSection(
  tier2: unknown,
  floodHazardFact?: FloodHazardFactRead,
): Pick<R1BriefSection, "data" | "refusal" | "citations"> {
  if (floodHazardFact) {
    if (
      floodHazardFact.state === "present" ||
      floodHazardFact.state === "absent"
    ) {
      return {
        data: floodHazardFact,
        citations: [],
      };
    }
    if (
      floodHazardFact.state === "refused" &&
      floodHazardFact.code === "atom-miss"
    ) {
      const bakedRefusal = asRecord(tier2)?.floodDisposition ?? null;
      if (bakedRefusal) {
        return { data: null, refusal: bakedRefusal, citations: [] };
      }
    }
    return { data: null, refusal: floodHazardFact, citations: [] };
  }
  return {
    data: null,
    refusal: asRecord(tier2)?.floodDisposition ?? null,
    citations: [],
  };
}

function composeSetbacksEnvelopeBriefSection(
  envelope: unknown,
  envelopeBriefRefusal?: EnvelopeBriefRefusal | null,
): Pick<R1BriefSection, "data" | "refusal" | "citations"> {
  if (envelopeHasProductData(envelope)) {
    return {
      data: envelope,
      citations: urlsFrom(envelope),
    };
  }
  if (envelopeBriefRefusal) {
    return { data: null, refusal: envelopeBriefRefusal, citations: [] };
  }
  return { data: envelope ?? null, citations: urlsFrom(envelope) };
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
  const floodSection = composeFloodBriefSection(
    tier2,
    options?.floodHazardFact,
  );
  const envelopeSection = composeSetbacksEnvelopeBriefSection(
    envelope,
    options?.envelopeBriefRefusal,
  );
  const sections: R1BriefSection[] = [
    {
      id: "zoning",
      title: "Zoning",
      data: root.zoning ?? null,
      citations: urlsFrom(root.zoning),
    },
    {
      id: "setbacks-envelope",
      title: "Setbacks and buildable envelope",
      data: envelopeSection.data,
      ...(envelopeSection.refusal != null
        ? { refusal: envelopeSection.refusal }
        : {}),
      citations: envelopeSection.citations,
    },
    {
      id: "flood",
      title: "Flood",
      data: floodSection.data,
      ...(floodSection.refusal != null ? { refusal: floodSection.refusal } : {}),
      citations: floodSection.citations,
    },
    {
      id: "land-use",
      title: "Land use",
      data: baseFacts.landUse ?? null,
      citations: urlsFrom(baseFacts.landUse),
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
