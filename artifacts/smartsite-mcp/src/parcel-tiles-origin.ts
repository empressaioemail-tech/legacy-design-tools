/**
 * D-42 (OPS-25, 2026-09-23). THE PARCEL TILE ORIGIN HAS NO DEFAULT.
 *
 * WHAT WAS WRONG. `mcp-app.ts` named the closed Google Cloud object-store host
 * twice, for the bucket the Smart Site parcel ground was baked into: as the
 * `gcs` channel of the p559 network probe and as an origin in the app's
 * declared CSP. That bucket is on the closed Google Cloud estate -- read live on
 * 2026-09-23, the parcel layer answers 403 there and has been dark since the
 * outage. A literal there
 * is worse than a dead read: a CSP that declares a dead origin declares the
 * WRONG origin, and the ground stays dark with nothing saying why.
 *
 * THE RULE (A-29, and register section 2.4). Delete the default rather than
 * repoint it: a default aimed at the new host is the same defect at the next
 * move. D-42 moves the tiles to DigitalOcean Spaces, and THIS LANE DOES NOT KNOW
 * THAT ORIGIN -- the register records this lane as waiting on "the Spaces origin
 * from `r1-factory-images-tiles` for the CSP value only". So the origin is read
 * from `PARCEL_TILES_ORIGIN`, and when it is unset the refusal is RAISED BY NAME
 * rather than omitted or guessed.
 *
 * WHY A RAISE AND NOT AN OMISSION, which is the part worth arguing. Dropping the
 * entry from the CSP when the variable is unset would be a smaller diff and
 * would look tidier, and it is the failure mode this program keeps paying for: a
 * missing CSP entry is indistinguishable, from the surface, from a tile origin
 * that was simply never needed. The app would serve, the parcel ground would be
 * dark, and no reader could tell the deployment was misconfigured. A named
 * refusal at the moment the page is built and the CSP is declared cannot be
 * mistaken for that, and it cannot be mistaken for the dead-bucket 403s either.
 *
 * The literal is not retyped here or in `mcp-app.ts`, deliberately, so a
 * repo-wide grep for the dead host stays clean and any future hit is a real
 * default rather than a note about one.
 */

/** The environment name, stated once so every refusal can name it. */
export const PARCEL_TILES_ORIGIN_ENV_NAME = "PARCEL_TILES_ORIGIN";

/** The machine-readable names of this module's two refusals. */
export const PARCEL_TILES_ORIGIN_UNSET_REFUSAL = "parcel_tiles_origin_unset";
export const PARCEL_TILES_ORIGIN_INVALID_REFUSAL = "parcel_tiles_origin_invalid";

export type ParcelTilesOriginRefusal =
  | typeof PARCEL_TILES_ORIGIN_UNSET_REFUSAL
  | typeof PARCEL_TILES_ORIGIN_INVALID_REFUSAL;

/**
 * Thrown when `PARCEL_TILES_ORIGIN` is unset, and when it is set to something
 * that is not an absolute http(s) origin. Two refusals, one class, because a
 * caller's response to both is the same -- refuse and say which -- and the
 * distinction matters only to the reader of the message.
 */
export class ParcelTilesOriginError extends Error {
  readonly refusal: ParcelTilesOriginRefusal;

  constructor(refusal: ParcelTilesOriginRefusal, message: string) {
    super(message);
    this.name = "ParcelTilesOriginError";
    this.refusal = refusal;
  }
}

/**
 * The configured origin, or `null` when the variable is unset or blank.
 * Throws {@link ParcelTilesOriginError} with the `invalid` refusal when it is
 * SET but is not an absolute http(s) origin -- "set to a wrong thing" must not
 * read the same as "not set", or a typo in a spec looks like a missing var.
 */
export function parcelTilesOriginFromEnv(): string | null {
  const raw = process.env.PARCEL_TILES_ORIGIN?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ParcelTilesOriginError(
      PARCEL_TILES_ORIGIN_INVALID_REFUSAL,
      `${PARCEL_TILES_ORIGIN_ENV_NAME} is not an absolute URL: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ParcelTilesOriginError(
      PARCEL_TILES_ORIGIN_INVALID_REFUSAL,
      `${PARCEL_TILES_ORIGIN_ENV_NAME} must be http(s), got ${parsed.protocol}//`,
    );
  }
  return parsed.origin;
}

/**
 * The configured parcel tile origin, or a named refusal. A CSP origin must be an
 * ORIGIN, so a value carrying a path is reduced to its origin rather than
 * declared with the path -- `connectDomains`/`resourceDomains` do not honour one.
 */
export function requireParcelTilesOrigin(): string {
  const origin = parcelTilesOriginFromEnv();
  if (!origin) {
    throw new ParcelTilesOriginError(
      PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
      `${PARCEL_TILES_ORIGIN_ENV_NAME} is not set, so the parcel tile origin is unknown. ` +
        "There is no default (D-42): the parcel tiles lived in the closed Google Cloud bucket " +
        "and read 403 there; D-42 moves them to DigitalOcean Spaces and supplies this value.",
    );
  }
  return origin;
}
