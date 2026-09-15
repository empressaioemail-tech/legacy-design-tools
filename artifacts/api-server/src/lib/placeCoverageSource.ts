/**
 * P-205 / P-210 (OPS-24). COUNTY-LEVEL COVERAGE, INJECTED NOT IMPLEMENTED.
 *
 * WHY THIS FILE EXISTS AND WHY IT HAS NO REAL BACKEND YET. `find_parcel`
 * collapses "this county was never onboarded" and "this county is onboarded,
 * genuinely no match" into the same `no-hit` (P-205, measured live on a
 * Killeen/Bell County 76541 address). Fixing this for real requires knowing,
 * for an arbitrary address, whether its county is in Smart Site's serving
 * ledger — and P-210 (same investigation) proved every derivation source
 * reachable FROM THIS REPO is wrong or absent:
 *
 *   - A hand-maintained county list (three already exist in this codebase,
 *     e.g. `parcelConstraintSearch.ts`'s CONSTRAINT_SEARCH_COUNTIES) is
 *     exactly the anti-pattern P-205's dispatch was written to prevent:
 *     correct today, silently wrong the moment a county is onboarded.
 *   - `txgio_parcel`/`txgio_address` row-presence is not equivalent to
 *     serving-ledger membership: live-falsified by a real hit in Bexar
 *     County (48029:109766, NOT one of the six serving-ledger counties).
 *   - `get_smart_site` reading Bexar's `48029:109766` at depth node SERVES
 *     a full card (situs, zoning, flood all present) while Bexar appears in
 *     neither `parcel_record` nor `parcel_gate_verdict` — so the SERVING
 *     path is broader than the ledger too. Coverage is (at least) three
 *     different, disagreeing sets: the address index, the serving path, and
 *     the Factory ledger. Which one is canonical is an open operator ruling
 *     (P-210), not something this lane may decide by picking one to code
 *     against.
 *
 * So THIS file defines the shape of a correct answer and injects it,
 * without deciding what supplies it. A follow-on lane against
 * `hauska-engine`'s `retrieval-api` supplies a real {@link CoverageSource}
 * once P-210 is ruled; see the CONTRACT this lane's close documents for the
 * exact endpoint shape that lane should build. `RetrievalApiCoverageSource`
 * below already calls that not-yet-built endpoint — every call fails today
 * (no URL configured / 404), which this module treats as `indeterminate` by
 * construction. The day the endpoint exists and is configured, this same
 * client starts returning real verdicts with NO further code change here.
 *
 * THE ONE HARD CONSTRAINT (operator ruling, 2026-09-14): with no coverage
 * source available, the consumer MUST FAIL CLOSED — decline, never fall
 * through to `no-hit` and never assume covered. A source that defaults to
 * "covered" is worse than the original bug, because the original bug is at
 * least visible; a fake-passing check is not. See
 * `resolveCoveragePlaceSearchMiss` in `txgioAddressResolve.ts` for where
 * this verdict is turned into a `find_parcel` response.
 */

const DEFAULT_RETRIEVAL = "https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app";

/**
 * Three states, not two, deliberately mirroring `ParcelGateVerdictWire`'s
 * existing `undefined`-vs-`null` split in `parcelRecordReaderClient.ts`:
 * `indeterminate` is "the check itself could not run or could not decide"
 * (network failure, source unconfigured, ambiguous locality spanning more
 * than one county) and is NEVER conflated with `covered` (a real store said
 * yes) or `not-covered` (a real store said no, and can name the county).
 * A consumer that cannot tell "unknown" from "yes" is exactly the
 * presence-shaped-check defect P-205's own falsifier #3 warns against.
 */
export type CoverageVerdict =
  | { status: "covered" }
  | { status: "not-covered"; countyFips: string; countyName: string; state: string }
  | { status: "indeterminate"; reason: string };

export interface CoverageCheckInput {
  /** Parsed locality signal, same shape `searchPlaceByPrefix` already parses via `parsePlaceSearchLocality`. */
  city: string | null;
  state: string | null;
  zip: string | null;
  /** The raw, untrimmed query text, for a source that wants to parse it itself (e.g. a full street+city+zip string carries more than the parsed locality alone). */
  rawQuery: string;
}

export interface CoverageSource {
  checkCoverage(input: CoverageCheckInput): Promise<CoverageVerdict>;
}

function resolveBaseUrl(): string {
  return (
    process.env.HAUSKA_RETRIEVAL_API_URL?.trim() ||
    process.env.RETRIEVAL_API_URL?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_URL?.trim() ||
    DEFAULT_RETRIEVAL
  ).replace(/\/$/, "");
}

function resolveApiKey(): string | undefined {
  return (
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_KEY?.trim()
  );
}

type CoverageCheckResponseBody = {
  status: "covered" | "not-covered" | "indeterminate";
  countyFips?: string;
  countyName?: string;
  state?: string;
  reason?: string;
};

function isValidBody(body: unknown): body is CoverageCheckResponseBody {
  if (!body || typeof body !== "object") return false;
  const status = (body as { status?: unknown }).status;
  return status === "covered" || status === "not-covered" || status === "indeterminate";
}

/**
 * Real client for the endpoint this lane's close specifies as the CONTRACT
 * for a follow-on `hauska-engine` lane. Does not exist server-side yet —
 * every call today either skips (no key/no locality signal) or gets a
 * network error / non-200, and both collapse to `indeterminate`. This is
 * the fail-closed contract by construction, not a special case: there is no
 * branch here that can return `covered` or `not-covered` without a real,
 * well-formed answer from the server.
 */
async function fetchCoverageFromRetrievalApi(
  input: CoverageCheckInput,
): Promise<CoverageVerdict> {
  if (!input.city && !input.state && !input.zip) {
    return {
      status: "indeterminate",
      reason: "no locality signal (city/state/zip) parsed from the query to check coverage against",
    };
  }
  const key = resolveApiKey();
  if (!key) {
    return { status: "indeterminate", reason: "retrieval-api key not configured" };
  }
  const params = new URLSearchParams();
  if (input.city) params.set("city", input.city);
  if (input.state) params.set("state", input.state);
  if (input.zip) params.set("zip", input.zip);
  try {
    const res = await fetch(
      `${resolveBaseUrl()}/parcel-record-gate-verdict/coverage/check?${params.toString()}`,
      { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      return { status: "indeterminate", reason: `coverage endpoint returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as unknown;
    if (!isValidBody(body)) {
      return { status: "indeterminate", reason: "coverage endpoint returned a malformed body" };
    }
    if (body.status === "covered") return { status: "covered" };
    if (body.status === "not-covered") {
      if (!body.countyFips || !body.countyName || !body.state) {
        return {
          status: "indeterminate",
          reason: "coverage endpoint said not-covered but omitted countyFips/countyName/state",
        };
      }
      return {
        status: "not-covered",
        countyFips: body.countyFips,
        countyName: body.countyName,
        state: body.state,
      };
    }
    return { status: "indeterminate", reason: body.reason ?? "coverage endpoint declined to determine coverage" };
  } catch (err) {
    return {
      status: "indeterminate",
      reason: `coverage endpoint call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const retrievalApiCoverageSource: CoverageSource = {
  checkCoverage: fetchCoverageFromRetrievalApi,
};
