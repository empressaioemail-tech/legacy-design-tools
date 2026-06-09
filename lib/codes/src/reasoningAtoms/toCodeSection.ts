import type { WebCodeSectionInput } from "../webCodeFetch/index";
import type { ReasoningAtomRecord } from "./types";

/** Map a persisted reasoning atom to engine CodeSectionInput (deeplink citation UX). */
export function reasoningAtomToCodeSection(
  atom: ReasoningAtomRecord,
  label?: string,
): WebCodeSectionInput {
  const primary = atom.sources[0];
  const verified = atom.verificationState === "verified";
  return {
    atomId: atom.id,
    label:
      label ??
      `${atom.codeRef} [${verified ? "verified" : "unverified"} web ${atom.edition}]`,
    snippet: atom.snippet
      ? atom.snippet
      : atom.reasoning ?? undefined,
    webProvenance: {
      sourceUrl: primary?.url ?? "",
      sources: atom.sources,
      retrievedAt: primary?.retrievedAt ?? atom.updatedAt.toISOString(),
      edition: atom.edition,
      verified,
      confidence: atom.assertedConfidence,
      sourceName: primary?.sourceName ?? "reasoning-atom",
      verificationState: atom.verificationState,
      displayMode: atom.displayMode,
      ...(verified ? {} : { unverifiedWebSource: true }),
    },
  };
}
