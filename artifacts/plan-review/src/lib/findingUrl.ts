/**
 * URL deep-link helpers for the AIR-2 Findings tab (Task #310) and
 * the Wave 2 Sprint B / Task #319 modal tabs (BIM Model, Engagement
 * Context).
 *
 * Mirrors the SSR-safe URLSearchParams + allow-list + `replaceState`
 * pattern documented at length in
 * `artifacts/design-tools/src/pages/EngagementDetail.tsx`
 * (`readTabFromUrl` / `writeTabToUrl`, ~L161-L249) so the two
 * artifacts share an identical deep-link convention. The query-param
 * vocabulary used here is:
 *
 *   - `?submission=<submissionId>` opens the submission detail
 *     modal directly to its default Note tab.
 *   - `?submission=<submissionId>&tab=findings|bim-model|engagement-context`
 *     opens the modal to the specified tab.
 *   - `?finding=<atomId>` opens the modal *and* the Findings tab
 *     *and* the drill-in panel for the matching finding. The
 *     submission id is derived from the finding atom id
 *     (`finding:{submissionId}:{ulid}`), so an auditor can paste a
 *     `?finding=…` link without also remembering the submission id.
 *
 * The setters use `history.replaceState` (not `pushState`) so
 * opening / closing the drill-in or switching tabs doesn't pollute
 * the back-button history with one entry per click — same convention
 * design-tools uses for tab and filter state.
 */

// ─── Finding atom-id allow-list ───────────────────────────────────
//
// These two helpers used to live in `./findingsMock.ts` but they are
// pure ID-shape utilities with no backend coupling, so they stay here
// to survive the AIR-1 swap that deletes the mock module. Atom id
// grammar (per AIR-1 recon): `finding:{submissionId}:{ulid}`.

/**
 * Validate a `?finding=<atomId>` URL parameter. We use a permissive
 * ASCII allow-list rather than a strict ULID regex so test/dev
 * fixtures with non-ULID ids still round-trip; the goal is to keep
 * junk and obvious XSS out of the URL, not to validate the atom shape
 * itself (the server / atom-graph does that).
 */
export function isWellFormedFindingId(raw: string): boolean {
  if (!raw) return false;
  if (!raw.startsWith("finding:")) return false;
  if (raw.length > 200) return false;
  return /^finding:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(raw);
}

/**
 * Extract the submission id from a well-formed finding atom id.
 * Returns `null` for malformed ids. Used by the URL deep-link to
 * decide which submission's modal to open when only `?finding=…`
 * is present in the URL.
 */
export function submissionIdFromFindingId(raw: string): string | null {
  if (!isWellFormedFindingId(raw)) return null;
  const parts = raw.split(":");
  if (parts.length < 3) return null;
  return parts[1] ?? null;
}

export const FINDING_QUERY_PARAM = "finding";
export const SUBMISSION_QUERY_PARAM = "submission";
export const SUBMISSION_TAB_QUERY_PARAM = "tab";

export type SubmissionDetailTab =
  | "note"
  | "findings"
  | "bim-model"
  | "engagement-context";

const SUBMISSION_DETAIL_TABS: readonly SubmissionDetailTab[] = [
  "note",
  "findings",
  "bim-model",
  "engagement-context",
];

function isSubmissionDetailTab(v: string | null): v is SubmissionDetailTab {
  return v != null && (SUBMISSION_DETAIL_TABS as readonly string[]).includes(v);
}

/**
 * Read the `?finding=<atomId>` parameter, validated through the
 * shared allow-list. Returns `null` for missing / malformed ids so
 * a hand-edited link can't push the modal into an undefined drill-in
 * state.
 */
export function readFindingFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get(
    FINDING_QUERY_PARAM,
  );
  if (!raw) return null;
  return isWellFormedFindingId(raw) ? raw : null;
}

/**
 * Write the active drill-in finding back to the URL. Passing `null`
 * removes the param so the canonical engagement URL stays clean
 * when no drill-in is open.
 */
export function writeFindingToUrl(next: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === null) {
    url.searchParams.delete(FINDING_QUERY_PARAM);
  } else {
    if (!isWellFormedFindingId(next)) return;
    url.searchParams.set(FINDING_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Read the `?submission=<id>` parameter. The allow-list here is
 * intentionally loose (any ASCII id-shaped string) because the
 * submission id format is server-defined; the goal is to keep
 * obvious junk out, not to impose a specific shape. If the URL
 * carries `?finding=…` instead, the submission id is derived from
 * the finding atom id.
 */
export function readSubmissionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const direct = params.get(SUBMISSION_QUERY_PARAM);
  if (direct && /^[A-Za-z0-9_.:-]{1,128}$/.test(direct)) return direct;
  const findingRaw = params.get(FINDING_QUERY_PARAM);
  if (findingRaw && isWellFormedFindingId(findingRaw)) {
    return submissionIdFromFindingId(findingRaw);
  }
  return null;
}

export function writeSubmissionToUrl(next: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === null) {
    url.searchParams.delete(SUBMISSION_QUERY_PARAM);
    // Closing the modal also clears the dependent params so the URL
    // doesn't carry stale state into the next reload.
    url.searchParams.delete(SUBMISSION_TAB_QUERY_PARAM);
    url.searchParams.delete(FINDING_QUERY_PARAM);
  } else {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(next)) return;
    url.searchParams.set(SUBMISSION_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Read the active submission-detail tab. Defaults to `"note"` so
 * a bare `?submission=<id>` URL still opens to the historical
 * default view — only an explicit `?tab=…` (or a `?finding=…`
 * deep-link, handled at mount-time by the modal) switches off it.
 *
 * Recognized values: `note`, `findings`, `bim-model`,
 * `engagement-context` (the four tabs the merged modal exposes).
 * Anything else falls back to `"note"` so a typo'd or stale link
 * lands on a concrete tab rather than a blank shell.
 */
export function readSubmissionTabFromUrl(): SubmissionDetailTab {
  if (typeof window === "undefined") return "note";
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(SUBMISSION_TAB_QUERY_PARAM);
  if (isSubmissionDetailTab(raw)) return raw;
  // A `?finding=…` deep-link implies the Findings tab even if `tab`
  // wasn't explicitly set — the drill-in lives there.
  if (params.get(FINDING_QUERY_PARAM)) return "findings";
  return "note";
}

export function writeSubmissionTabToUrl(next: SubmissionDetailTab): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "note") {
    // `note` is the canonical default; omitting the param keeps the
    // common-case URL short.
    url.searchParams.delete(SUBMISSION_TAB_QUERY_PARAM);
  } else {
    url.searchParams.set(SUBMISSION_TAB_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}
