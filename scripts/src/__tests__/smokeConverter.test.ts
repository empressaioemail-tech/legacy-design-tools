/**
 * Fixture-led coverage for `scripts/src/smokeConverter.ts` — Task #349.
 *
 * Why this exists
 * ---------------
 * `smokeConverter.ts` is the only thing operators run after a converter
 * deploy to confirm the wire contract still holds. It re-implements,
 * rather than imports, the multipart + HMAC + glb-validation logic the
 * api-server's `HttpConverterClient` speaks (workspace rules forbid
 * `scripts` from importing from `artifacts/api-server` — see the long
 * comment at the top of `smokeConverter.ts`). That divergence is fine
 * as long as both sides are pinned by tests; without them, a regression
 * in `validateGlb` (e.g. dropping the BIN-chunk type check) or in the
 * HMAC signature input (`requestId.layerKind`) would silently pass
 * smoke runs against a broken converter, and we'd only find out when
 * the SiteContextViewer in production starts failing to render.
 *
 * Two surfaces are pinned here:
 *
 *   1. `validateGlb` — exercised against a hand-built, known-good glb
 *      and a series of mutated variants (wrong magic, wrong version,
 *      mismatched header length, wrong first chunk type, JSON chunk
 *      that overruns the buffer, non-JSON parse, missing/wrong BIN
 *      chunk header). Each branch in the function gets a test row.
 *
 *   2. `smokeOne` — driven against an in-process `global.fetch` stub
 *      so we can assert the request shape (URL, method, headers,
 *      multipart parts) WITHOUT any network or env-var setup. The
 *      assertions mirror what the api-server-side
 *      `HttpConverterClient` test pins on the production client, so
 *      drift between the two would show up here as a request-shape
 *      mismatch rather than a silent contract bug at deploy time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  validateGlb,
  smokeOne,
  type DxfLayerKind,
} from "../smokeConverter";

/**
 * Build a minimal, well-formed binary glTF 2.0 envelope (header +
 * JSON chunk + optional BIN chunk). Matches the byte layout
 * `MockConverterClient.buildMockGlb` produces in the api-server, so
 * this fixture is "what a real converter would return" — not just
 * "what `validateGlb` happens to accept today". Keeping that
 * symmetry is what makes the fail-case mutations below meaningful:
 * each one represents a specific way the real converter could
 * regress.
 */
function buildValidGlb(opts: { withBin?: boolean } = {}): Buffer {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: "2.0" } }),
    "utf8",
  );
  // glTF requires chunks to be 4-byte aligned. The script's
  // `validateGlb` doesn't itself enforce alignment, but every real
  // glb the converter emits is aligned, and an unaligned JSON chunk
  // would produce odd boundaries when we mutate the BIN chunk
  // offsets below. So mirror the production padding here.
  const paddedJsonLen = Math.ceil(json.length / 4) * 4;
  const paddedJson = Buffer.alloc(paddedJsonLen);
  json.copy(paddedJson, 0);
  for (let i = json.length; i < paddedJsonLen; i++) paddedJson[i] = 0x20;

  const bin = opts.withBin ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0);
  const total =
    12 + 8 + paddedJson.length + (opts.withBin ? 8 + bin.length : 0);
  const out = Buffer.alloc(total);
  out.write("glTF", 0, "ascii");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(paddedJson.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  paddedJson.copy(out, 20);
  if (opts.withBin) {
    const binOffset = 20 + paddedJson.length;
    out.writeUInt32LE(bin.length, binOffset);
    out.writeUInt32LE(0x004e4942, binOffset + 4); // "BIN\0"
    bin.copy(out, binOffset + 8);
  }
  return out;
}

describe("validateGlb — Task #349", () => {
  it("accepts a well-formed glb with only a JSON chunk", () => {
    const glb = buildValidGlb();
    expect(validateGlb(glb)).toEqual({ ok: true, length: glb.length });
  });

  it("accepts a well-formed glb that also has a BIN chunk", () => {
    // The BIN-chunk branch is the most regression-prone: it's only
    // exercised when the second chunk is present, so a refactor
    // could quietly drop the type check and the JSON-only test
    // above would still pass. Pin it explicitly.
    const glb = buildValidGlb({ withBin: true });
    expect(validateGlb(glb)).toEqual({ ok: true, length: glb.length });
  });

  it("rejects a buffer shorter than the 12-byte glTF header", () => {
    expect(validateGlb(Buffer.alloc(11))).toEqual({
      ok: false,
      reason: "shorter than glTF header (12 bytes)",
    });
  });

  it("rejects a buffer with the wrong magic", () => {
    const glb = buildValidGlb();
    glb.write("XLTF", 0, "ascii");
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('magic was "XLTF"');
    }
  });

  it("rejects a buffer with the wrong glTF version", () => {
    const glb = buildValidGlb();
    glb.writeUInt32LE(1, 4); // version 1, not 2
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("version was 1");
    }
  });

  it("rejects when the header length field disagrees with the actual byte length", () => {
    const glb = buildValidGlb();
    glb.writeUInt32LE(glb.length + 4, 8);
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("header length");
      expect(result.reason).toContain("!= actual byte length");
    }
  });

  it("rejects a buffer that's missing the JSON chunk header (length 12-19)", () => {
    // Just the 12-byte glTF header, no chunk header to follow.
    // Length field has to match for the buffer to even reach the
    // chunk-header check.
    const glb = Buffer.alloc(16);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(16, 8);
    expect(validateGlb(glb)).toEqual({
      ok: false,
      reason: "missing JSON chunk header",
    });
  });

  it("rejects when the first chunk type is not JSON", () => {
    const glb = buildValidGlb();
    // Overwrite the chunk-type field at offset 16 with something
    // other than 0x4e4f534a ("JSON"). Pick BIN's type code so the
    // failure is unambiguous: a converter that swapped chunk order
    // would produce exactly this byte pattern.
    glb.writeUInt32LE(0x004e4942, 16);
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("first chunk type was");
      expect(result.reason).toContain("expected JSON");
    }
  });

  it("rejects when the JSON chunk length overruns the buffer", () => {
    const glb = buildValidGlb();
    // Set the JSON chunk length way past the buffer end.
    glb.writeUInt32LE(glb.length, 12);
    expect(validateGlb(glb)).toEqual({
      ok: false,
      reason: "JSON chunk overruns buffer",
    });
  });

  it("rejects when the JSON chunk does not parse", () => {
    // Build a glb whose JSON chunk contains literal garbage. We
    // can't reuse `buildValidGlb` here because we want to control
    // the chunk bytes precisely. The header points at a 4-byte
    // chunk that decodes as "{{{{" — definitively not JSON.
    const garbage = Buffer.from("{{{{", "utf8");
    const total = 12 + 8 + garbage.length;
    const glb = Buffer.alloc(total);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(total, 8);
    glb.writeUInt32LE(garbage.length, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    garbage.copy(glb, 20);
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("JSON chunk did not parse");
    }
  });

  it("rejects trailing bytes too short to be a BIN chunk header", () => {
    // Append a stray byte after the JSON chunk so we land in the
    // "second chunk present but smaller than the 8-byte header"
    // branch. Update the total length so the prior length-match
    // check still passes.
    const base = buildValidGlb();
    const glb = Buffer.concat([base, Buffer.from([0x00])]);
    glb.writeUInt32LE(glb.length, 8);
    expect(validateGlb(glb)).toEqual({
      ok: false,
      reason: "trailing bytes too short for a BIN chunk header",
    });
  });

  it("rejects when the second chunk type is not BIN", () => {
    // Build a valid JSON+BIN glb and then corrupt the BIN type
    // field to something else (here the JSON type code, the most
    // likely off-by-N regression).
    const glb = buildValidGlb({ withBin: true });
    // Locate the BIN type field: it lives at offset
    // 20 + paddedJsonLen + 4. Re-derive paddedJsonLen from the
    // chunk-length field at offset 12 to stay in lock-step with
    // `buildValidGlb`'s padding.
    const jsonLen = glb.readUInt32LE(12);
    const binTypeOffset = 20 + jsonLen + 4;
    glb.writeUInt32LE(0x4e4f534a, binTypeOffset); // "JSON" instead of "BIN\0"
    const result = validateGlb(glb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("second chunk type was");
      expect(result.reason).toContain("expected BIN");
    }
  });
});

/**
 * Helper: a `Response` carrying a known-good glb, content-type set
 * exactly as the production converter sends it. Used by the
 * `smokeOne` happy-path test.
 */
function okGlbResponse(): Response {
  const bytes = buildValidGlb({ withBin: true });
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "model/gltf-binary" },
  });
}

describe("smokeOne — request-shape contract — Task #349", () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    vi.restoreAllMocks();
  });

  it("posts the multipart + HMAC body the api-server's HttpConverterClient sends", async () => {
    // Capture exactly what `smokeOne` hands to fetch — same shape
    // the api-server's `http-converter-client.test.ts` pins on the
    // production client. If either side drifts, the captured fields
    // diverge and the equivalent test fails.
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return okGlbResponse();
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const URL_ = "https://converter.test.invalid/convert";
    const SECRET = "smoke-secret-fixture";
    const LAYER: DxfLayerKind = "terrain";

    const result = await smokeOne({
      url: URL_,
      sharedSecret: SECRET,
      layerKind: LAYER,
      // null fixtureDir => the script's builtin fallback DXF is
      // used. The test stays hermetic (no FS reads, no fixture
      // files to maintain).
      fixtureDir: null,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.fixtureSource).toBe("fallback");
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.glbHeaderLength).toBe(result.byteSize);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(URL_);
    expect(captured!.init.method).toBe("POST");

    const headers = captured!.init.headers as Record<string, string>;
    const requestId = headers["x-converter-request-id"];
    const signature = headers["x-converter-signature"];
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
    expect(typeof signature).toBe("string");

    // Pin the signature input. This is the contract bit most likely
    // to drift silently: if a future refactor changes the input to
    // `${layerKind}.${requestId}` (or drops the dot), every smoke
    // run against a correctly-configured converter would 401, but
    // a misconfigured smoke would still report green against a
    // broken converter that doesn't validate at all.
    const expected = createHmac("sha256", SECRET)
      .update(`${requestId}.${LAYER}`)
      .digest("hex");
    expect(signature).toBe(expected);

    // Multipart body — `dxf` and `layerKind` are the two fields the
    // production client sends. The Blob carries the DXF bytes; the
    // exact content type isn't part of the converter contract but
    // we check that something file-shaped landed under "dxf".
    expect(captured!.init.body).toBeInstanceOf(FormData);
    const body = captured!.init.body as FormData;
    expect(body.get("layerKind")).toBe(LAYER);
    const dxfPart = body.get("dxf");
    expect(dxfPart).toBeInstanceOf(Blob);
    expect((dxfPart as Blob).size).toBeGreaterThan(0);
  });

  it("reports a non-2xx response as a failed attempt without throwing", async () => {
    // Belt-and-braces: the script catches HTTP errors per layer and
    // reports them in the AttemptResult rather than propagating —
    // that's how `main()` is able to print a per-layer pass/fail
    // table instead of crashing on the first bad response. Pin
    // that branch so a refactor doesn't accidentally start
    // throwing.
    const fetchStub = vi.fn(async () => {
      return new Response("nope", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const result = await smokeOne({
      url: "https://converter.test.invalid/convert",
      sharedSecret: "x",
      layerKind: "wetland",
      fixtureDir: null,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("HTTP 401");
  });

  it("flags an unexpected content-type as a failed attempt", async () => {
    // Mirrors `HttpConverterClient`'s "wrong content-type =
    // contract drift" check. If the converter starts returning
    // text/plain on success, the SiteContextViewer would render an
    // empty viewport — catching it at smoke time is the whole
    // point of this script.
    const fetchStub = vi.fn(async () => {
      return new Response("not-a-glb", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const result = await smokeOne({
      url: "https://converter.test.invalid/convert",
      sharedSecret: "x",
      layerKind: "floodplain",
      fixtureDir: null,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unexpected content-type");
  });

  it("flags a 200 with malformed glb bytes via validateGlb", async () => {
    // 200 + correct content-type + bytes that don't pass
    // `validateGlb` is the most subtle drift mode: the converter
    // looks healthy at the HTTP layer but the bytes won't render.
    // The script must surface this as a failed attempt with a
    // `glb validation failed` error so the operator knows to look
    // at the converter, not the network.
    const fetchStub = vi.fn(async () => {
      return new Response(Buffer.from("not-a-glb-at-all-but-long"), {
        status: 200,
        headers: { "content-type": "model/gltf-binary" },
      });
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const result = await smokeOne({
      url: "https://converter.test.invalid/convert",
      sharedSecret: "x",
      layerKind: "neighbor-mass",
      fixtureDir: null,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("glb validation failed");
  });
});
