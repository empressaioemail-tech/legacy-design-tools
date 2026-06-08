/**
 * Review-scoped code references to web-fetch when the corpus does not cover them.
 * Jurisdiction-agnostic shape; Miami Beach / Miami-Dade targets are the first consumer.
 */

import type { WebCodeReviewTarget } from "./types";

/** Operator-cited sections for 404 Remodel_B whole-discipline review. */
export const MIAMI_WHOLE_REVIEW_WEB_TARGETS: ReadonlyArray<WebCodeReviewTarget> = [
  {
    codeRef: "FBC-M601.6",
    edition: "FBC 2023",
    editionSlug: "fbc-2023",
    label: "FBC Mechanical M601.6 — duct insulation / return air",
    drivers: ["icc", "upcodes", "florida"],
  },
  {
    codeRef: "FBC-M Ch.4",
    edition: "FBC 2023",
    editionSlug: "fbc-2023",
    label: "FBC Mechanical Ch.4 — ventilation / balanced return",
    drivers: ["icc", "upcodes"],
  },
  {
    codeRef: "FBCB 1405.4",
    edition: "FBC 2023",
    editionSlug: "fbc-2023",
    label: "FBC Building 1405.4 — exterior wall / NOA BORA wind",
    drivers: ["icc", "upcodes", "florida"],
  },
  {
    codeRef: "FBCEB 601.2",
    edition: "FBC Existing Building 2023",
    editionSlug: "fbceb-2023",
    label: "FBCEB 601.2 — existing building valuation ($60/SF)",
    drivers: ["icc", "florida"],
  },
  {
    codeRef: "NEC Art. 220",
    edition: "NEC 2017",
    editionSlug: "nec-2017",
    label: "NEC Art. 220 — branch-circuit load calculations",
    drivers: ["nfpa", "upcodes"],
  },
  {
    codeRef: "NEC Art. 408",
    edition: "NEC 2017",
    editionSlug: "nec-2017",
    label: "NEC Art. 408 — panelboards and schedules",
    drivers: ["nfpa", "upcodes"],
  },
];

const JURISDICTION_WEB_TARGETS: Record<string, ReadonlyArray<WebCodeReviewTarget>> = {
  miami_beach_fl: MIAMI_WHOLE_REVIEW_WEB_TARGETS,
  miami_dade_fl: MIAMI_WHOLE_REVIEW_WEB_TARGETS,
};

export function reviewWebTargetsForJurisdiction(
  jurisdictionKey: string | null | undefined,
): ReadonlyArray<WebCodeReviewTarget> {
  if (!jurisdictionKey) return [];
  return JURISDICTION_WEB_TARGETS[jurisdictionKey] ?? [];
}
