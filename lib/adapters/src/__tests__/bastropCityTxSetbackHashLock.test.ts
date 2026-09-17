/**
 * COMPLETE-BASTROP C1 / WDLL item 8 — dual-repo bastrop-city-tx setback table
 * hash lock (S-05 / H1).
 *
 * Engine and LDT must keep identical LF bytes of bastrop-city-tx.json.
 * Pre-sync working-tree size drift (19670 vs 19258) was CRLF checkout on
 * Windows; git blobs were already identical (LF). Parsed numeric values were
 * identical (no B3 value merge required).
 *
 * Locked SHA256 (UTF-8, LF newlines, no BOM):
 *   9ed2ba806ab7d8f707712f042c8e435b8f5ec445c15d7204f88f05c0a7f02fa5
 *
 * P-299 OT-1 (2026-09-17) moved the lock. The six Place Type rows carried
 * max_height_ft 100 with provenance not_specified: true (the B3 code states
 * height in stories); 100 is not the canonical stated-absence sentinel, so the
 * value became 999 and each table note gained the OT-1 block. That edit is the
 * same in hauska-setback-corpus, and both files still hash to the value above.
 * The mirror test in hauska-engine locks the ENGINE's copy of this file, which
 * this lane did not touch: the engine lock must move in the change that syncs
 * the corpus release (reported as a leave-behind, not silently ignored).
 *
 * Previous lock (pre-P-299):
 *   d54844cd3711579323ceeb96481ade63f1967437a36adeac1c74140ad720cc3c
 *
 * Mirror test: hauska-engine/packages/adapters/src/__tests__/bastropCityTxSetbackHashLock.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Canonical SHA256 of bastrop-city-tx.json (LF). Keep in sync with engine lock. */
export const BASTROP_CITY_TX_SETBACK_SHA256 =
  "9ed2ba806ab7d8f707712f042c8e435b8f5ec445c15d7204f88f05c0a7f02fa5";

const TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../local/setbacks/bastrop-city-tx.json",
);

describe("bastrop-city-tx setback hash lock (C1 / WDLL 8)", () => {
  it("matches the cross-repo locked SHA256 (LF-normalized bytes)", () => {
    const raw = readFileSync(TABLE_PATH);
    // Normalize CRLF→LF so Windows autocrlf checkouts still hash-lock to the
    // canonical blob (gitattributes eol=lf keeps the git object LF).
    const normalized = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    const digest = createHash("sha256").update(normalized).digest("hex");
    expect(digest).toBe(BASTROP_CITY_TX_SETBACK_SHA256);
  });

  it("parses as bastrop-city-tx with six Place Type districts", () => {
    const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as {
      jurisdictionKey: string;
      districts: Array<{ district_name: string }>;
    };
    expect(table.jurisdictionKey).toBe("bastrop-city-tx");
    expect(table.districts.map((d) => d.district_name)).toEqual([
      "P-1 Nature",
      "P-2 Rural",
      "P-3 Neighborhood",
      "P-4 Neighborhood Mix",
      "P-5 Core",
      "P-EC Employment Center",
    ]);
  });
});
