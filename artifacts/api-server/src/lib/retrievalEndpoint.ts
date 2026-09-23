/**
 * D-25 (OPS-25, 2026-09-23). THE RETRIEVAL BASE URL HAS NO DEFAULT.
 *
 * WHAT WAS WRONG. Four modules in this package ended their base-URL resolution
 * with the same hardcoded literal -- the retired Google Cloud Run retrieval-api
 * address -- behind `HAUSKA_RETRIEVAL_API_URL` / `RETRIEVAL_API_URL` /
 * `BRIEF_RETRIEVAL_API_URL`. That literal is not retyped in this file or in the
 * four modules, deliberately, so a repo-wide grep for the dead host stays clean
 * and any future hit is a real default rather than a note about one.
 * The GCP estate is gone (the billing account closed 2026-09-22 and the operator
 * has ruled Google Cloud is not used again), so that literal is a corpse. The
 * trap is not the dead host itself: it is that a deployment spec built from the
 * GCP capture cannot see this at all, because the capture records only the
 * variables production SET. The unset variable is invisible to the spec, the
 * build boots cleanly, and every call silently reaches a corpse.
 *
 * THE RULE (A-29), and it is why this is a deletion rather than a repoint: a
 * default pointing at the new host is the same defect at the next move. With the
 * default gone, an unset variable refuses by name at the call. Setting the
 * variable is D-6's spec, which SETS the retrieval URL names deliberately; the
 * fail-closed path is for the misconfiguration, and it must be loud rather than
 * data-shaped.
 *
 * WHY THIS THROWS RATHER THAN RETURNING THE CALLERS' EXISTING "no answer" VALUE,
 * which is the part worth arguing. Each of these readers already refuses with a
 * null-ish value when its API KEY is missing, and copying that shape for the
 * missing URL would be the smaller diff. It would also be wrong, and in the
 * direction this program hunts: a caller cannot tell "the retrieval service says
 * there is no atom chain for this parcel" (a real, verified absence) from "nobody
 * configured the service address" (a misconfiguration). The null is laundered
 * into `chain: "absent"`, which is a FABRICATED ABSENCE on a customer surface.
 * A named throw cannot be laundered into a fact about the parcel.
 *
 * The one module that keeps a structured refusal instead of throwing is
 * `placeCoverageSource.ts`, which already carries an explicit three-valued
 * vocabulary (`covered` / `not-covered` / `indeterminate`) whose whole purpose is
 * to keep "the check could not run" apart from a real answer. There the named
 * reason is the declared refusal, and nothing is laundered.
 */

/** The environment names this resolution tries, in order. Stated here so a refusal can name them. */
export const RETRIEVAL_BASE_URL_ENV_NAMES = [
  "HAUSKA_RETRIEVAL_API_URL",
  "RETRIEVAL_API_URL",
  "BRIEF_RETRIEVAL_API_URL",
] as const;

/** The machine-readable name of this refusal. */
export const RETRIEVAL_BASE_URL_UNSET_REFUSAL = "retrieval-base-url-unset";

/**
 * Thrown when none of {@link RETRIEVAL_BASE_URL_ENV_NAMES} is set. The message
 * names every variable tried, so a reader of a 500 or a log line is told which
 * knob to turn rather than which host is dead.
 */
export class RetrievalBaseUrlUnsetError extends Error {
  readonly refusal = RETRIEVAL_BASE_URL_UNSET_REFUSAL;
  readonly envNames: readonly string[];

  constructor(envNames: readonly string[] = RETRIEVAL_BASE_URL_ENV_NAMES) {
    super(
      `retrieval base URL is not configured: set one of ${envNames.join(", ")}. ` +
        "There is no default host (D-25): the retired Google Cloud host is dead and must not be used.",
    );
    this.name = "RetrievalBaseUrlUnsetError";
    this.envNames = envNames;
  }
}

/**
 * The configured retrieval base URL with trailing slashes removed, or `null`
 * when nothing is configured. NEVER a default host.
 */
export function retrievalBaseUrlFromEnv(): string | null {
  const raw =
    process.env.HAUSKA_RETRIEVAL_API_URL?.trim() ||
    process.env.RETRIEVAL_API_URL?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** The configured retrieval base URL, or a named throw. See the file header for why this throws. */
export function requireRetrievalBaseUrl(): string {
  const url = retrievalBaseUrlFromEnv();
  if (!url) throw new RetrievalBaseUrlUnsetError();
  return url;
}

/** True when this value is the refusal this module raises, however it crossed a boundary. */
export function isRetrievalBaseUrlUnsetError(value: unknown): value is RetrievalBaseUrlUnsetError {
  return (
    value instanceof Error &&
    (value as { refusal?: string }).refusal === RETRIEVAL_BASE_URL_UNSET_REFUSAL
  );
}

/**
 * The refusal's message, for a caller that must keep a STRUCTURED refusal
 * instead of throwing (see `placeCoverageSource.ts`'s three-valued verdict).
 * One wording, so a reader of a log or a response cannot tell which module
 * produced it -- which is the point: the deployment fault is one thing.
 */
export function retrievalBaseUrlUnsetReason(): string {
  return new RetrievalBaseUrlUnsetError().message;
}
