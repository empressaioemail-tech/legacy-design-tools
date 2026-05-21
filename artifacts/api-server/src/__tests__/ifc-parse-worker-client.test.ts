/**
 * QA-16 — IFC parse worker client.
 *
 * Exercises the dispatch logic in `lib/ifcParser/workerClient.ts` without
 * loading web-ifc's WASM: the worker factory is swapped for a fake so the
 * timeout, error mapping, crash handling, and serialization can be tested
 * deterministically and fast.
 *
 * The contract under test is the one that makes QA-16 load-bearing — a
 * hung, trapped, or OOM-killed parse must surface as a rejected promise
 * the route can map to clean JSON, never as a wedged event loop.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __setParseWorkerFactoryForTests,
  parseViaWorker,
  type ParseWorkerFactory,
} from "../lib/ifcParser/workerClient";
import type { ParseIfcResult, ParseWorkerMessage } from "../lib/ifcParser/types";

type Listener = (arg: never) => void;

/**
 * Stand-in for a `worker_threads` Worker. Satisfies the `ParseWorkerHandle`
 * shape the client depends on; the test drives it by calling `emit*`.
 */
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

  emitMessage(msg: ParseWorkerMessage): void {
    for (const cb of this.listeners.message) (cb as (m: ParseWorkerMessage) => void)(msg);
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
  const factory: ParseWorkerFactory = () => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  };
  __setParseWorkerFactoryForTests(factory);
  return created;
}

/** Flush enough microtasks for the serialized promise chain to spawn the
 * next worker, then return it. */
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

function makeResult(glb: number[]): ParseIfcResult {
  return {
    ifcVersion: "IFC4",
    entityCount: 1,
    entities: [
      {
        ifcGlobalId: "guid-1",
        ifcType: "IfcWall",
        label: "Wall 1",
        propertySet: null,
      },
    ],
    // The worker posts a Buffer; structured clone delivers a Uint8Array.
    // Simulate the post-clone shape so the client's re-wrap is exercised.
    glbBytes: new Uint8Array(glb) as unknown as Buffer,
  };
}

afterEach(() => {
  __setParseWorkerFactoryForTests(null);
});

describe("parseViaWorker — success", () => {
  it("resolves with the worker result and re-wraps glbBytes as a Buffer", async () => {
    const created = installFakeFactory();
    const promise = parseViaWorker({ bytes: new Uint8Array([1, 2, 3]) });

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: true, result: makeResult([10, 20, 30]) });

    const result = await promise;
    expect(result.ifcVersion).toBe("IFC4");
    expect(result.entityCount).toBe(1);
    expect(Buffer.isBuffer(result.glbBytes)).toBe(true);
    expect([...result.glbBytes]).toEqual([10, 20, 30]);
    // The one-shot worker is torn down once the parse settles.
    expect(worker.terminateCalls).toBe(1);
  });
});

describe("parseViaWorker — failure mapping", () => {
  it("rejects with the worker's error string on an ok:false message", async () => {
    const created = installFakeFactory();
    const promise = parseViaWorker({ bytes: new Uint8Array([1]) });

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: false, error: "memory access out of bounds" });

    await expect(promise).rejects.toThrow("memory access out of bounds");
    expect(worker.terminateCalls).toBe(1);
  });

  it("rejects and terminates the worker when the parse times out", async () => {
    const created = installFakeFactory();
    // Short timeout, worker never posts a message — simulates a hang.
    const promise = parseViaWorker({
      bytes: new Uint8Array([1]),
      timeoutMs: 40,
    });

    const worker = await nextWorker(created, 0);
    await expect(promise).rejects.toThrow(/timed out after 40ms/);
    // The hung worker is force-killed so it cannot leak a WASM heap.
    expect(worker.terminateCalls).toBe(1);
  });

  it("rejects when the worker exits before returning a result (OOM/crash)", async () => {
    const created = installFakeFactory();
    const promise = parseViaWorker({ bytes: new Uint8Array([1]) });

    const worker = await nextWorker(created, 0);
    worker.emitExit(1);

    await expect(promise).rejects.toThrow(/exited \(code 1\)/);
  });

  it("rejects with the error from a worker 'error' event", async () => {
    const created = installFakeFactory();
    const promise = parseViaWorker({ bytes: new Uint8Array([1]) });

    const worker = await nextWorker(created, 0);
    worker.emitError(new Error("worker boot failed"));

    await expect(promise).rejects.toThrow("worker boot failed");
  });

  it("ignores a late exit after a result has already been delivered", async () => {
    const created = installFakeFactory();
    const promise = parseViaWorker({ bytes: new Uint8Array([1]) });

    const worker = await nextWorker(created, 0);
    worker.emitMessage({ ok: true, result: makeResult([1]) });
    // Real workers exit 0 right after posting — this must not re-settle.
    worker.emitExit(0);

    await expect(promise).resolves.toBeDefined();
  });
});

describe("parseViaWorker — serialization", () => {
  it("runs parses one at a time: the next worker spawns only after the prior settles", async () => {
    const created = installFakeFactory();

    const p1 = parseViaWorker({ bytes: new Uint8Array([1]) });
    const p2 = parseViaWorker({ bytes: new Uint8Array([2]) });

    const worker0 = await nextWorker(created, 0);
    // Drain microtasks: worker 1 must NOT exist while worker 0 is in flight.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(created).toHaveLength(1);

    worker0.emitMessage({ ok: true, result: makeResult([1]) });
    await p1;

    const worker1 = await nextWorker(created, 1);
    expect(created).toHaveLength(2);
    worker1.emitMessage({ ok: true, result: makeResult([2]) });
    await p2;
  });

  it("a failed parse does not block the parse queued behind it", async () => {
    const created = installFakeFactory();

    const p1 = parseViaWorker({ bytes: new Uint8Array([1]) });
    const p2 = parseViaWorker({ bytes: new Uint8Array([2]) });

    const worker0 = await nextWorker(created, 0);
    worker0.emitExit(137); // OOM-style kill
    await expect(p1).rejects.toThrow();

    const worker1 = await nextWorker(created, 1);
    worker1.emitMessage({ ok: true, result: makeResult([9]) });
    await expect(p2).resolves.toBeDefined();
  });
});
