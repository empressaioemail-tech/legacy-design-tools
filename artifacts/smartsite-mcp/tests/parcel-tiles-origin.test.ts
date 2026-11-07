/**
 * D-42 (OPS-25, 2026-09-23). THE PARCEL TILE ORIGIN HAS NO DEFAULT, VERIFIED BY
 * VIOLATION.
 *
 * The defect: `mcp-app.ts` named the closed Google Cloud bucket in the app's CSP
 * and in its network probe, so the app declared a dead origin and the parcel
 * ground stayed dark with nothing saying why. The fix reads
 * `PARCEL_TILES_ORIGIN`, and these tests are the control that the read has no
 * fallback behind it.
 *
 * Read them in the violation direction: restore the literal and every test in
 * the first two blocks goes RED, because the origin would resolve without the
 * variable being set.
 *
 * The suite runs with `PARCEL_TILES_ORIGIN` set to `https://tiles.test.invalid`
 * (vitest.config.ts), a reserved TLD that can never be mistaken for the real
 * Spaces origin D-42 creates. Each test here unsets it explicitly anyway, so it
 * does not depend on the harness declaring it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_RESOURCE_URI,
  PROBE_RESOURCE_TEXT,
  PROBE_RESOURCE_URI,
  buildAppHtml,
  probeCspDomains,
  probeNetTargets,
  registerMcpApp,
} from "../src/mcp-app.js";
import {
  PARCEL_TILES_ORIGIN_ENV_NAME,
  PARCEL_TILES_ORIGIN_INVALID_REFUSAL,
  PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
  ParcelTilesOriginError,
  parcelTilesOriginFromEnv,
  requireParcelTilesOrigin,
} from "../src/parcel-tiles-origin.js";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
  delete process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
});

afterEach(() => {
  if (saved === undefined) delete process.env[PARCEL_TILES_ORIGIN_ENV_NAME];
  else process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = saved;
  vi.unstubAllGlobals();
});

function refusalOf(fn: () => unknown): ParcelTilesOriginError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ParcelTilesOriginError);
    return err as ParcelTilesOriginError;
  }
  throw new Error("expected a ParcelTilesOriginError, got no throw at all");
}

describe("PARCEL_TILES_ORIGIN resolution — no default", () => {
  it("unset resolves to null, never to an origin", () => {
    expect(parcelTilesOriginFromEnv()).toBeNull();
  });

  it("VIOLATION: unset refuses by name, and the refusal names the variable and the reason", () => {
    const err = refusalOf(() => requireParcelTilesOrigin());
    expect(err.refusal).toBe(PARCEL_TILES_ORIGIN_UNSET_REFUSAL);
    expect(err.name).toBe("ParcelTilesOriginError");
    expect(err.message).toContain(PARCEL_TILES_ORIGIN_ENV_NAME);
    expect(err.message).toMatch(/no default/i);
  });

  it("VIOLATION: blank is unset, not a value", () => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "   ";
    expect(parcelTilesOriginFromEnv()).toBeNull();
    expect(refusalOf(() => requireParcelTilesOrigin()).refusal).toBe(
      PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
    );
  });

  it("a configured origin is used verbatim; a path is dropped, because a CSP entry is an ORIGIN", () => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "https://tiles.test.invalid/hauska/parcels";
    expect(parcelTilesOriginFromEnv()).toBe("https://tiles.test.invalid");
    expect(requireParcelTilesOrigin()).toBe("https://tiles.test.invalid");
  });

  it("VIOLATION: set to something that is not a URL refuses as INVALID, not as unset — a typo must not read as a missing variable", () => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "tiles.test.invalid";
    expect(refusalOf(() => parcelTilesOriginFromEnv()).refusal).toBe(
      PARCEL_TILES_ORIGIN_INVALID_REFUSAL,
    );
  });

  it("VIOLATION: set to a non-http(s) scheme refuses as invalid", () => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "ftp://tiles.test.invalid";
    expect(refusalOf(() => parcelTilesOriginFromEnv()).refusal).toBe(
      PARCEL_TILES_ORIGIN_INVALID_REFUSAL,
    );
  });
});

describe("the app surfaces refuse by name, rather than declaring a dead origin or omitting one", () => {
  it("VIOLATION: the probe channels refuse", () => {
    expect(refusalOf(() => probeNetTargets()).refusal).toBe(
      PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
    );
  });

  it("VIOLATION: the CSP domains refuse — a silently shortened CSP is the failure mode this replaces", () => {
    expect(refusalOf(() => probeCspDomains()).refusal).toBe(
      PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
    );
  });

  it("VIOLATION: the served page refuses to build, so the missing origin cannot present as a dark map", () => {
    expect(refusalOf(() => buildAppHtml()).refusal).toBe(
      PARCEL_TILES_ORIGIN_UNSET_REFUSAL,
    );
  });

  it("the board resource read refuses by name; the probe resource, which carries no origin, still answers", async () => {
    const handlers = new Map<string, (uri: { href: string }) => Promise<unknown>>();
    registerMcpApp({
      registerResource: (
        _name: string,
        uri: string,
        _config: Record<string, unknown>,
        handler: (u: { href: string }) => Promise<unknown>,
      ) => {
        handlers.set(uri, handler);
      },
    });

    await expect(
      handlers.get(APP_RESOURCE_URI)!({ href: APP_RESOURCE_URI }),
    ).rejects.toThrowError(ParcelTilesOriginError);

    const probe = (await handlers.get(PROBE_RESOURCE_URI)!({
      href: PROBE_RESOURCE_URI,
    })) as { contents: Array<{ text: string }> };
    expect(probe.contents[0]?.text).toBe(PROBE_RESOURCE_TEXT);
  });
});

describe("configured: the origin travels into both surfaces, and the dead bucket appears nowhere", () => {
  beforeEach(() => {
    process.env[PARCEL_TILES_ORIGIN_ENV_NAME] = "https://tiles.test.invalid";
  });

  it("the tiles channel probes tiles.json on the origin and the CSP declares the origin", () => {
    const tiles = probeNetTargets().find((t) => t.key === "tiles");
    expect(tiles?.url).toBe("https://tiles.test.invalid/tiles.json");
    expect(tiles?.url).not.toBe("https://tiles.test.invalid");
    expect(probeCspDomains()).toContain("https://tiles.test.invalid");
  });

  it("the served page carries the configured origin and no retired bucket host", () => {
    const html = buildAppHtml();
    expect(html).toContain("https://tiles.test.invalid");
    expect(html).not.toContain("storage.googleapis.com");
  });
});
