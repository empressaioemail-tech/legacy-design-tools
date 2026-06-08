import { REASONING_SNIPPET_MAX_CHARS } from "./types";

/**
 * Cap text for persistence. Full fetched section bodies MUST pass through here
 * before landing in reasoning_atoms.snippet — never store verbatim catalog text.
 */
export function capReasoningSnippet(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= REASONING_SNIPPET_MAX_CHARS) return trimmed;
  return trimmed.slice(0, REASONING_SNIPPET_MAX_CHARS - 1) + "…";
}

/** Build a short reasoning summary from verification outcome (no full section). */
export function reasoningSummaryFromFetch(args: {
  codeRef: string;
  edition: string;
  verified: boolean;
  sourceName: string;
}): string {
  if (args.verified) {
    return `Grounded reference for ${args.codeRef} (${args.edition}) via ${args.sourceName} deeplink — verbatim text read at citation time.`;
  }
  return `Unverified web reference for ${args.codeRef} (${args.edition}) — deeplink only; do not treat as high-confidence grounded text.`;
}
