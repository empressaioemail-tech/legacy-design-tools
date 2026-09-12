/**
 * Per-CAD bulk-source registry tests (Rail B).
 */

import { describe, expect, it } from "vitest";
import {
  CAD_BULK_SOURCES,
  DCAD_CERTIFIED_OPEN_FETCH_URL,
  PacsEntryNotFoundError,
  resolveCadBulkSource,
  resolvePacsEntries,
  resolvePacsExportDeclaration,
} from "../sources";

describe("CAD bulk-source registry", () => {
  it("resolves WCAD (48491) as an open-fetch source with the four Orion roles", () => {
    const src = resolveCadBulkSource("48491");
    expect(src?.mode).toBe("open-fetch");
    if (src?.mode !== "open-fetch") throw new Error("expected open-fetch");

    const roles = src.datasets.map((d) => d.kind).sort();
    expect(roles).toEqual(["land", "owner", "property", "segment"]);

    for (const ds of src.datasets) {
      expect(ds.url).toMatch(
        /^https:\/\/data\.wcad\.org\/api\/views\/[a-z0-9-]+\/rows\.csv\?accessType=DOWNLOAD$/,
      );
    }
    expect(src.datasets.some((d) => d.kind === "property")).toBe(true);
  });

  it("resolves Hays (48209) as a manual-download source with operator instructions", () => {
    const src = resolveCadBulkSource("48209");
    expect(src?.mode).toBe("manual-download");
    if (src?.mode !== "manual-download") throw new Error("expected manual");
    expect(src.page).toContain("hayscad.com");
    expect(src.instructions).toMatch(/--county=48209/);
    expect(src.instructions).toMatch(/--file=/);
  });

  it("resolves Tarrant (48439) as open-fetch-zip residential PropertyData", () => {
    const src = resolveCadBulkSource("48439");
    expect(src?.mode).toBe("open-fetch-zip");
    if (src?.mode !== "open-fetch-zip") throw new Error("expected zip");
    expect(src.url).toContain("PropertyData(Delimited)_R.ZIP");
    expect(src.label).toBe("PropertyData(Delimited)_R.ZIP");
  });

  it("resolves Dallas (48113) as open-fetch-zip DCAD certified", () => {
    const src = resolveCadBulkSource("48113");
    expect(src?.mode).toBe("open-fetch-zip");
    if (src?.mode !== "open-fetch-zip") throw new Error("expected zip");
    expect(src.url).toBe(DCAD_CERTIFIED_OPEN_FETCH_URL);
    expect(src.label).toContain("DCAD2026_CERTIFIED");
  });

  it("returns undefined for counties with no registered bulk source", () => {
    expect(resolveCadBulkSource("48453")).toBeUndefined();
    expect(resolveCadBulkSource("99999")).toBeUndefined();
  });

  it("tolerates surrounding whitespace on the fips key", () => {
    expect(resolveCadBulkSource(" 48491 ")?.mode).toBe("open-fetch");
  });

  it("registry includes corridor + bulk_primary counties", () => {
    expect(Object.keys(CAD_BULK_SOURCES).sort()).toEqual([
      "48113",
      "48209",
      "48439",
      "48491",
    ]);
  });
});

describe("PACS export entry declaration (P-169 / A-132)", () => {
  it("declares TCAD (48453) as PROP.TXT / IMP_DET.TXT", () => {
    const declaration = resolvePacsExportDeclaration("48453");
    expect(declaration).toEqual({
      infoEntry: "PROP.TXT",
      improvementDetailEntry: "IMP_DET.TXT",
    });
  });

  it("resolves TCAD's declared entries from a real-shaped file list, case-insensitively", () => {
    const files = [
      "/tmp/work/PROP.TXT",
      "/tmp/work/IMP_DET.TXT",
      "/tmp/work/IMP_INFO.TXT",
      "/tmp/work/LAND_DET.TXT",
      "/tmp/work/IMP_ATR.TXT",
    ];
    const resolved = resolvePacsEntries(files, "48453");
    expect(resolved).toEqual({
      infoFile: "/tmp/work/PROP.TXT",
      improvementDetailFile: "/tmp/work/IMP_DET.TXT",
    });

    const lowercased = files.map((f) => f.toLowerCase());
    expect(resolvePacsEntries(lowercased, "48453")).toEqual({
      infoFile: "/tmp/work/prop.txt",
      improvementDetailFile: "/tmp/work/imp_det.txt",
    });
  });

  it("a made-up county with no declaration returns null (caller falls back unchanged)", () => {
    expect(resolvePacsExportDeclaration("99999")).toBeUndefined();
    expect(resolvePacsEntries(["/tmp/APPRAISAL_INFO.TXT"], "99999")).toBeNull();
  });

  it("a declared but missing entry refuses naming the entry, never a silent fallback", () => {
    expect(() => resolvePacsEntries(["/tmp/work/IMP_DET.TXT"], "48453")).toThrowError(
      PacsEntryNotFoundError,
    );
    try {
      resolvePacsEntries(["/tmp/work/IMP_DET.TXT"], "48453");
      expect.fail("expected PacsEntryNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(PacsEntryNotFoundError);
      expect((err as PacsEntryNotFoundError).entryName).toBe("PROP.TXT");
      expect((err as PacsEntryNotFoundError).role).toBe("info");
    }
  });

  it("a declared but missing improvement-detail entry refuses naming that entry", () => {
    try {
      resolvePacsEntries(["/tmp/work/PROP.TXT"], "48453");
      expect.fail("expected PacsEntryNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(PacsEntryNotFoundError);
      expect((err as PacsEntryNotFoundError).entryName).toBe("IMP_DET.TXT");
      expect((err as PacsEntryNotFoundError).role).toBe("improvement-detail");
    }
  });
});
