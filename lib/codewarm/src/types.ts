/**
 * Cold-warm batch harness types — engine-core cargo (no UI/session/auth).
 */

export const CODEWARM_GROUNDING_FLAGS = [
  "web-groundable",
  "verify-existing-corpus",
  "NFPA-license-required",
] as const;

export type CodewarmGroundingFlag = (typeof CODEWARM_GROUNDING_FLAGS)[number];

export interface CodewarmManifestSection {
  code?: string;
  section: string;
  title: string;
  discipline?: string;
  traffic?: string;
  verify?: boolean;
  grounding?: CodewarmGroundingFlag;
}

export interface CodewarmManifestEntry {
  codeRef: string;
  code: string;
  edition: string;
  title: string;
  discipline?: string;
  traffic?: string;
  verify?: boolean;
  grounding: CodewarmGroundingFlag;
}

export interface CodewarmBatchOptions {
  jurisdictionKey: string;
  manifestPath: string;
  dryRun?: boolean;
  budgetCapUsd?: number;
  costPerFetchUsd?: number;
  http?: import("@workspace/codes").HttpFetcher;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export type CodewarmReferenceOutcome =
  | "warmed"
  | "corpus-covered"
  | "corpus-skipped"
  | "deeplink-only"
  | "dry-run"
  | "budget-halted"
  | "error";

export interface CodewarmReferenceResult {
  codeRef: string;
  edition: string;
  outcome: CodewarmReferenceOutcome;
  atomId?: string;
  verificationState?: string;
  assertedConfidence?: number;
  error?: string;
}

export interface CodewarmCostRecord {
  batchId: string;
  manifestPath: string;
  jurisdictionKey: string;
  fetchCount: number;
  estimatedCostUsd: number;
  budgetCapUsd: number | null;
  haltedByBudget: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface CodewarmBatchResult {
  batchId: string;
  manifestPath: string;
  jurisdictionKey: string;
  dryRun: boolean;
  corpusCoveredCount: number;
  corpusSkippedCount: number;
  warmedCount: number;
  deeplinkOnlyCount: number;
  errorCount: number;
  results: CodewarmReferenceResult[];
  costRecord: CodewarmCostRecord;
}
