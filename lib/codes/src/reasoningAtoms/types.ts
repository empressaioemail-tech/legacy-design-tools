/**
 * v2 reasoning-atom types — Hauska stores reasoning + deeplinks, NOT verbatim code text.
 */

export const REASONING_ATOM_PREFIX = "reasoning:";

/** Max chars persisted in reasoning_atoms.snippet (no full-section field exists). */
export const REASONING_SNIPPET_MAX_CHARS = 600;

export const REASONING_VERIFICATION_STATES = [
  "verified",
  "unverified-web-source",
] as const;
export type ReasoningVerificationState =
  (typeof REASONING_VERIFICATION_STATES)[number];

export const REASONING_DISPLAY_MODES = ["deeplink", "licensed"] as const;
export type ReasoningDisplayMode = (typeof REASONING_DISPLAY_MODES)[number];

export interface ReasoningSourceLink {
  url: string;
  sourceName: string;
  edition: string;
  retrievedAt: string;
  verified: boolean;
}

export interface ReasoningAtomRecord {
  id: string;
  jurisdictionKey: string;
  codeRef: string;
  edition: string;
  editionSlug: string;
  sources: ReasoningSourceLink[];
  reasoning: string | null;
  assertedConfidence: number;
  verificationState: ReasoningVerificationState;
  snippet: string | null;
  displayMode: ReasoningDisplayMode;
  calibratedConfidence: number | null;
  sourceSetVersion: number;
  calibrationStale: boolean;
  accessPolicy: string;
  createdAt: Date;
  updatedAt: Date;
}
