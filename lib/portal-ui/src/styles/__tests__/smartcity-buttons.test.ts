import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const utilitiesCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../smartcity-utilities.css"),
  "utf8",
);

describe("sc-btn icon+label alignment", () => {
  it("applies inline-flex centering on outlined ghost buttons", () => {
    expect(utilitiesCss).toMatch(
      /\.sc-btn-primary,\s*\n\.sc-btn-ghost,\s*\n\.sc-btn-alert,\s*\n\.sc-btn-sm\s*\{[^}]*display:\s*inline-flex/s,
    );
    expect(utilitiesCss).toMatch(/align-items:\s*center/);
    expect(utilitiesCss).toMatch(/gap:\s*6px/);
  });
});
