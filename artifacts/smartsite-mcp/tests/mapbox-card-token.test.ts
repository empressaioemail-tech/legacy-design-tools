/**
 * P-462. A missing or secret token refuses by name. It does not become an Esri url.
 */
import { afterEach, describe, expect, it } from "vitest";
import { groundTileUrl } from "../src/card/panel-lib.js";
import {
  MAPBOX_CARD_TOKEN_ENV_NAME,
  MAPBOX_CARD_TOKEN_INVALID,
  MAPBOX_CARD_TOKEN_SECRET,
  MAPBOX_CARD_TOKEN_UNSET,
  MapboxCardTokenError,
  requireMapboxCardToken,
} from "../src/mapbox-card-token.js";
import { assertMapboxCardTokenConfigured } from "../src/index.js";

const saved = process.env[MAPBOX_CARD_TOKEN_ENV_NAME];

afterEach(() => {
  delete (globalThis as { MAPBOX_CARD_TOKEN?: string }).MAPBOX_CARD_TOKEN;
  if (saved === undefined) delete process.env[MAPBOX_CARD_TOKEN_ENV_NAME];
  else process.env[MAPBOX_CARD_TOKEN_ENV_NAME] = saved;
});

describe("MAPBOX_CARD_TOKEN boot refusal", () => {
  it("unset throws and names the variable", () => {
    delete process.env[MAPBOX_CARD_TOKEN_ENV_NAME];
    expect(() => assertMapboxCardTokenConfigured()).toThrow(MapboxCardTokenError);
    try {
      requireMapboxCardToken();
    } catch (err) {
      expect(err).toBeInstanceOf(MapboxCardTokenError);
      expect((err as MapboxCardTokenError).refusal).toBe(MAPBOX_CARD_TOKEN_UNSET);
      expect((err as Error).message).toContain(MAPBOX_CARD_TOKEN_ENV_NAME);
      expect((err as Error).message).not.toContain("arcgisonline");
    }
  });

  it("a secret token is refused and is not placed on a tile url", () => {
    process.env[MAPBOX_CARD_TOKEN_ENV_NAME] = "sk.secret-must-not-ship";
    expect(() => groundTileUrl(1, 0, 0)).toThrow(MapboxCardTokenError);
    try {
      groundTileUrl(1, 0, 0);
    } catch (err) {
      expect((err as MapboxCardTokenError).refusal).toBe(MAPBOX_CARD_TOKEN_SECRET);
      expect((err as Error).message).not.toContain("sk.secret");
    }
  });

  it("a token that is not pk. is invalid", () => {
    process.env[MAPBOX_CARD_TOKEN_ENV_NAME] = "not-a-token";
    try {
      requireMapboxCardToken();
      throw new Error("should have refused");
    } catch (err) {
      expect((err as MapboxCardTokenError).refusal).toBe(MAPBOX_CARD_TOKEN_INVALID);
    }
  });

  it("the page token is data, and a tile url is Mapbox", () => {
    process.env[MAPBOX_CARD_TOKEN_ENV_NAME] = "pk.page-data";
    const url = groundTileUrl(19, 120403, 216130);
    expect(url).toContain("access_token=pk.page-data");
    expect(url).toContain("/19/120403/216130.jpg90");
    expect(url).not.toContain("arcgisonline");
  });
});
