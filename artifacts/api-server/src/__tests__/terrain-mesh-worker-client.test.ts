/**
 * async-terrain-job — terrain-mesh worker client.
 *
 * Exercises the dispatch logic in `lib/terrainMeshWorker/workerClient.ts`
 * without spawning a real `worker_threads` worker: the factory is swapped for a
 * fake so the success path, worker-reported failure, timeout kill, and
 * exit-without-result (OOM/crash) are tested deterministically and fast.
 *
 * The contract under test is what makes the async terrain fix load-bearing — the
 * CPU-heavy mesh build runs on a worker thread, and a hung or crashed build must
 * surface as a rejected promise the ingest treats as best-effort-skipped, never
 * as a wedged request event loop.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __setTerrainMeshWorkerFactoryForTests,
  buildTerrainMeshInWorker,
  type TerrainMeshWorkerFactory,
} from "../lib/terrainMeshWorker/workerClient";
import type {
  TerrainMeshWorkerInput,
  TerrainMeshWorkerMessage,
  TerrainMeshWorkerResult,
} from "../lib/terrainMeshWorker/types";

type Listener = (arg: never) => void;

class FakeWorker {
  readonly listeners: Record<"message" | "error" | "exit", Listener[]> = {
    message: [],
    error: [],
    exit: [],
  };
  terminateCalls = 0;

  on(event: "message" | "error" | "exit", cb: Listener): this {
    this.listeners[event].push(cb);
    return this;
  }
  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
  emitMessage(msg: TerrainMeshWorkerMessage): void {
    for (const cb of this.listeners.message)
      (cb as (m: TerrainMeshWorkerMessage) => void)(msg);
  }
  emitError(err: unknown): void {
    for (const cb of this.listeners.error) (cb as (e: unknown) => void)(err);
  }
  emitExit(code: number): void {
    for (const cb of this.listeners.exit) (cb as (c: number) => void)(code);
  }
}

function installFakeFactory(): FakeWorker[] {
  const created: FakeWorker[] = [];
  const factory: TerrainMeshWorkerFactory = () => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  };
  __setTerrainMeshWorkerFactoryForTests(factory);
  return created;
}

async function nextWorker(
  created: FakeWorker[],
  index: number,
): Promise<FakeWorker> {
  for (let i = 0; i < 100 && created.length <= index; i++) {
    await Promise.resolve();
  }
  const worker = created[index];
  if (!worker) throw new Error(`worker ${index} was never created`);
  return worker;
}

const sampleInput: TerrainMeshWorkerInput = {
  dem: { width: 2, height: 2, values: new Float32Array([1, 2, 3, 4]) },
  bbox: { westLng: -97, southLat: 30, eastLng: -96.99, northLat: 30.01 },
};

function makeResult(): TerrainMeshWorkerResult {
  return {
    glb: new Uint8Array([1, 2, 3]),
    positions: new Float32Array([0, 0, 1]),
    indices: new Uint32Array([0]),
    meta: {
      vertexCount: 1,
      triangleCount: 0,
      hasHoles: false,
      georefOrigin: {
        originLng: -97,
        originLat: 30,
        meanLatDegrees: 30.005,
        metersPerDegreeLat: 111320,
      },
      crsConvention:
        "local-enu-meters:origin-bbox-sw:equirectangular-coslat",
      minElevationMeters: 1,
      maxElevationMeters: 4,
    },
  };
}

afterEach(() => {
  __setTerrainMeshWorkerFactoryForTests(null);
});

describe("buildTerrainMeshInWorker", () => {
  it("resolves with the worker result on an ok message", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput);

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: true, result: makeResult() });

    const result = await promise;
    expect([...result.glb]).toEqual([1, 2, 3]);
    expect(result.meta.vertexCount).toBe(1);
  });

  it("rejects with the worker's error string on an ok:false message", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput);

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: false, error: "no fully-covered cell" });

    await expect(promise).rejects.toThrow("no fully-covered cell");
  });

  it("rejects and terminates the worker on timeout", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput, 40);

    const worker = await nextWorker(created, 0);
    await expect(promise).rejects.toThrow(/timed out after 40ms/);
    expect(worker.terminateCalls).toBe(1);
  });

  it("rejects when the worker exits before returning a result (OOM/crash)", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput);

    const worker = await nextWorker(created, 0);
    worker.emitExit(1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("rejects with the error from a worker 'error' event", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput);

    const worker = await nextWorker(created, 0);
    worker.emitError(new Error("worker boot failed"));

    await expect(promise).rejects.toThrow("worker boot failed");
  });

  it("ignores a late exit after a result was already delivered", async () => {
    const created = installFakeFactory();
    const promise = buildTerrainMeshInWorker(sampleInput);

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: true, result: makeResult() });
    worker.emitExit(0);

    await expect(promise).resolves.toBeDefined();
  });
});
