/**
 * Gate 4 / P4 (2026-10-07, coordinator fix): `directNeonUrl` derives a
 * Neon direct (unpooled) connection URL from a pooled one, so the
 * `cad_property` writers can open a connection `takeCadPropertyWriteLock`
 * will accept instead of refusing CAD_PROPERTY_LOCK_POOLED_CONNECTION
 * unconditionally.
 *
 * Every DSN here is a fabricated, non-functional example
 * (user/pass/host/db are all made up; no real credential appears anywhere
 * in this file).
 */
import { describe, expect, it } from "vitest";
import { directNeonUrl } from "../directNeonUrl";

describe("directNeonUrl", () => {
  it("strips -pooler from the first hostname label only, keeping user/password/port/db/params", () => {
    const pooled =
      "postgres://cad_writer:s3cr3t@ep-fancy-river-a1b2c3d4-pooler.us-east-2.aws.neon.tech:5432/cortex?sslmode=require";
    const direct = directNeonUrl(pooled);
    expect(direct).toBe(
      "postgres://cad_writer:s3cr3t@ep-fancy-river-a1b2c3d4.us-east-2.aws.neon.tech:5432/cortex?sslmode=require",
    );
  });

  it("returns an already-direct URL completely UNCHANGED (the exact input string)", () => {
    const direct =
      "postgres://cad_writer:s3cr3t@ep-fancy-river-a1b2c3d4.us-east-2.aws.neon.tech:5432/cortex?sslmode=require";
    expect(directNeonUrl(direct)).toBe(direct);
  });

  it("preserves multiple and percent-encoded query params", () => {
    const pooled =
      "postgres://u:p%40ss@ep-xxx-pooler.region.aws.neon.tech:5432/db?sslmode=require&options=-c%20default_transaction_read_only%3Doff&channel_binding=require";
    const direct = directNeonUrl(pooled);
    expect(direct).toBe(
      "postgres://u:p%40ss@ep-xxx.region.aws.neon.tech:5432/db?sslmode=require&options=-c%20default_transaction_read_only%3Doff&channel_binding=require",
    );
  });

  it("preserves a URL with no query params and no explicit port", () => {
    const pooled = "postgres://u:p@ep-xxx-pooler.region.aws.neon.tech/db";
    expect(directNeonUrl(pooled)).toBe("postgres://u:p@ep-xxx.region.aws.neon.tech/db");
  });

  it("only strips a -pooler suffix on the FIRST label — a (hypothetical) -pooler elsewhere in the host is untouched", () => {
    // Defends the "first label only" rule explicitly: Neon's own
    // convention never puts -pooler past the first label, but the
    // function must not do a blanket string replace that would also
    // catch a false match later in the hostname.
    const url = "postgres://u:p@ep-xxx.region-pooler.aws.neon.tech/db";
    expect(directNeonUrl(url)).toBe(url);
  });

  it("round-trips idempotently: deriving twice is the same as deriving once", () => {
    const pooled = "postgres://u:p@ep-xxx-pooler.region.aws.neon.tech:5432/db?sslmode=require";
    const once = directNeonUrl(pooled);
    const twice = directNeonUrl(once);
    expect(twice).toBe(once);
  });

  it("FALSIFIER: a naive whole-string replace (the exact bug this function must not have) would also corrupt a -pooler appearing in the password", () => {
    function naiveDirectUrl(dsn: string): string {
      return dsn.replace(/-pooler/g, "");
    }
    const withPoolerInPassword = "postgres://u:my-pooler-pass@ep-xxx-pooler.region.aws.neon.tech:5432/db";
    const naive = naiveDirectUrl(withPoolerInPassword);
    // The naive version mangles the password (loses "-pooler" from it too).
    expect(naive).toContain("my-pass");
    expect(naive).not.toContain("my-pooler-pass");
    // The real function only touches the hostname's first label.
    const real = directNeonUrl(withPoolerInPassword);
    expect(real).toContain("my-pooler-pass");
    expect(real).toContain("ep-xxx.region.aws.neon.tech");
  });
});
