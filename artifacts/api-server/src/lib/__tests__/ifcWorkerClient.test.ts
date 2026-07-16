/**
 * IFC worker client tests — parcel-mesh/IFC Layer 2.
 *
 * The Python worker is NOT spawned here: `node:child_process` is mocked so
 * these tests assert the client's request/response marshalling in
 * isolation:
 *
 *   - it writes the correct JSON contract to the child's stdin (positions,
 *     indices, georef, provenance, confidence),
 *   - it parses a well-formed stdout result,
 *   - a non-zero exit code resolves to a structured `worker-exit` error,
 *   - a spawn error resolves to a structured `spawn-failed` error,
 *   - unparseable stdout resolves to `parse-failed`,
 *   - a hung child (never closes) resolves to `worker-timeout` and the
 *     child is killed.
 *
 * The mock is a minimal EventEmitter-backed fake ChildProcess exposing the
 * `.stdout`/`.stderr` streams, a writable `.stdin`, `.kill`, and the
 * `error`/`close` events the client listens for.
 */

import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// A fake child process the mocked spawn returns. Tests drive it by emitting
// stdout data + a close code (or an error). `stdinChunks` captures what the
// client wrote so we can assert the JSON contract.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinChunks: string[] = [];
  killed: string | null = null;
  stdin = {
    write: (chunk: string) => {
      this.stdinChunks.push(chunk);
    },
    end: () => {},
  };
  kill = (signal: string) => {
    this.killed = signal;
    return true;
  };
  fullStdin(): string {
    return this.stdinChunks.join("");
  }
}

// The single fake child the current test drives. Reset per test.
let currentChild: FakeChild;

const spawnMock = vi.fn(
  (_bin: string, _argv: string[]): FakeChild => currentChild,
);

vi.mock("node:child_process", () => ({
  spawn: (bin: string, argv: string[]) => spawnMock(bin, argv),
}));

// Import AFTER the mock is registered.
import { runIfcWorker, type IfcWorkerRequest } from "../ifcWorkerClient";

function baseRequest(): IfcWorkerRequest {
  return {
    positions: new Float32Array([0, 0, 450, 10, 0, 451, 0, 10, 452]),
    indices: new Uint32Array([0, 1, 2]),
    georefOrigin: {
      originLng: -97.31,
      originLat: 30.1,
      originHeightMeters: 0,
    },
    crsConvention: "local-enu-meters:origin-bbox-sw:equirectangular-coslat",
    provenance: {
      sourceCitation: "USGS 3DEP (https://example/exportImage)",
      coverageFraction: 0.98,
      demResolutionMeters: 10,
      demResolutionMeasured: false,
      collectionProxyDate: "2026-07-15T00:00:00Z",
      hasHoles: false,
    },
    confidence: {
      estimate: 0.72,
      provenance: "asserted",
      n: 0,
      intervalWidth: 1,
    },
  };
}

const OK_STDOUT = JSON.stringify({
  status: "ok",
  library: "ifcopenshell",
  libraryVersion: "0.7.0",
  schemaVersion: "IFC4",
  geometryPrimitive: "IfcTriangulatedFaceSet",
  georefCrs: "EPSG:4326",
  vertexCount: 3,
  triangleCount: 1,
  byteCount: 1234,
  ifcText: "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
});

describe("runIfcWorker marshalling", () => {
  beforeEach(() => {
    currentChild = new FakeChild();
    spawnMock.mockClear();
    // Force python3 on PATH for a stable spawn arg assertion.
    delete process.env.IFC_PYTHON;
    delete process.env.IFC_WORKER_PATH;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the correct JSON contract to stdin and parses a well-formed result", async () => {
    const req = baseRequest();
    const promise = runIfcWorker(req);

    // The client writes stdin synchronously in the spawn callback; drive the
    // child to completion on the next tick.
    currentChild.stdout.emit("data", Buffer.from(OK_STDOUT, "utf8"));
    currentChild.emit("close", 0);

    const result = await promise;
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.schemaVersion).toBe("IFC4");
    expect(result.geometryPrimitive).toBe("IfcTriangulatedFaceSet");
    expect(result.ifcText).toContain("ISO-10303-21");

    // Assert the JSON contract sent on stdin.
    const sent = JSON.parse(currentChild.fullStdin());
    // Typed arrays are marshalled to plain number[].
    expect(sent.positions).toEqual([0, 0, 450, 10, 0, 451, 0, 10, 452]);
    expect(sent.indices).toEqual([0, 1, 2]);
    expect(sent.georefOrigin).toEqual({
      originLng: -97.31,
      originLat: 30.1,
      originHeightMeters: 0,
    });
    expect(sent.crsConvention).toBe(req.crsConvention);
    expect(sent.provenance.sourceCitation).toBe(
      "USGS 3DEP (https://example/exportImage)",
    );
    expect(sent.provenance.coverageFraction).toBe(0.98);
    expect(sent.confidence.estimate).toBe(0.72);
    expect(sent.confidence.provenance).toBe("asserted");

    // spawn was called with python3 + a run.py path.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("python3");
    expect(argv[0]).toMatch(/ifc-worker[\\/]run\.py$/);
  });

  it("accepts plain number[] geometry and marshals it unchanged", async () => {
    const req = baseRequest();
    req.positions = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    req.indices = [0, 1, 2];
    const promise = runIfcWorker(req);
    currentChild.stdout.emit("data", Buffer.from(OK_STDOUT, "utf8"));
    currentChild.emit("close", 0);
    await promise;
    const sent = JSON.parse(currentChild.fullStdin());
    expect(sent.positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("a non-zero exit code resolves to a structured worker-exit error", async () => {
    const promise = runIfcWorker(baseRequest());
    currentChild.stderr.emit("data", Buffer.from("boom in python\n", "utf8"));
    currentChild.emit("close", 1);
    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.code).toBe("worker-exit");
    expect(result.message).toContain("boom in python");
  });

  it("a spawn error resolves to a structured spawn-failed error", async () => {
    const promise = runIfcWorker(baseRequest());
    currentChild.emit("error", new Error("spawn python3 ENOENT"));
    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.code).toBe("spawn-failed");
    expect(result.message).toContain("ENOENT");
  });

  it("unparseable stdout resolves to parse-failed", async () => {
    const promise = runIfcWorker(baseRequest());
    currentChild.stdout.emit("data", Buffer.from("not json at all", "utf8"));
    currentChild.emit("close", 0);
    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.code).toBe("parse-failed");
  });

  it("a hung child resolves to worker-timeout and the child is killed", async () => {
    vi.useFakeTimers();
    process.env.IFC_WORKER_TIMEOUT_MS = "1000";
    // The client reads IFC_WORKER_TIMEOUT_MS at call time (resolveTimeoutMs).
    const promise = runIfcWorker(baseRequest());
    // Never emit close/data — advance past the timeout.
    await vi.advanceTimersByTimeAsync(1001);
    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.code).toBe("worker-timeout");
    expect(currentChild.killed).toBe("SIGTERM");
    delete process.env.IFC_WORKER_TIMEOUT_MS;
  });

  it("respects IFC_PYTHON and IFC_WORKER_PATH overrides", async () => {
    process.env.IFC_PYTHON = "/opt/venv/bin/python";
    process.env.IFC_WORKER_PATH = "/custom/run.py";
    const promise = runIfcWorker(baseRequest());
    currentChild.stdout.emit("data", Buffer.from(OK_STDOUT, "utf8"));
    currentChild.emit("close", 0);
    await promise;
    const [bin, argv] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("/opt/venv/bin/python");
    expect(argv[0]).toBe("/custom/run.py");
    delete process.env.IFC_PYTHON;
    delete process.env.IFC_WORKER_PATH;
  });
});
