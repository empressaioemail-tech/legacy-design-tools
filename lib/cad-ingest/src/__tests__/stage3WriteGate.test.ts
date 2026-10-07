/**
 * Stage-3 loader cluster-job write gate (2026-10-07 ruling). LDT PR #793 gated
 * cad-ingest's own cli.ts; this closes the same gap on the three loaders
 * about to become dispatchable DOKS Jobs (factory-address-ingest,
 * factory-txgio-ingest, factory-zoning-stamp), none of which checked
 * anything before writing at LDT e41c68f3.
 *
 * Each gate function reuses jobPlane.ts's `isClusterJobExecution` (already
 * covered generically in jobPlane.test.ts); these tests exercise each
 * loader's OWN write-gate wiring, because jobPlane.test.ts alone would not
 * fail if a given loader stopped calling the gate.
 */

import { describe, expect, it } from "vitest";
import { addressIngestWriteGate } from "../address/cli";
import { txgioIngestWriteGate } from "../txgio/cli";
import { zoningStampWriteGate } from "../txgio/zoning-cli";
import { LAPTOP_WRITE_FROZEN } from "../jobPlane";

const CLUSTER_JOB_ENV = {
  KUBERNETES_SERVICE_HOST: "10.245.0.1",
  FACTORY_K8S_JOB: "factory-address-ingest-test",
};

const gates = [
  { name: "address-ingest", gate: addressIngestWriteGate },
  { name: "txgio-ingest", gate: txgioIngestWriteGate },
  { name: "zoning-stamp", gate: zoningStampWriteGate },
];

describe.each(gates)("$name write gate", ({ gate }) => {
  it("is a no-op for a non-write run (e.g. --dry-run), even on a laptop", () => {
    expect(gate(false, {})).toBeNull();
    expect(gate(false, CLUSTER_JOB_ENV)).toBeNull();
  });

  it("refuses a write run outside a cluster job (laptop / no env at all)", () => {
    const refusal = gate(true, {});
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(LAPTOP_WRITE_FROZEN);
    expect(refusal?.message).toMatch(/cluster Job/);
  });

  it("proceeds (null) for a write run inside a cluster job", () => {
    expect(gate(true, CLUSTER_JOB_ENV)).toBeNull();
  });

  it("CLOUD_RUN_JOB alone (the retired Google Cloud marker) still refuses", () => {
    const refusal = gate(true, { CLOUD_RUN_JOB: "ldt-cad-ingest" });
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(LAPTOP_WRITE_FROZEN);
  });

  it("refuses when only one of the two cluster markers is set", () => {
    expect(gate(true, { KUBERNETES_SERVICE_HOST: "10.245.0.1" })).not.toBeNull();
    expect(gate(true, { FACTORY_K8S_JOB: "factory-address-ingest-test" })).not.toBeNull();
  });

  it("defaults to process.env when no env is passed", () => {
    // Exercises the default-parameter branch so the production call shape
    // (gate(isWriteRun) with no second argument, as main() calls it) is
    // actually covered, not just the explicit-env overload used above.
    const before = { ...process.env };
    try {
      delete process.env.KUBERNETES_SERVICE_HOST;
      delete process.env.FACTORY_K8S_JOB;
      expect(gate(true)).not.toBeNull();
      process.env.KUBERNETES_SERVICE_HOST = "10.245.0.1";
      process.env.FACTORY_K8S_JOB = "factory-address-ingest-test";
      expect(gate(true)).toBeNull();
    } finally {
      process.env = before;
    }
  });
});
