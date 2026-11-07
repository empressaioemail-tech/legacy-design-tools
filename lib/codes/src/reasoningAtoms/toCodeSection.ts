import type { WebCodeSectionInput } from "../webCodeFetch/index";
import { isIccSource } from "@workspace/icc-notice";
import type { ReasoningAtomRecord } from "./types";

/** Map a persisted reasoning atom to engine CodeSectionInput (deeplink citation UX). */
export function reasoningAtomToCodeSection(
  atom: ReasoningAtomRecord,
  label?: string,
): WebCodeSectionInput {
  const primary = atom.sources[0];
  const verified = atom.verificationState === "verified";
  // G-309: ICC rows are citation-only. Never carry stored text into a section.
  const icc = atom.sources.some((s) => isIccSource(s));
  return {
    atomId: atom.id,
    label:
      label ??
      `${atom.codeRef} [${verified ? "verified" : "unverified"} web ${atom.edition}]`,
    snippet: icc
      ? undefined
      : atom.snippet
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
