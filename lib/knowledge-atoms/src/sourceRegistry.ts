import type { AccessPolicy } from "@hauska/atom-contract";

/** Registered adapter / data source — only these may emit verified-absence atoms. */
export interface RegisteredKnowledgeSource {
  sourceKey: string;
  displayName: string;
  accessPolicy: AccessPolicy;
  /** Source reliability score in [0, 1] — stamped on emitted atoms. */
  reliabilityScore: number;
  /** Precedence taxonomy rank — higher outranks lower on conflict. */
  trustRank: number;
}

const COTALITY_ACCESS: AccessPolicy = "public-paid";

/**
 * Canonical source registry for knowledge-atom ingest.
 * Unregistered sources never produce verified-absence atoms.
 */
export const KNOWLEDGE_SOURCE_REGISTRY: Readonly<
  Record<string, RegisteredKnowledgeSource>
> = {
  "cotality:liens-mortgage-tax": {
    sourceKey: "cotality:liens-mortgage-tax",
    displayName: "Cotality Property (liens/mortgage/tax)",
    accessPolicy: COTALITY_ACCESS,
    reliabilityScore: 0.92,
    trustRank: 85,
  },
  "cotality:permits": {
    sourceKey: "cotality:permits",
    displayName: "Cotality Property (permits)",
    accessPolicy: COTALITY_ACCESS,
    reliabilityScore: 0.9,
    trustRank: 85,
  },
  "cotality:property": {
    sourceKey: "cotality:property",
    displayName: "Cotality Property (Carfax)",
    accessPolicy: COTALITY_ACCESS,
    reliabilityScore: 0.88,
    trustRank: 85,
  },
  "fema:nfhl": {
    sourceKey: "fema:nfhl",
    displayName: "FEMA NFHL",
    accessPolicy: "public-free",
    reliabilityScore: 0.82,
    trustRank: 60,
  },
  "ugrc:parcels": {
    sourceKey: "ugrc:parcels",
    displayName: "Utah AGRC Parcels",
    accessPolicy: "public-free",
    reliabilityScore: 0.78,
    trustRank: 70,
  },
  "grand-county-ut:parcels": {
    sourceKey: "grand-county-ut:parcels",
    displayName: "Grand County UT Parcels",
    accessPolicy: "public-free",
    reliabilityScore: 0.8,
    trustRank: 75,
  },
  "test:empty-registry": {
    sourceKey: "test:empty-registry",
    displayName: "Test harness empty-record adapter",
    accessPolicy: "platform-internal",
    reliabilityScore: 0.95,
    trustRank: 50,
  },
};

export function lookupRegisteredSource(
  sourceKey: string,
): RegisteredKnowledgeSource | null {
  return KNOWLEDGE_SOURCE_REGISTRY[sourceKey] ?? null;
}

export function isRegisteredKnowledgeSource(sourceKey: string): boolean {
  return sourceKey in KNOWLEDGE_SOURCE_REGISTRY;
}

export function accessPolicyForSource(sourceKey: string): AccessPolicy | null {
  return lookupRegisteredSource(sourceKey)?.accessPolicy ?? null;
}
