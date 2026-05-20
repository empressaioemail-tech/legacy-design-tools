/**
 * ICC-ES live-status client (Cortex Lane C.4 / C.4.5, L5).
 *
 * The L5 `product-spec-reference` refresh endpoint re-verifies an
 * ICC-ES Evaluation Service Report (ESR) against the live ICC-ES
 * listing. This module does the real synchronous fetch — a bounded
 * HTTP GET against the ICC-ES report listing with a hard timeout —
 * and a best-effort status parse.
 *
 * Honest scope (surfaced to the planner in the C.4.5 PR): the ICC-ES
 * report URL and the page's exact status markup were not verifiable at
 * build time. The report URL is therefore operator-tunable via the
 * `ICC_ES_REPORT_URL_TEMPLATE` env var (a `{ESR}` placeholder), and
 * {@link parseIccEsStatus} is a conservative keyword heuristic that
 * returns `null` ("indeterminate") rather than guessing — the refresh
 * route keeps the existing status on a `null` parse. The fetch itself,
 * the 5-10s timeout, and the `icc_es_unreachable` failure path are the
 * real, contract-grade parts.
 */

import type { ProductSpecStatus } from "@workspace/atoms-l-surface";

/** Default ICC-ES report-listing URL template; `{ESR}` is substituted. */
const DEFAULT_REPORT_URL_TEMPLATE =
  "https://icc-es.org/report-listing/?search_api_fulltext={ESR}";

/** Hard timeout for the ICC-ES poll. The contract specifies 5-10s. */
export const ICC_ES_POLL_TIMEOUT_MS = 9000;

/** Build the ICC-ES listing URL for an ESR number. Operator-tunable. */
export function iccEsReportUrl(esrNumber: string): string {
  const template =
    process.env["ICC_ES_REPORT_URL_TEMPLATE"] ?? DEFAULT_REPORT_URL_TEMPLATE;
  return template.replace("{ESR}", encodeURIComponent(esrNumber));
}

/**
 * Best-effort status parse from the ICC-ES listing HTML. Returns
 * `null` when no clear marker is present — the caller keeps the
 * existing status rather than flipping to a guessed one.
 */
export function parseIccEsStatus(html: string): ProductSpecStatus | null {
  const lower = html.toLowerCase();
  if (lower.includes("withdrawn")) return "withdrawn";
  if (lower.includes("expired")) return "expired";
  if (lower.includes("active") || lower.includes("currently valid")) {
    return "active";
  }
  return null;
}

/** Thrown when the ICC-ES listing cannot be reached → surfaces as 502. */
export class IccEsUnreachableError extends Error {
  constructor(
    public readonly url: string,
    cause: unknown,
  ) {
    super(`ICC-ES unreachable at ${url}: ${String(cause)}`);
    this.name = "IccEsUnreachableError";
  }
}

export interface IccEsPollResult {
  /** Parsed status, or `null` when the page gave no clear marker. */
  status: ProductSpecStatus | null;
  /** The ICC-ES listing URL the poll hit. */
  sourceUrl: string;
}

/**
 * Synchronously poll the ICC-ES listing for an ESR number. Throws
 * {@link IccEsUnreachableError} on a network failure, timeout, or
 * non-2xx response.
 */
export async function pollIccEsStatus(
  esrNumber: string,
): Promise<IccEsPollResult> {
  const url = iccEsReportUrl(esrNumber);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ICC_ES_POLL_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "legacy-design-tools-cortex/1.0",
        accept: "text/html",
      },
    });
  } catch (err) {
    throw new IccEsUnreachableError(url, err);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new IccEsUnreachableError(url, `HTTP ${res.status}`);
  }
  const html = await res.text().catch(() => "");
  return { status: parseIccEsStatus(html), sourceUrl: url };
}
