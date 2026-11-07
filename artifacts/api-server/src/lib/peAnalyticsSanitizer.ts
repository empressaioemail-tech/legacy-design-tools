/**
 * THE PRIVACY LINE for cortex's ad-platform sends (Meta CAPI, GA4
 * Measurement Protocol): Meta and Google may learn that a visitor signed up
 * or bought, never WHICH parcel.
 *
 * This is the cortex copy of hauska-map's sanitizer
 * (`apps/property-explorer/api/_lib/analytics-url.ts`: `findAnalyticsLeaks`,
 * `sanitizeAnalyticsPayload`). The two repos share no package, so the rules
 * and the test vectors are mirrored; `peAnalyticsSanitizer.test.ts` runs the
 * same leak vectors hauska-map's suite does. Change one, change both.
 *
 * Cortex never derives a reported URL from a page address: every server
 * event it sends reports the generic site URL below. The sanitizer's job
 * here is the final walk over the exact wire object, refusing the send on
 * any parcel-shaped value or key.
 */

export const PE_SITE_ORIGIN_FALLBACK = "https://smartsite.cloud";

/** The only event_source_url / page_location cortex reports. */
export function peGenericEventSourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["PE_SITE_ORIGIN"]?.trim();
  if (raw && /^https:\/\/[a-z0-9.-]+$/i.test(raw.replace(/\/+$/, ""))) {
    return `${raw.replace(/\/+$/, "")}/`;
  }
  return `${PE_SITE_ORIGIN_FALLBACK}/`;
}

/** `{5-digit FIPS}:{propId}` anywhere in text. */
const PARCEL_NODE_ID_IN_TEXT = /(?:^|[^0-9])\d{5}:[A-Za-z0-9._-]+/;
const ENCODED_PARCEL_NODE_ID = /\d{5}%3A[A-Za-z0-9._-]+/i;
/** `coord:<lat>:<lng>` / `coord:<lat>,<lng>` place key. */
const PLACE_KEY_IN_TEXT = /coord:\s*-?\d/i;
const COORDINATE_PAIR_IN_TEXT = /-?\d{1,3}\.\d{4,}\s*[,:;\s]\s*-?\d{1,3}\.\d{4,}/;
const URL_SUBJECT_PARAM =
  /[?&#](?:g|grant|token|parcelnodeid|parcel|parcelid|parcel_id|node|nodeid|node_id|placekey|place_key|place|address|situs|apn|propid|prop_id|lat|lng|lon|latitude|longitude|coord|coords)=/i;
const URL_SHARE_GRANT_PATH = /\/s\/[^/?#\s]+/;

export function textCarriesIdentifier(value: string): boolean {
  return (
    PARCEL_NODE_ID_IN_TEXT.test(value) ||
    ENCODED_PARCEL_NODE_ID.test(value) ||
    PLACE_KEY_IN_TEXT.test(value) ||
    COORDINATE_PAIR_IN_TEXT.test(value)
  );
}

const LEAK_KEY_STEMS = [
  "parcel",
  "apn",
  "address",
  "situs",
  "owner",
  "placekey",
  "latitude",
  "longitude",
  "coord",
  "nodeid",
  "grant",
  "propid",
] as const;
const LEAK_EXACT_KEYS = new Set(["lat", "lng", "lon"]);
/** Meta's matching block: its keys are Meta's, not ours. */
const LEAK_KEY_EXEMPT_PARENTS = new Set(["user_data"]);
/** The visitor's own UA string is never parcel data; exempt from the value test. */
const VALUE_CHECK_EXEMPT_KEYS = new Set(["client_user_agent"]);

export type AnalyticsLeak = { path: string; reason: string };

export function findAnalyticsLeaks(value: unknown, path = "$", parentKey = ""): AnalyticsLeak[] {
  const leaks: AnalyticsLeak[] = [];
  if (value === null || value === undefined) return leaks;
  if (typeof value === "string") {
    if (textCarriesIdentifier(value)) leaks.push({ path, reason: "identifier_value" });
    else if (/^https?:\/\//i.test(value) || value.startsWith("/")) {
      if (URL_SUBJECT_PARAM.test(value)) leaks.push({ path, reason: "url_subject_param" });
      else if (URL_SHARE_GRANT_PATH.test(value)) leaks.push({ path, reason: "url_share_grant" });
      else if (value.includes("#") && value.split("#")[1]) leaks.push({ path, reason: "url_fragment" });
    }
    return leaks;
  }
  if (typeof value !== "object") return leaks;
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaks.push(...findAnalyticsLeaks(item, `${path}[${i}]`, parentKey)));
    return leaks;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (!LEAK_KEY_EXEMPT_PARENTS.has(parentKey)) {
      const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (LEAK_EXACT_KEYS.has(norm) || LEAK_KEY_STEMS.some((stem) => norm.includes(stem))) {
        leaks.push({ path: childPath, reason: "identifying_key" });
      }
    }
    if (VALUE_CHECK_EXEMPT_KEYS.has(key) && typeof child === "string") continue;
    leaks.push(...findAnalyticsLeaks(child, childPath, key));
  }
  return leaks;
}

/**
 * The final check every cortex Meta / Google send makes on the exact wire
 * object. A leak refuses the send.
 */
export function assertNoAnalyticsLeak(payload: unknown): void {
  const leaks = findAnalyticsLeaks(payload);
  if (leaks.length > 0) {
    throw new Error(`identifier_leak_refused:${leaks.map((l) => l.path).join(",")}`);
  }
}
