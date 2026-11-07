/**
 * Staging/production target selection for cad-ingest writes (P-169).
 */

import { describe, expect, it } from "vitest";
import {
  TARGET_ENV_MISSING,
  TARGET_UNKNOWN,
  assertKnownTarget,
  resolveTargetDatabaseUrl,
  type TargetEnvError,
} from "../targetEnv";

describe("cad-ingest target env selection", () => {
  it("reads STAGING_NEONDB_URL for target=staging", () => {
    const url = resolveTargetDatabaseUrl(
      { STAGING_NEONDB_URL: "postgres://staging/db" } as NodeJS.ProcessEnv,
      "staging",
    );
    expect(url).toBe("postgres://staging/db");
  });

  it("reads PRODUCTION_NEONDB_URL for target=production", () => {
    const url = resolveTargetDatabaseUrl(
      { PRODUCTION_NEONDB_URL: "postgres://prod/db" } as NodeJS.ProcessEnv,
      "production",
    );
    expect(url).toBe("postgres://prod/db");
  });

  it("never falls back across targets (falsifier: production var used for staging)", () => {
    try {
      resolveTargetDatabaseUrl(
        { PRODUCTION_NEONDB_URL: "postgres://prod/db" } as NodeJS.ProcessEnv,
        "staging",
      );
      expect.fail("expected TARGET_ENV_MISSING");
    } catch (err) {
      expect((err as TargetEnvError).code).toBe(TARGET_ENV_MISSING);
      expect((err as TargetEnvError).missing).toEqual(["STAGING_NEONDB_URL"]);
    }
  });

  it("refuses an unknown target", () => {
    expect(() => assertKnownTarget("prod")).toThrowError();
    try {
      assertKnownTarget("prod");
    } catch (err) {
      expect((err as TargetEnvError).code).toBe(TARGET_UNKNOWN);
    }
  });
});
