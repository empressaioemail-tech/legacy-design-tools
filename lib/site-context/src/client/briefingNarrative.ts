/** Minimal narrative shape for briefing progress gating (Spec 51 A–G). */
export interface BriefingNarrativeSections {
  sectionA?: string | null;
  sectionB?: string | null;
  sectionC?: string | null;
  sectionD?: string | null;
  sectionE?: string | null;
  sectionF?: string | null;
  sectionG?: string | null;
}

const SECTION_KEYS: (keyof BriefingNarrativeSections)[] = [
  "sectionA",
  "sectionB",
  "sectionC",
  "sectionD",
  "sectionE",
  "sectionF",
  "sectionG",
];

/** True when at least one A–G section body is present (mock or live). */
export function hasBriefingNarrativeContent(
  narrative: BriefingNarrativeSections | null | undefined,
): boolean {
  if (!narrative) return false;
  return SECTION_KEYS.some((key) => {
    const value = narrative[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}
