import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

describe("drizzle migration filenames", () => {
  it("uses a unique numeric prefix per file (no duplicate NNNN slots)", () => {
    const files = readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const prefixCounts = new Map<string, string[]>();
    for (const f of files) {
      const m = /^(\d{4})_/.exec(f);
      expect(m, `${f} should start with NNNN_`).not.toBeNull();
      const prefix = m![1];
      const list = prefixCounts.get(prefix) ?? [];
      list.push(f);
      prefixCounts.set(prefix, list);
    }

    const duplicates = [...prefixCounts.entries()].filter(
      ([, names]) => names.length > 1,
    );
    expect(
      duplicates,
      duplicates
        .map(([p, names]) => `${p}: ${names.join(", ")}`)
        .join("; "),
    ).toEqual([]);
  });

  it("orders site-topography after renders power-tools (0017 after 0016)", () => {
    const files = readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const rendersIdx = files.indexOf(
      "0016_renders_power_tools_source_type.sql",
    );
    const topoIdx = files.indexOf("0017_add_site_topography_source_kind.sql");
    expect(rendersIdx).toBeGreaterThanOrEqual(0);
    expect(topoIdx).toBeGreaterThan(rendersIdx);
  });
});
