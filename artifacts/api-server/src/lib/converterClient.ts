/**
 * DXF→glb converter client. Picks an implementation off
 * `DXF_CONVERTER_MODE`:
 *   - `mock` (default): returns a hand-built glb so dev/CI runs
 *     without a live converter.
 *   - `http`: POSTs to `CONVERTER_URL` with an HMAC-SHA256 signature
 *     derived from `CONVERTER_SHARED_SECRET` per the Task #113
 *     contract. Throws at first use if either env var is missing.
 */

import { createHmac, randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * The seven Spec 52 §2 materializable layer kinds. The upload route
 * uses this set to pair `layerKind` with `upload.kind === "dxf"`.
 */
export const DXF_LAYER_KINDS = [
  "terrain",
  "property-line",
  "setback-plane",
  "buildable-envelope",
  "floodplain",
  "wetland",
  "neighbor-mass",
] as const;

export type DxfLayerKind = (typeof DXF_LAYER_KINDS)[number];

const DXF_LAYER_KIND_SET: ReadonlySet<string> = new Set(DXF_LAYER_KINDS);

export function isDxfLayerKind(s: string): s is DxfLayerKind {
  return DXF_LAYER_KIND_SET.has(s);
}

export interface ConvertDxfRequest {
  /** Raw DXF bytes pulled from object storage. */
  dxfBytes: Buffer;
  /** One of the seven Spec 52 §2 layer kinds. */
  layerKind: DxfLayerKind;
  /** Original filename for converter-side logs. */
  originalFilename: string;
}

export interface ConvertDxfResult {
  /** glb bytes (`model/gltf-binary`). */
  glbBytes: Buffer;
  /** Request id minted by the client. */
  requestId: string;
}

/**
 * Surfaced as the `conversionError` column verbatim. `code` is a
 * coarse bucket the UI can branch on ("retry?" vs "re-export?"); the
 * `message` is the human-readable blurb the status pill renders.
 */
export class ConverterError extends Error {
  constructor(
    public readonly code:
      | "converter_unavailable"
      | "converter_timeout"
      | "converter_rejected"
      | "converter_invalid_response"
      | "converter_unknown",
    message: string,
  ) {
    super(message);
    this.name = "ConverterError";
    Object.setPrototypeOf(this, ConverterError.prototype);
  }
}

export interface ConverterClient {
  convert(req: ConvertDxfRequest): Promise<ConvertDxfResult>;
}

/**
 * Hermetic stand-in for the Cloud Run converter. Returns a tiny but
 * valid one-triangle glb so the viewer's GLTFLoader resolves.
 */
export interface MockConverterClientOptions {
  /** When true, conversion always throws `converter_rejected`. */
  alwaysFail?: boolean;
  /** Pin the request id (otherwise minted per call via randomUUID). */
  fixedRequestId?: string;
}

export class MockConverterClient implements ConverterClient {
  constructor(private readonly opts: MockConverterClientOptions = {}) {}

  async convert(req: ConvertDxfRequest): Promise<ConvertDxfResult> {
    if (this.opts.alwaysFail) {
      throw new ConverterError(
        "converter_rejected",
        `MockConverterClient: forced failure (layerKind=${req.layerKind})`,
      );
    }
    return {
      glbBytes: buildMockGlb(req.layerKind),
      requestId: this.opts.fixedRequestId ?? randomUUID(),
    };
  }
}

/** Produces a one-triangle binary glTF 2.0 (header + JSON + BIN chunk). */
function buildMockGlb(layerKind: DxfLayerKind): Buffer {
  // 3 vertices in the XZ plane (vec3 float32, 36 bytes), no indices.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: {
      version: "2.0",
      generator: `MockConverterClient (${layerKind})`,
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, mode: 4 }],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        max: [1, 0, 1],
        min: [0, 0, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  while (jsonBytes.length % 4 !== 0) {
    jsonBytes = Buffer.concat([jsonBytes, Buffer.from([0x20])]);
  }
  let binBytes = bin;
  while (binBytes.length % 4 !== 0) {
    binBytes = Buffer.concat([binBytes, Buffer.from([0])]);
  }
  const totalLen = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = Buffer.alloc(totalLen);
  out.write("glTF", 0, "ascii");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  jsonBytes.copy(out, 20);
  const binOffset = 20 + jsonBytes.length;
  out.writeUInt32LE(binBytes.length, binOffset);
  out.writeUInt32LE(0x004e4942, binOffset + 4); // "BIN\0"
  binBytes.copy(out, binOffset + 8);
  return out;
}

/**
 * Production HTTP client. Posts to `CONVERTER_URL` with a multipart
 * body and an HMAC-SHA256 signature in `x-converter-signature`
 * (signature input is `requestId.layerKind`, matching the Task #113
 * contract). Times out after 30 s.
 */
export interface HttpConverterClientOptions {
  url: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpConverterClient implements ConverterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpConverterClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async convert(req: ConvertDxfRequest): Promise<ConvertDxfResult> {
    const requestId = randomUUID();
    const signature = createHmac("sha256", this.opts.sharedSecret)
      .update(`${requestId}.${req.layerKind}`)
      .digest("hex");

    // Use the global FormData (Node 18+) so multipart works through
    // undici without an external dep. Blob is also a Node global
    // since 18.
    const form = new FormData();
    form.append(
      "dxf",
      new Blob([new Uint8Array(req.dxfBytes)], {
        type: "application/dxf",
      }),
      req.originalFilename || "upload.dxf",
    );
    form.append("layerKind", req.layerKind);

    let response: Response;
    try {
      response = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: {
          "x-converter-request-id": requestId,
          "x-converter-signature": signature,
        },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isAbort =
        (err as { name?: string } | null)?.name === "TimeoutError" ||
        (err as { name?: string } | null)?.name === "AbortError";
      if (isAbort) {
        throw new ConverterError(
          "converter_timeout",
          `Converter did not respond within ${this.timeoutMs} ms`,
        );
      }
      throw new ConverterError(
        "converter_unavailable",
        `Converter request failed: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ConverterError(
        "converter_rejected",
        `Converter returned ${response.status}: ${body.slice(0, 200) || "(no body)"}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("model/gltf-binary")) {
      throw new ConverterError(
        "converter_invalid_response",
        `Converter returned unexpected content-type: ${contentType || "(missing)"}`,
      );
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength === 0) {
      throw new ConverterError(
        "converter_invalid_response",
        "Converter returned an empty body",
      );
    }
    return {
      glbBytes: Buffer.from(arrayBuf),
      requestId,
    };
  }
}

/** Lazily-resolved process-wide singleton; tests can override via setConverterClient. */
let cached: ConverterClient | null = null;
let cachedFromEnv = true;

export function getConverterClient(): ConverterClient {
  if (cached) return cached;
  cached = buildFromEnv();
  cachedFromEnv = true;
  return cached;
}

export function setConverterClient(client: ConverterClient | null): void {
  cached = client;
  cachedFromEnv = client === null;
}

function buildFromEnv(): ConverterClient {
  const mode = (process.env.DXF_CONVERTER_MODE ?? "mock").toLowerCase();
  if (mode === "http") {
    const url = process.env.CONVERTER_URL;
    const secret = process.env.CONVERTER_SHARED_SECRET;
    if (!url || !secret) {
      throw new Error(
        "DXF_CONVERTER_MODE=http requires CONVERTER_URL and CONVERTER_SHARED_SECRET to be set",
      );
    }
    logger.info({ url, mode: "http" }, "DXF converter client wired in HTTP mode");
    return new HttpConverterClient({ url, sharedSecret: secret });
  }
  if (mode !== "mock") {
    logger.warn(
      { mode },
      "DXF_CONVERTER_MODE is not 'mock' or 'http' — falling back to mock client",
    );
  }
  logger.info({ mode: "mock" }, "DXF converter client wired in mock mode");
  return new MockConverterClient();
}

/**
 * Boot-time fail-fast: when DXF_CONVERTER_MODE=http, refuse to start
 * unless CONVERTER_URL and CONVERTER_SHARED_SECRET are both set.
 * Called from the server entrypoint so misconfiguration surfaces at
 * boot rather than at the first conversion attempt.
 */
export function validateConverterEnvAtBoot(): void {
  const mode = (process.env.DXF_CONVERTER_MODE ?? "mock").toLowerCase();
  if (mode !== "http") return;
  const url = process.env.CONVERTER_URL;
  const secret = process.env.CONVERTER_SHARED_SECRET;
  if (!url || !secret) {
    throw new Error(
      "DXF_CONVERTER_MODE=http requires CONVERTER_URL and CONVERTER_SHARED_SECRET to be set",
    );
  }
}

/** Test-only: tells you whether the cached client came from the env factory. */
export function __converterClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}
