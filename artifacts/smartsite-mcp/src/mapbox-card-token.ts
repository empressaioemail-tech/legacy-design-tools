/**
 * P-462. The card's Mapbox token is configuration, not a default.
 *
 * The viewer's browser requests Satellite tiles. The token therefore has to
 * be a public `pk.` token, injected into the page as data. A secret `sk.`
 * token in that position would ship account credentials to every viewer.
 * An unset token used to be the path back to Esri; that path is a refusal.
 *
 * Browser-safe: the page sets `MAPBOX_CARD_TOKEN` before the card script
 * runs, and Node reads `process.env` through `globalThis` so the browser
 * bundle does not require a `process` global.
 */

export const MAPBOX_CARD_TOKEN_ENV_NAME = "MAPBOX_CARD_TOKEN";

export const MAPBOX_CARD_TOKEN_UNSET = "mapbox_card_token_unset";
export const MAPBOX_CARD_TOKEN_SECRET = "mapbox_card_token_secret";
export const MAPBOX_CARD_TOKEN_INVALID = "mapbox_card_token_invalid";

export type MapboxCardTokenRefusal =
  | typeof MAPBOX_CARD_TOKEN_UNSET
  | typeof MAPBOX_CARD_TOKEN_SECRET
  | typeof MAPBOX_CARD_TOKEN_INVALID;

export class MapboxCardTokenError extends Error {
  readonly refusal: MapboxCardTokenRefusal;

  constructor(refusal: MapboxCardTokenRefusal, message: string) {
    super(message);
    this.name = "MapboxCardTokenError";
    this.refusal = refusal;
  }
}

function rawToken(): string {
  const injected = (globalThis as { MAPBOX_CARD_TOKEN?: unknown }).MAPBOX_CARD_TOKEN;
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[MAPBOX_CARD_TOKEN_ENV_NAME];
  if (typeof env === "string") return env.trim();
  return "";
}

/** The public token, or a named refusal. The message never includes the value. */
export function requireMapboxCardToken(): string {
  const token = rawToken();
  if (!token) {
    throw new MapboxCardTokenError(
      MAPBOX_CARD_TOKEN_UNSET,
      `${MAPBOX_CARD_TOKEN_ENV_NAME} is not set. Card ground is Mapbox Satellite and does not fall back to Esri.`,
    );
  }
  if (/\s/.test(token)) {
    throw new MapboxCardTokenError(
      MAPBOX_CARD_TOKEN_INVALID,
      `${MAPBOX_CARD_TOKEN_ENV_NAME} contains whitespace.`,
    );
  }
  if (token.startsWith("sk.")) {
    throw new MapboxCardTokenError(
      MAPBOX_CARD_TOKEN_SECRET,
      `${MAPBOX_CARD_TOKEN_ENV_NAME} is a secret token. The card sends it to the viewer's browser, so it must be a public pk token.`,
    );
  }
  if (!token.startsWith("pk.")) {
    throw new MapboxCardTokenError(
      MAPBOX_CARD_TOKEN_INVALID,
      `${MAPBOX_CARD_TOKEN_ENV_NAME} must be a public token starting with pk.`,
    );
  }
  return token;
}
