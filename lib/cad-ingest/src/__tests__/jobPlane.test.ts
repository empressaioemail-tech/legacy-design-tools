/**
 * cad-ingest write gate on the DigitalOcean job plane (P-169, Phase 1 B0-3).
 */

import { describe, expect, it } from "vitest";
import { isClusterJobExecution, runIdentity } from "../jobPlane";

const CLUSTER = { KUBERNETES_SERVICE_HOST: "10.245.0.1", FACTORY_K8S_JOB: "ldt-cad-ingest-48053-abc12" };

describe("cad-ingest cluster job gate", () => {
  it("passes only with both cluster markers", () => {
    expect(isClusterJobExecution(CLUSTER)).toBe(true);
  });

  it("refuses a laptop, a non-Job pod, a hand-set job name, and a blank job name", () => {
    expect(isClusterJobExecution({})).toBe(false);
    expect(isClusterJobExecution({ KUBERNETES_SERVICE_HOST: "10.245.0.1" })).toBe(false);
    expect(isClusterJobExecution({ FACTORY_K8S_JOB: "ldt-cad-ingest-48053-abc12" })).toBe(false);
    expect(isClusterJobExecution({ ...CLUSTER, FACTORY_K8S_JOB: "  " })).toBe(false);
  });

  it("no longer accepts CLOUD_RUN_JOB (Google Cloud closed 2026-09-22)", () => {
    expect(isClusterJobExecution({ CLOUD_RUN_JOB: "ldt-cad-ingest" })).toBe(false);
  });

  it("records the Job name and uid on the run row", () => {
    expect(runIdentity({ ...CLUSTER, FACTORY_K8S_JOB_UID: "u-1" })).toEqual({
      job: "ldt-cad-ingest-48053-abc12",
      execution: "u-1",
    });
    expect(runIdentity(CLUSTER)).toEqual({ job: "ldt-cad-ingest-48053-abc12", execution: null });
    expect(runIdentity({ CLOUD_RUN_JOB: "x", CLOUD_RUN_EXECUTION: "y" })).toEqual({ job: null, execution: null });
  });
});
