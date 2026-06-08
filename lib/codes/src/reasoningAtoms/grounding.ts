/**
 * Retrieve-first reasoning grounding for resolveEngineInputs.
 *
 * 1. Query persisted reasoning atoms for review targets
 * 2. Web-fetch only gaps
 * 3. UPSERT reasoning atoms (multi-link, capped snippet)
 */

import {
  corpusCoversTarget,
  fetchCodeSection,
  type HttpFetcher,
  type WebCodeSectionInput,
} from "../webCodeFetch/index";
import { reviewWebTargetsForJurisdiction } from "../webCodeFetch/reviewTargets";
import type { WebCodeReviewTarget } from "../webCodeFetch/types";
import { reasoningAtomToCodeSection } from "./toCodeSection";
import {
  retrieveReasoningAtomsForRefs,
  upsertReasoningAtomFromWebFetch,
} from "./persist";
import { REASONING_ATOM_PREFIX } from "./types";

export interface ReasoningGroundingResult {
  sections: WebCodeSectionInput[];
  reasoningRetrievedCount: number;
  webFilledCount: number;
}

export async function supplementCodeSectionsWithReasoningGrounding(args: {
  jurisdictionKey: string;
  existingSections: ReadonlyArray<{ atomId: string; label: string }>;
  http?: HttpFetcher;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<ReasoningGroundingResult> {
  const targets = reviewWebTargetsForJurisdiction(args.jurisdictionKey);
  if (targets.length === 0) {
    return { sections: [], reasoningRetrievedCount: 0, webFilledCount: 0 };
  }

  const corpusLabels = args.existingSections
    .filter((s) => !s.atomId.startsWith(REASONING_ATOM_PREFIX))
    .filter((s) => !s.atomId.startsWith("websearch:"))
    .map((s) => s.label);

  const neededTargets = targets.filter(
    (t) => !corpusCoversTarget(corpusLabels, t),
  );

  const persisted = await retrieveReasoningAtomsForRefs({
    jurisdictionKey: args.jurisdictionKey,
    codeRefs: neededTargets.map((t) => t.codeRef),
  });
  const persistedByRef = new Map(persisted.map((a) => [a.codeRef, a]));

  const sections: WebCodeSectionInput[] = [];
  let reasoningRetrievedCount = 0;
  let webFilledCount = 0;

  for (const target of neededTargets) {
    const existingAtom = persistedByRef.get(target.codeRef);
    if (existingAtom) {
      const mapped = reasoningAtomToCodeSection(existingAtom, target.label);
      sections.push({
        atomId: mapped.atomId,
        label: mapped.label!,
        snippet: mapped.snippet,
        webProvenance: mapped.webProvenance!,
      });
      reasoningRetrievedCount++;
      args.log?.("reasoning atom retrieved (retrieve-first)", {
        codeRef: target.codeRef,
        sourceCount: existingAtom.sources.length,
        atomId: existingAtom.id,
      });
      continue;
    }

    const result = await fetchCodeSection(
      {
        codeRef: target.codeRef,
        edition: target.edition,
        jurisdictionKey: args.jurisdictionKey,
      },
      { http: args.http, target },
    );

    const atom = await upsertReasoningAtomFromWebFetch({
      jurisdictionKey: args.jurisdictionKey,
      target,
      result,
    });

    const mapped = reasoningAtomToCodeSection(atom, target.label);
    sections.push({
      atomId: mapped.atomId,
      label: mapped.label!,
      snippet: mapped.snippet,
      webProvenance: mapped.webProvenance!,
    });
    webFilledCount++;
    args.log?.("reasoning atom web-filled and persisted", {
      codeRef: target.codeRef,
      verified: result.verified,
      sourceUrl: result.sourceUrl,
      sourceCount: atom.sources.length,
    });
  }

  args.log?.("reasoning grounding split", {
    reasoningRetrievedCount,
    webFilledCount,
    totalSections: sections.length,
  });

  return { sections, reasoningRetrievedCount, webFilledCount };
}

/** @deprecated Use supplementCodeSectionsWithReasoningGrounding — thin wrapper for compat. */
export async function supplementCodeSectionsFromWeb(
  args: Parameters<typeof supplementCodeSectionsWithReasoningGrounding>[0],
): Promise<WebCodeSectionInput[]> {
  const result = await supplementCodeSectionsWithReasoningGrounding(args);
  return result.sections;
}
