import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PARCEL_TILES_ORIGIN_ENV_NAME,
  ParcelTilesOriginError,
} from "../src/parcel-tiles-origin.js";
import { assertParcelTilesOriginConfigured } from "../src/index.js";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
});

afterEach(() => {
  if (saved === undefined) delete process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
  else process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = saved;
});

describe("boot refuses without PARCEL_TILES_ORIGIN (P-446)", () => {
  it("assertParcelTilesOriginConfigured throws when unset", () => {
    delete process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
    expect(() => assertParcelTilesOriginConfigured()).toThrow(ParcelTilesOriginError);
  });

  it("passes when configured", () => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "https://tiles.test.invalid";
    expect(() => assertParcelTilesOriginConfigured()).not.toThrow();
  });
});
