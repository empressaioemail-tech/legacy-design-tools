/**
 * Per-county living-area segment vocabulary (A-133, P-157 resumption 2:
 * "the parser learns TCAD's segment vocabulary").
 *
 * TCAD's real 2026 certified IMP_DET.TXT types every living-area
 * segment `1ST` / `2ND` / `3RD` ("1st/2nd/3rd Floor") and carries zero
 * "MAIN AREA" rows — confirmed by a whole-file grep against the real
 * ~2GB export during the P-157 resumption-1 load. These tests build
 * synthetic IMPROVEMENT_DETAIL-shaped fixtures (correct field spans,
 * per lib/cad-ingest/src/pacs/layout.ts) rather than depend on that
 * real file, so they run without network or GCS access.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ImprovementVocabularyMismatchError,
  readImprovementRollups,
} from "../parser";
import { IMPROVEMENT_DETAIL, type FieldSpan } from "../layout";

/** Build one IMPROVEMENT_DETAIL-shaped fixed-width line from field spans. */
function impLine(fields: {
  propId: string;
  propValYr: string;
  typeCd: string;
  typeDesc: string;
  yrBuilt?: string;
  area?: string;
}): string {
  const LEN = 130; // > IMPROVEMENT_DETAIL_MIN_LEN (122)
  const chars = new Array<string>(LEN).fill(" ");
  const set = (span: FieldSpan, value: string) => {
    const width = span.end - span.start + 1;
    const v = value.slice(0, width).padEnd(width, " ");
    for (let i = 0; i < width; i++) chars[span.start - 1 + i] = v[i];
  };
  set(IMPROVEMENT_DETAIL.propId, fields.propId);
  set(IMPROVEMENT_DETAIL.propValYr, fields.propValYr);
  set(IMPROVEMENT_DETAIL.typeCd, fields.typeCd);
  set(IMPROVEMENT_DETAIL.typeDesc, fields.typeDesc);
  if (fields.yrBuilt) set(IMPROVEMENT_DETAIL.yrBuilt, fields.yrBuilt);
  if (fields.area) set(IMPROVEMENT_DETAIL.area, fields.area);
  return chars.join("");
}

async function writeFixture(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "imp-vocab-test-"));
  const file = join(dir, "IMP_DET.TXT");
  await writeFile(file, lines.join("\r\n") + "\r\n", "latin1");
  return file;
}

describe("readImprovementRollups — per-county living-area segment vocabulary", () => {
  it("TCAD (48453): sums 1ST/2ND/3RD floor segments, ignores porch/garage/etc", async () => {
    const file = await writeFixture([
      // 48453:113408 — real shape from the P-157 close's raw evidence:
      // one 1ST floor segment (1950, 3550 sqft) plus non-living extras.
      impLine({ propId: "113408", propValYr: "2026", typeCd: "1ST", typeDesc: "1st Floor", yrBuilt: "1950", area: "3550" }),
      impLine({ propId: "113408", propValYr: "2026", typeCd: "OPF", typeDesc: "Porch Open 1st F", area: "120" }),
      impLine({ propId: "113408", propValYr: "2026", typeCd: "CAR", typeDesc: "Carport Att 1st", area: "200" }),
      // 48453:474034 — two-story: 1ST + 2ND floor segments, different years
      // ignored as "second floor" per the earliest-year rule.
      impLine({ propId: "474034", propValYr: "2026", typeCd: "1ST", typeDesc: "1st Floor", yrBuilt: "2001", area: "2413" }),
      impLine({ propId: "474034", propValYr: "2026", typeCd: "2ND", typeDesc: "2nd Floor", yrBuilt: "2001", area: "1755" }),
      impLine({ propId: "474034", propValYr: "2026", typeCd: "GAR", typeDesc: "Garage Att 1st F", area: "440" }),
      // a third-floor case, to exercise 3RD explicitly.
      impLine({ propId: "999999", propValYr: "2026", typeCd: "1ST", typeDesc: "1st Floor", yrBuilt: "1975", area: "1000" }),
      impLine({ propId: "999999", propValYr: "2026", typeCd: "3RD", typeDesc: "3rd Floor", yrBuilt: "1990", area: "500" }),
    ]);

    const rollups = await readImprovementRollups(file, "48453");

    expect(rollups.get("113408:2026")).toEqual({ yearBuilt: 1950, livingAreaSqft: 3550 });
    expect(rollups.get("474034:2026")).toEqual({ yearBuilt: 2001, livingAreaSqft: 4168 });
    // earliest-year rule across matched segments (1975 vs 1990) and sum (1000+500).
    expect(rollups.get("999999:2026")).toEqual({ yearBuilt: 1975, livingAreaSqft: 1500 });
  });

  it("Bastrop (48021, no declaration): MAIN AREA default is unchanged", async () => {
    const file = await writeFixture([
      impLine({ propId: "555001", propValYr: "2026", typeCd: "MA", typeDesc: "MAIN AREA", yrBuilt: "1980", area: "1200" }),
      impLine({ propId: "555001", propValYr: "2026", typeCd: "GAR", typeDesc: "GARAGE ATTACHED", area: "400" }),
      impLine({ propId: "555001", propValYr: "2026", typeCd: "MA2", typeDesc: "MAIN AREA SECOND FLOOR", yrBuilt: "1985", area: "300" }),
    ]);

    const rollups = await readImprovementRollups(file, "48021");

    // Bastrop has no sources.ts declaration: only "MAIN AREA"-prefixed
    // typeDesc counts, exactly as before this change. Both MA and MA2
    // match (both start with "MAIN AREA"); earliest year wins.
    expect(rollups.get("555001:2026")).toEqual({ yearBuilt: 1980, livingAreaSqft: 1500 });
  });

  it("Caldwell (48055, no declaration): a declared county's typeCd list never leaks to an undeclared county", async () => {
    const file = await writeFixture([
      // Segments typed 1ST/2ND (TCAD's vocabulary) must NOT be treated
      // as living area for Caldwell, which has no declaration — only
      // its own MAIN AREA fallback applies, and there is none here, so
      // this must refuse rather than silently accept TCAD's codes.
      impLine({ propId: "1", propValYr: "2026", typeCd: "1ST", typeDesc: "1st Floor", yrBuilt: "2000", area: "1000" }),
    ]);

    await expect(readImprovementRollups(file, "48055")).rejects.toBeInstanceOf(
      ImprovementVocabularyMismatchError,
    );
  });

  it("refuses when a file matches neither its declared vocabulary nor MAIN AREA, naming what it saw", async () => {
    const file = await writeFixture([
      impLine({ propId: "1", propValYr: "2026", typeCd: "XYZ", typeDesc: "UNKNOWN SEGMENT TYPE", area: "10" }),
      impLine({ propId: "1", propValYr: "2026", typeCd: "XYZ", typeDesc: "UNKNOWN SEGMENT TYPE", area: "20" }),
      impLine({ propId: "2", propValYr: "2026", typeCd: "ABC", typeDesc: "ANOTHER UNKNOWN", area: "30" }),
    ]);

    // 48453 is declared (1ST/2ND/3RD) — a file carrying neither those
    // nor MAIN AREA must still refuse, not silently fall back to zero.
    let caught: unknown;
    try {
      await readImprovementRollups(file, "48453");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImprovementVocabularyMismatchError);
    const err = caught as ImprovementVocabularyMismatchError;
    expect(err.countyFips).toBe("48453");
    expect(err.expectedTypeCds).toEqual(["1ST", "2ND", "3RD"]);
    expect(err.observedTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ typeCd: "XYZ", typeDesc: "UNKNOWN SEGMENT TYPE", count: 2 }),
        expect.objectContaining({ typeCd: "ABC", typeDesc: "ANOTHER UNKNOWN", count: 1 }),
      ]),
    );
    expect(err.message).toContain("XYZ");
    expect(err.message).toContain("UNKNOWN SEGMENT TYPE");
    expect(err.message).toContain("48453");
  });

  it("refuses on a completely empty improvement-detail file, naming that nothing was seen", async () => {
    const file = await writeFixture([]);
    await expect(readImprovementRollups(file, "48453")).rejects.toThrow(
      /no improvement-detail rows at all/,
    );
  });
});
