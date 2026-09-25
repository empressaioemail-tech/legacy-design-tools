/**
 * WDLL 2026-07-29 BDC STEP 3 — dual-repo bastrop-development-code hash lock.
 *
 * Engine and LDT must keep identical LF bytes of bastrop-development-code.json.
 *
 * Locked SHA256 (UTF-8, LF newlines, no BOM):
 *   653dcb2f70cde0f5b8aab22de8433e669f05d1868bcc0bdf306271cb24d75020
 *
 * P-445 (2026-09-25): added PI Public Institutional. Engine mirror lock is
 * leave-behind until a hauska-engine PR updates the same bytes.
 *
 * Mirror test: hauska-engine/packages/adapters/src/__tests__/bastropDevelopmentCodeSetbackHashLock.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Canonical SHA256 of bastrop-development-code.json (LF). Keep in sync with engine lock. */
export const BASTROP_DEVELOPMENT_CODE_SETBACK_SHA256 =
  "653dcb2f70cde0f5b8aab22de8433e669f05d1868bcc0bdf306271cb24d75020";

const TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../local/setbacks/bastrop-development-code.json",
);

describe("bastrop-development-code setback hash lock (WDLL STEP 3)", () => {
  it("matches the cross-repo locked SHA256 (LF-normalized bytes)", () => {
    const raw = readFileSync(TABLE_PATH);
    const normalized = Buffer.from(
      raw.toString("utf8").replace(/\r\n/g, "\n"),
      "utf8",
    );
    const digest = createHash("sha256").update(normalized).digest("hex");
    expect(digest).toBe(BASTROP_DEVELOPMENT_CODE_SETBACK_SHA256);
  });

  it("parses as bastrop-development-code with SF-1/SF-2/SF-3/RR and PI", () => {
    const table = JSON.parse(readFileSync(TABLE_PATH, "utf8")) as {
      jurisdictionKey: string;
      districts: Array<{ district_name: string }>;
    };
    expect(table.jurisdictionKey).toBe("bastrop-development-code");
    expect(table.districts.map((d) => d.district_name)).toEqual([
      "SF-1 Single-Family Residential",
      "SF-2 Single-Family Residential",
      "SF-3 Single-Family Residential",
      "RR Rural Residential",
      "PI Public Institutional",
    ]);
  });
});
