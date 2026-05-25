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

const componentsCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../smartcity-components.css"),
  "utf8",
);

describe("fpviz action buttons", () => {
  it("forces download CTA contrast on elevated cards", () => {
    expect(componentsCss).toMatch(/\.fpviz-download-btn[\s\S]*color:\s*#ffffff/);
  });

  it("aligns upload action row", () => {
    expect(componentsCss).toMatch(/\.fpviz-source-actions[\s\S]*align-items:\s*center/);
  });
});
