/**
 * Cockpit IA deep-link builders for Playwright specs.
 * Canonical routing uses `?view=` + optional `?segment=` (see engagementViews.ts).
 */

export type CockpitEngagementSegment =
  | "property-intel"
  | "submissions"
  | "findings"
  | "snapshots";

const SEGMENT_VIEW: Record<
  Exclude<CockpitEngagementSegment, "snapshots" | "findings">,
  { view: string; segment: string }
> = {
  "property-intel": { view: "site", segment: "property-intel" },
  submissions: { view: "review", segment: "submissions" },
};

const FINDINGS_VIEW = { view: "review" } as const;

export function engagementUrl(
  engagementId: string,
  params?: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        search.set(key, String(value));
      }
    }
  }
  const qs = search.toString();
  return `/engagements/${engagementId}${qs ? `?${qs}` : ""}`;
}

/** Land on a Cockpit segment using canonical `view` / `segment` params. */
export function engagementAtSegment(
  engagementId: string,
  segment: CockpitEngagementSegment,
  extra?: Record<string, string | number | undefined>,
): string {
  if (segment === "snapshots") {
    return engagementUrl(engagementId, extra);
  }
  if (segment === "findings") {
    return engagementUrl(engagementId, { ...FINDINGS_VIEW, ...extra });
  }
  return engagementUrl(engagementId, {
    ...SEGMENT_VIEW[segment],
    ...extra,
  });
}

/** Playwright URL assertions for Cockpit IA after in-place filter chip clicks. */
export const expectReviewSubmissionsUrl = /[?&]view=review(&|$)/;
export const expectReviewSubmissionsSegmentUrl = /[?&]segment=submissions(&|$)/;
export const expectSitePropertyIntelUrl = /[?&]view=site(&|$)/;
export const expectSitePropertyIntelSegmentUrl =
  /[?&]segment=property-intel(&|$)/;
