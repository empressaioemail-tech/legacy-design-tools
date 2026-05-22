import { describe, it, expect } from "vitest";
import {
  describeCorpus,
  matchJurisdiction,
  normalizeJurisdiction,
  resolveJurisdictionContext,
} from "./jurisdiction";
import { makeJurisdiction } from "../__fixtures__/jurisdiction";

describe("normalizeJurisdiction", () => {
  it("folds case and strips non-alphanumerics", () => {
    expect(normalizeJurisdiction("Grand County")).toBe("grandcounty");
    expect(normalizeJurisdiction("grand-county")).toBe("grandcounty");
    expect(normalizeJurisdiction("Bastrop  UDC")).toBe("bastropudc");
  });
});

describe("resolveJurisdictionContext", () => {
  it("returns empty context when no engagement is selected", () => {
    const ctx = resolveJurisdictionContext(null, null);
    expect(ctx.engagementLabel).toBeNull();
    expect(ctx.submissionLabel).toBeNull();
    expect(ctx.snapshotDiverged).toBe(false);
  });

  it("reads the engagement's jurisdiction", () => {
    const ctx = resolveJurisdictionContext(
      { jurisdiction: "Grand County" },
      null,
    );
    expect(ctx.engagementLabel).toBe("Grand County");
    expect(ctx.snapshotDiverged).toBe(false);
  });

  it("treats a blank jurisdiction label as none recorded", () => {
    const ctx = resolveJurisdictionContext({ jurisdiction: "   " }, null);
    expect(ctx.engagementLabel).toBeNull();
  });

  it("does not flag divergence when the snapshot matches", () => {
    const ctx = resolveJurisdictionContext(
      { jurisdiction: "Grand County" },
      { jurisdiction: "grand county" },
    );
    expect(ctx.snapshotDiverged).toBe(false);
  });

  it("flags divergence when the submission's filed jurisdiction differs", () => {
    const ctx = resolveJurisdictionContext(
      { jurisdiction: "Bastrop UDC" },
      { jurisdiction: "Grand County" },
    );
    expect(ctx.engagementLabel).toBe("Bastrop UDC");
    expect(ctx.submissionLabel).toBe("Grand County");
    expect(ctx.snapshotDiverged).toBe(true);
  });

  it("does not flag divergence when the submission has no snapshot", () => {
    const ctx = resolveJurisdictionContext(
      { jurisdiction: "Bastrop UDC" },
      { jurisdiction: null },
    );
    expect(ctx.snapshotDiverged).toBe(false);
  });
});

describe("matchJurisdiction", () => {
  const corpora = [
    makeJurisdiction({ key: "grand-county", displayName: "Grand County" }),
    makeJurisdiction({ key: "bastrop-udc", displayName: "Bastrop UDC" }),
  ];

  it("matches on the display name", () => {
    expect(matchJurisdiction("Grand County", corpora)?.key).toBe(
      "grand-county",
    );
  });

  it("matches on the corpus key", () => {
    expect(matchJurisdiction("bastrop-udc", corpora)?.key).toBe("bastrop-udc");
  });

  it("returns null when nothing lines up", () => {
    expect(matchJurisdiction("Travis County", corpora)).toBeNull();
  });

  it("returns null for an absent or blank label", () => {
    expect(matchJurisdiction(null, corpora)).toBeNull();
    expect(matchJurisdiction("   ", corpora)).toBeNull();
  });
});

describe("describeCorpus", () => {
  it("describes a populated corpus with a plural noun", () => {
    expect(describeCorpus(makeJurisdiction({ atomCount: 1240 }))).toContain(
      "indexed code atoms",
    );
  });

  it("uses the singular noun for a one-atom corpus", () => {
    expect(describeCorpus(makeJurisdiction({ atomCount: 1 }))).toBe(
      "1 indexed code atom",
    );
  });
});
