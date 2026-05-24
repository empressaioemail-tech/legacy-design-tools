import {
  FindingCategory,
  FindingSeverity,
} from "@workspace/api-client-react";
import {
  BACKFILL_FILTER_QUERY_PARAM,
  parseBackfillFilter,
  type BackfillFilter,
} from "../../lib/submissionBackfill";

export type TabId =
  | "snapshots"
  | "sheets"
  | "model-3d"
  | "site"
  | "site-context"
  | "submissions"
  | "findings"
  | "response-tasks"
  | "deliverable-letters"
  | "detail-callouts"
  | "product-specs"
  | "renders"
  | "presentations"
  | "publish-prep"
  | "settings";

/**
 * Read the active tab from `?tab=…` on the current URL. Mirrors the
 * URL-state convention DevAtoms.tsx and DevAtomsProbe.tsx already use:
 * `URLSearchParams` over `window.location.search`, with a strict
 * allow-list so a stale or hand-edited link can't push the page into
 * an unknown tab. SSR-safe: returns the default when `window` is
 * undefined.
 *
 * The default is `snapshots` (the page's "home" tab); a missing or
 * unknown `tab` param resolves to that, so a bookmark of the bare
 * engagement URL keeps working.
 */
export function readTabFromUrl(): TabId {
  if (typeof window === "undefined") return "snapshots";
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (
    raw === "snapshots" ||
    raw === "sheets" ||
    raw === "model-3d" ||
    raw === "site" ||
    raw === "site-context" ||
    raw === "submissions" ||
    raw === "findings" ||
    raw === "response-tasks" ||
    raw === "deliverable-letters" ||
    raw === "detail-callouts" ||
    raw === "product-specs" ||
    raw === "renders" ||
    raw === "presentations" ||
    raw === "publish-prep" ||
    raw === "settings"
  ) {
    return raw;
  }
  return "snapshots";
}

/**
 * Write the active tab back to the URL using `replaceState`. Matches
 * the convention DevAtoms.tsx documents at length: tab switches are
 * navigation-cheap (no real route change), so polluting the
 * back-button history with one entry per click is the wrong shape —
 * `replaceState` keeps the URL deep-linkable without making "back"
 * cycle through every tab the user touched.
 *
 * The default tab (`snapshots`) is encoded by *removing* `?tab=…`
 * rather than writing `?tab=snapshots`, so the canonical URL stays
 * the bare engagement URL when the user is on the default view.
 */
export function writeTabToUrl(next: TabId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "snapshots") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Read the backfill filter (Task #124) from the URL. Reuses the
 * same SSR-safe + allow-list pattern as `readTabFromUrl` so a stale
 * or hand-edited link can't push the timeline into an undefined
 * filter state. Defaults to `"all"` when the param is missing.
 */
export function readBackfillFilterFromUrl(): BackfillFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    BACKFILL_FILTER_QUERY_PARAM,
  );
  return parseBackfillFilter(raw);
}

/**
 * Mirror the active backfill filter back into the URL via
 * `replaceState`, matching the tab-state convention above. The
 * default (`"all"`) is encoded by *removing* the param so the
 * canonical engagement URL stays clean when no filter is applied.
 */
export function writeBackfillFilterToUrl(next: BackfillFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(BACKFILL_FILTER_QUERY_PARAM);
  } else {
    url.searchParams.set(BACKFILL_FILTER_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Recent-runs disclosure URL state (Task #275).
 *
 * Task #262 added the All / Failed / Has invalid citations filter on
 * top of the recent-runs disclosure, but the active filter (and the
 * disclosure's open/closed state) only lived in component state.
 * Mirroring the URL-share pattern the tab + backfill filter use lets
 * an auditor drop a link in a Slack thread that lands a teammate on
 * the same filtered view, with the disclosure already expanded.
 *
 * Two params are reflected in the URL:
 *   - `recentRunsFilter=failed|invalid` — the active filter chip.
 *     Omitted when the default ("all") is active so the canonical
 *     URL stays bare.
 *   - `recentRunsOpen=1` — the disclosure's open state. Omitted when
 *     collapsed (the default), again to keep the canonical URL bare.
 *
 * Both helpers are SSR-safe and the read uses an allow-list so a
 * stale or hand-edited link can't push the panel into an undefined
 * filter state.
 */
const RECENT_RUNS_FILTER_QUERY_PARAM = "recentRunsFilter";
const RECENT_RUNS_OPEN_QUERY_PARAM = "recentRunsOpen";

export type RecentRunsFilter = "all" | "failed" | "invalid";

export function readRecentRunsFilterFromUrl(): RecentRunsFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_FILTER_QUERY_PARAM,
  );
  if (raw === "failed" || raw === "invalid") return raw;
  return "all";
}

export function writeRecentRunsFilterToUrl(next: RecentRunsFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(RECENT_RUNS_FILTER_QUERY_PARAM);
  } else {
    url.searchParams.set(RECENT_RUNS_FILTER_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

export function readRecentRunsOpenFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get(
    RECENT_RUNS_OPEN_QUERY_PARAM,
  );
  return raw === "1";
}

export function writeRecentRunsOpenToUrl(next: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next) {
    url.searchParams.set(RECENT_RUNS_OPEN_QUERY_PARAM, "1");
  } else {
    url.searchParams.delete(RECENT_RUNS_OPEN_QUERY_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}

/**
 * Findings-tab filter chips URL state (Task #436).
 *
 * The Findings tab can grow long on big submissions, so the architect
 * needs to narrow by severity bucket, finding category, or
 * addressed/unaddressed status. The active filter set is mirrored into
 * the URL the same way the `?tab=` and backfill-filter params are
 * (replaceState, defaults omitted) so a deep-link survives a refresh.
 *
 * Three params are reflected:
 *   - `severity=blocker|concern|advisory` — single severity bucket.
 *     Omitted when "all".
 *   - `category=<FindingCategory>` — single category. Omitted when
 *     "all". The allow-list is derived from the generated
 *     `FindingCategory` enum so adding a category in the API spec
 *     automatically widens the accepted values without touching this
 *     parser.
 *   - `showAddressed=false` — hide addressed (overridden) findings.
 *     Omitted when the default (show all rows) is active.
 */
const FINDINGS_SEVERITY_QUERY_PARAM = "severity";
const FINDINGS_CATEGORY_QUERY_PARAM = "category";
const FINDINGS_SHOW_ADDRESSED_QUERY_PARAM = "showAddressed";

export type FindingsSeverityFilter = "all" | FindingSeverity;
export type FindingsCategoryFilter = "all" | FindingCategory;

export function isFindingSeverity(raw: string): raw is FindingSeverity {
  return Object.prototype.hasOwnProperty.call(FindingSeverity, raw);
}

export function isFindingCategory(raw: string): raw is FindingCategory {
  return Object.prototype.hasOwnProperty.call(FindingCategory, raw);
}

export function readFindingsSeverityFilterFromUrl(): FindingsSeverityFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    FINDINGS_SEVERITY_QUERY_PARAM,
  );
  if (raw && isFindingSeverity(raw)) return raw;
  return "all";
}

export function writeFindingsSeverityFilterToUrl(next: FindingsSeverityFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(FINDINGS_SEVERITY_QUERY_PARAM);
  } else {
    url.searchParams.set(FINDINGS_SEVERITY_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

export function readFindingsCategoryFilterFromUrl(): FindingsCategoryFilter {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get(
    FINDINGS_CATEGORY_QUERY_PARAM,
  );
  if (raw && isFindingCategory(raw)) return raw;
  return "all";
}

export function writeFindingsCategoryFilterToUrl(next: FindingsCategoryFilter): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next === "all") {
    url.searchParams.delete(FINDINGS_CATEGORY_QUERY_PARAM);
  } else {
    url.searchParams.set(FINDINGS_CATEGORY_QUERY_PARAM, next);
  }
  window.history.replaceState(null, "", url.toString());
}

export function readFindingsShowAddressedFromUrl(): boolean {
  if (typeof window === "undefined") return true;
  const raw = new URLSearchParams(window.location.search).get(
    FINDINGS_SHOW_ADDRESSED_QUERY_PARAM,
  );
  if (raw === "false") return false;
  return true;
}

export function writeFindingsShowAddressedToUrl(next: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (next) {
    url.searchParams.delete(FINDINGS_SHOW_ADDRESSED_QUERY_PARAM);
  } else {
    url.searchParams.set(FINDINGS_SHOW_ADDRESSED_QUERY_PARAM, "false");
  }
  window.history.replaceState(null, "", url.toString());
}
