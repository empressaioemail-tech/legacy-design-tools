/**
 * Smoke-test the live Cloud Run DXF→glb converter end-to-end.
 *
 * Per-layer-variant verification of the contract the api-server's
 * `HttpConverterClient` speaks (Task #160 and Task #113). For each of
 * the seven Spec 52 §2 materializable layer kinds the script:
 *
 *   1. Loads a fixture DXF (per-layer file under `--fixture-dir`,
 *      falling back to a minimal builtin DXF with a warning).
 *   2. POSTs it to `CONVERTER_URL` with the same multipart shape and
 *      `x-converter-request-id` / `x-converter-signature` headers the
 *      api-server sends. The signature input is `requestId.layerKind`
 *      and is HMAC-SHA256 over `CONVERTER_SHARED_SECRET`.
 *   3. Validates the response: HTTP 200, content-type
 *      `model/gltf-binary`, leading magic `glTF`, version 2,
 *      header `length` field equals the byte length we received,
 *      first chunk is `JSON` and the JSON parses, second chunk
 *      (if present) is `BIN\0`.
 *   4. Prints a pass / fail line per layer kind, then exits non-zero
 *      if any layer kind failed.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run smoke:converter
 *   pnpm --filter @workspace/scripts run smoke:converter -- \
 *     --fixture-dir ./fixtures/dxf
 *
 * Env vars (required):
 *   CONVERTER_URL              — POST endpoint, e.g.
 *                                  https://dxf-converter-...run.app/convert
 *   CONVERTER_SHARED_SECRET    — HMAC signing key shared with the
 *                                  Cloud Run service.
 *
 * Why this lives in `scripts/` rather than a vitest test: the
 * api-server vitest suite stubs the converter at the module level so
 * unit tests stay hermetic. This script is the deliberate
 * non-hermetic counterpart — operators run it after a deploy or a
 * converter-side schema change to confirm parity against the real
 * service before flipping `DXF_CONVERTER_MODE=http` for users.
 *
 * Workspace rules forbid `scripts` from importing
 * `artifacts/api-server`, so the multipart + HMAC + glTF parsing
 * logic is mirrored inline rather than shared via import. The
 * api-server-side `HttpConverterClient` is the source of truth — if
 * the contract there changes (e.g. signature input, required
 * fields), update both this script and the client together.
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Pinned to the Spec 52 §2 materializable layer kinds. Kept in sync
 * with `DXF_LAYER_KINDS` in
 * `artifacts/api-server/src/lib/converterClient.ts`. A drift between
 * the two would mean either the api-server is sending a layer kind
 * the converter doesn't know about, or this script is failing to
 * smoke a kind users can upload — both are bugs.
 */
const DXF_LAYER_KINDS = [
  "terrain",
  "property-line",
  "setback-plane",
  "buildable-envelope",
  "floodplain",
  "wetland",
  "neighbor-mass",
] as const;
type DxfLayerKind = (typeof DXF_LAYER_KINDS)[number];

interface CliOptions {
  fixtureDir: string | null;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  let fixtureDir: string | null = null;
  let timeoutMs = 30_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--fixture-dir") {
      fixtureDir = argv[++i] ?? null;
    } else if (a.startsWith("--fixture-dir=")) {
      fixtureDir = a.slice("--fixture-dir=".length);
    } else if (a === "--timeout-ms") {
      timeoutMs = Number(argv[++i] ?? "30000");
    } else if (a.startsWith("--timeout-ms=")) {
      timeoutMs = Number(a.slice("--timeout-ms=".length));
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`smoke-converter: unknown flag "${a}"`);
      printHelp();
      process.exit(2);
    }
  }
  return { fixtureDir, timeoutMs };
}

function printHelp(): void {
  console.log(`Usage: smoke-converter [--fixture-dir <dir>] [--timeout-ms <ms>]

Required env:
  CONVERTER_URL            POST endpoint of the Cloud Run converter.
  CONVERTER_SHARED_SECRET  HMAC signing key shared with the converter.

Optional flags:
  --fixture-dir <dir>      Directory containing <layerKind>.dxf fixtures.
                            Missing files fall back to a tiny builtin DXF
                            with a warning.
  --timeout-ms <ms>        Per-attempt timeout. Default 30000.
`);
}

/**
 * Minimal valid AutoCAD R12 DXF (header + EOF). Only used as a
 * fallback when a per-layer fixture file is not present. Real
 * converters may reject this for layer kinds whose conversion
 * pipeline expects specific entities (e.g. `terrain` typically
 * needs a TIN), in which case the operator should drop a curated
 * fixture into `--fixture-dir` and re-run.
 */
const FALLBACK_DXF = [
  "0",
  "SECTION",
  "2",
  "HEADER",
  "0",
  "ENDSEC",
  "0",
  "SECTION",
  "2",
  "ENTITIES",
  "0",
  "ENDSEC",
  "0",
  "EOF",
  "",
].join("\n");

interface AttemptResult {
  layerKind: DxfLayerKind;
  ok: boolean;
  durationMs: number;
  status?: number;
  byteSize?: number;
  glbHeaderLength?: number;
  fixtureSource: "file" | "fallback";
  error?: string;
}

async function loadFixture(args: {
  layerKind: DxfLayerKind;
  fixtureDir: string | null;
}): Promise<{ bytes: Buffer; source: "file" | "fallback"; filename: string }> {
  if (args.fixtureDir) {
    const candidate = path.join(args.fixtureDir, `${args.layerKind}.dxf`);
    if (existsSync(candidate)) {
      const bytes = await readFile(candidate);
      return { bytes, source: "file", filename: `${args.layerKind}.dxf` };
    }
  }
  return {
    bytes: Buffer.from(FALLBACK_DXF, "utf8"),
    source: "fallback",
    filename: `${args.layerKind}-fallback.dxf`,
  };
}

/**
 * Validate that `bytes` is a binary glTF 2.0 envelope. Mirrors the
 * checks `SiteContextViewer`'s GLTFLoader will perform once the
 * api-server stores these bytes — catching contract drift here
 * means the viewer never has to render a 404 in production.
 */
function validateGlb(bytes: Buffer): { ok: true; length: number } | {
  ok: false;
  reason: string;
} {
  if (bytes.length < 12) return { ok: false, reason: "shorter than glTF header (12 bytes)" };
  const magic = bytes.subarray(0, 4).toString("ascii");
  if (magic !== "glTF") return { ok: false, reason: `magic was "${magic}", expected "glTF"` };
  const version = bytes.readUInt32LE(4);
  if (version !== 2) return { ok: false, reason: `version was ${version}, expected 2` };
  const length = bytes.readUInt32LE(8);
  if (length !== bytes.length) {
    return {
      ok: false,
      reason: `header length ${length} != actual byte length ${bytes.length}`,
    };
  }
  // First chunk must be JSON (`0x4e4f534a`).
  if (bytes.length < 20) return { ok: false, reason: "missing JSON chunk header" };
  const jsonLen = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) {
    return { ok: false, reason: `first chunk type was 0x${jsonType.toString(16)}, expected JSON` };
  }
  const jsonEnd = 20 + jsonLen;
  if (jsonEnd > bytes.length) {
    return { ok: false, reason: "JSON chunk overruns buffer" };
  }
  try {
    JSON.parse(bytes.subarray(20, jsonEnd).toString("utf8"));
  } catch (err) {
    return { ok: false, reason: `JSON chunk did not parse: ${(err as Error).message}` };
  }
  // Second chunk, if present, must be BIN\0 (`0x004e4942`).
  if (bytes.length > jsonEnd) {
    if (bytes.length < jsonEnd + 8) {
      return { ok: false, reason: "trailing bytes too short for a BIN chunk header" };
    }
    const binType = bytes.readUInt32LE(jsonEnd + 4);
    if (binType !== 0x004e4942) {
      return { ok: false, reason: `second chunk type was 0x${binType.toString(16)}, expected BIN` };
    }
  }
  return { ok: true, length };
}

async function smokeOne(args: {
  url: string;
  sharedSecret: string;
  layerKind: DxfLayerKind;
  fixtureDir: string | null;
  timeoutMs: number;
}): Promise<AttemptResult> {
  const started = Date.now();
  const fixture = await loadFixture({
    layerKind: args.layerKind,
    fixtureDir: args.fixtureDir,
  });
  const requestId = randomUUID();
  const signature = createHmac("sha256", args.sharedSecret)
    .update(`${requestId}.${args.layerKind}`)
    .digest("hex");

  const form = new FormData();
  form.append(
    "dxf",
    new Blob([new Uint8Array(fixture.bytes)], { type: "application/dxf" }),
    fixture.filename,
  );
  form.append("layerKind", args.layerKind);

  let response: Response;
  try {
    response = await fetch(args.url, {
      method: "POST",
      headers: {
        "x-converter-request-id": requestId,
        "x-converter-signature": signature,
      },
      body: form,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    return {
      layerKind: args.layerKind,
      ok: false,
      durationMs: Date.now() - started,
      fixtureSource: fixture.source,
      error: `network error: ${(err as Error).message}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      layerKind: args.layerKind,
      ok: false,
      durationMs: Date.now() - started,
      status: response.status,
      fixtureSource: fixture.source,
      error: `HTTP ${response.status}: ${body.slice(0, 200) || "(no body)"}`,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("model/gltf-binary")) {
    return {
      layerKind: args.layerKind,
      ok: false,
      durationMs: Date.now() - started,
      status: response.status,
      fixtureSource: fixture.source,
      error: `unexpected content-type: ${contentType || "(missing)"}`,
    };
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const validation = validateGlb(buf);
  if (!validation.ok) {
    return {
      layerKind: args.layerKind,
      ok: false,
      durationMs: Date.now() - started,
      status: response.status,
      byteSize: buf.length,
      fixtureSource: fixture.source,
      error: `glb validation failed: ${validation.reason}`,
    };
  }

  return {
    layerKind: args.layerKind,
    ok: true,
    durationMs: Date.now() - started,
    status: response.status,
    byteSize: buf.length,
    glbHeaderLength: validation.length,
    fixtureSource: fixture.source,
  };
}

export async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.CONVERTER_URL;
  const sharedSecret = process.env.CONVERTER_SHARED_SECRET;
  if (!url || !sharedSecret) {
    console.error(
      "smoke-converter: CONVERTER_URL and CONVERTER_SHARED_SECRET must both be set.",
    );
    process.exit(2);
  }

  console.log(`smoke-converter: targeting ${url}`);
  if (opts.fixtureDir) {
    console.log(`smoke-converter: fixture dir = ${opts.fixtureDir}`);
  } else {
    console.log(
      "smoke-converter: no --fixture-dir; every layer kind will use the builtin fallback DXF.",
    );
  }
  console.log("");

  const results: AttemptResult[] = [];
  for (const layerKind of DXF_LAYER_KINDS) {
    const result = await smokeOne({
      url,
      sharedSecret,
      layerKind,
      fixtureDir: opts.fixtureDir,
      timeoutMs: opts.timeoutMs,
    });
    results.push(result);
    const tag = result.ok ? "PASS" : "FAIL";
    const fixtureNote =
      result.fixtureSource === "fallback" ? " (fallback DXF)" : "";
    if (result.ok) {
      console.log(
        `${tag}  ${layerKind.padEnd(20)} ${result.durationMs} ms · ${result.byteSize} bytes${fixtureNote}`,
      );
    } else {
      console.log(
        `${tag}  ${layerKind.padEnd(20)} ${result.durationMs} ms${fixtureNote}\n      ${result.error}`,
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    `smoke-converter: ${results.length - failed.length}/${results.length} layer kinds passed`,
  );
  if (failed.length > 0) {
    console.error(
      `smoke-converter: failures in [${failed.map((r) => r.layerKind).join(", ")}]`,
    );
    process.exit(1);
  }
}

// Only invoke `main()` when this module is executed as the script's
// entrypoint (i.e. `tsx smokeConverter.ts`). Without this guard,
// merely `import`-ing the module — as a fixture-led test would do
// to reach `validateGlb` / `parseArgs` / `main` by name — would run
// the CLI, hit `process.exit()` inside Vitest (e.g. on the missing
// `CONVERTER_URL` env-var path), and abort the test runner.
//
// Mirrors the regex check used in `sweepOrphanAvatars.ts` and
// `backfillSheetCreatedEvents.ts` so all three one-shot scripts
// share one pattern.
const invokedAsEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /smokeConverter\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (invokedAsEntrypoint) {
  main().catch((err) => {
    console.error("smoke-converter: unhandled error", err);
    process.exit(1);
  });
}
