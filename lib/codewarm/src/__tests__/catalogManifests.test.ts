/**
 * Catalog manifest parser — quoted sections + groups shapes.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseCodewarmManifest } from "../manifest";

const FIXTURES = join(import.meta.dirname, "fixtures");
const CATALOG_DIR = process.env.CODEWARM_CATALOG_DIR;

/** Expected inline-row counts from `_catalog/codes/manifest_*.yaml` (2026-06-10). */
export const CATALOG_MANIFEST_COUNTS: Record<string, number> = {
  "manifest_irc_2021.yaml": 117,
  "manifest_ibc_iebc_2021.yaml": 132,
  "manifest_iecc_2021.yaml": 101,
  "manifest_imc_ipc_ifgc_2021.yaml": 137,
  "manifest_ifc_ipmc_2021.yaml": 142,
  "manifest_accessibility_nfpa_2021.yaml": 109,
};

describe("parseCodewarmManifest fixture shapes", () => {
  it("parses quoted section keys (IBC-style)", () => {
    const entries = parseCodewarmManifest(
      join(FIXTURES, "manifest_quoted_sections.yaml"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.codeRef).toBe("IBC-302.1");
    expect(entries[1]!.codeRef).toBe("IBC-303");
  });

  it("parses groups with per-row edition and grounding", () => {
    const entries = parseCodewarmManifest(join(FIXTURES, "manifest_groups.yaml"));
    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.code === "A117.1")?.edition).toBe("2017");
    expect(entries.find((e) => e.code === "ADA")?.grounding).toBe(
      "verify-existing-corpus",
    );
    expect(entries.find((e) => e.code === "NEC")?.grounding).toBe(
      "NFPA-license-required",
    );
  });
});

describe.skipIf(!CATALOG_DIR)("catalog manifests (CODEWARM_CATALOG_DIR)", () => {
  for (const [file, expected] of Object.entries(CATALOG_MANIFEST_COUNTS)) {
    it(`${file} parses to ${expected} entries`, () => {
      const entries = parseCodewarmManifest(join(CATALOG_DIR!, file));
      expect(entries.length).toBe(expected);
    });
  }
});
