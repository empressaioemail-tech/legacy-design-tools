import { describe, expect, it } from "vitest";
import { verifyAndExtract } from "../webCodeFetch/extract";
import {
  corpusCoversTarget,
  fetchCodeSection,
  websearchAtomId,
} from "../webCodeFetch/index";
import type { HttpFetcher } from "../webCodeFetch/types";

const FBC_2023_HTML = `
<html><head><title>2023 Florida Building Code — Mechanical</title></head>
<body><h1>Section M601.6 Duct insulation</h1>
<p>Return air ducts shall be insulated and sealed. Balanced return air required per Chapter 4.</p>
<p>Edition 2023 Florida Building Code Mechanical 8th edition.</p></body></html>`;

const FBC_2020_WRONG_HTML = `
<html><head><title>2020 Florida Building Code — Mechanical</title></head>
<body><h1>Section M601.6</h1>
<p>Return air ducts shall be insulated. 2020 Florida Building Code only.</p></body></html>`;

const NEC_2017_HTML = `
<html><head><title>NFPA 70 NEC 2017</title></head>
<body><h1>Article 220 Branch-Circuit Load Calculations</h1>
<p>Load calculations shall be provided on panel schedules. 2017 Edition.</p></body></html>`;

const NEC_2020_WRONG_HTML = `
<html><head><title>NFPA 70 NEC 2020</title></head>
<body><h1>Article 220</h1><p>2020 edition load calculations.</p></body></html>`;

function mockHttp(body: string, url = "https://codes.iccsafe.org/content/FLMECH2023P1"): HttpFetcher {
  return async () => ({ status: 200, body, finalUrl: url });
}

describe("verifyAndExtract", () => {
  it("accepts matching FBC 2023 edition + section", () => {
    const out = verifyAndExtract(FBC_2023_HTML, {
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
    });
    expect(out.verified).toBe(true);
    expect(out.unverifiedWebSource).toBe(false);
    expect(out.text.toLowerCase()).toContain("return air");
  });

  it("refuses wrong edition FBC 2020 when 2023 requested", () => {
    const out = verifyAndExtract(FBC_2020_WRONG_HTML, {
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
    });
    expect(out.verified).toBe(false);
    expect(out.unverifiedWebSource).toBe(true);
    expect(out.confidence).toBeLessThan(0.5);
  });

  it("refuses wrong edition NEC 2020 when 2017 requested", () => {
    const out = verifyAndExtract(NEC_2020_WRONG_HTML, {
      codeRef: "NEC Art. 220",
      edition: "NEC 2017",
    });
    expect(out.verified).toBe(false);
    expect(out.unverifiedWebSource).toBe(true);
  });

  it("accepts NEC 2017 Article 220", () => {
    const out = verifyAndExtract(NEC_2017_HTML, {
      codeRef: "NEC Art. 220",
      edition: "NEC 2017",
    });
    expect(out.verified).toBe(true);
    expect(out.text).toContain("Load calculations");
  });
});

describe("fetchCodeSection", () => {
  it("returns verified result with source URL and retrievedAt", async () => {
    const result = await fetchCodeSection(
      { codeRef: "FBC-M601.6", edition: "FBC 2023" },
      { http: mockHttp(FBC_2023_HTML) },
    );
    expect(result.verified).toBe(true);
    expect(result.sourceUrl).toContain("codes.iccsafe.org");
    expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.text.length).toBeGreaterThan(20);
  });

  it("returns verified:false for wrong edition", async () => {
    const result = await fetchCodeSection(
      { codeRef: "FBC-M601.6", edition: "FBC 2023" },
      { http: mockHttp(FBC_2020_WRONG_HTML) },
    );
    expect(result.verified).toBe(false);
    expect(result.unverifiedWebSource).toBe(true);
  });
});

describe("websearch atom ids", () => {
  it("uses websearch: namespace distinct from corpus UUIDs", () => {
    const id = websearchAtomId("fbc-2023", "FBC-M601.6");
    expect(id).toBe("websearch:fbc-2023:fbc-m601-6");
    expect(id).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("corpusCoversTarget", () => {
  it("returns true when Municode label matches", () => {
    expect(
      corpusCoversTarget(["Chapter 8 HVAC Design — Miami-Dade"], {
        codeRef: "Miami-Dade Ch.8",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        label: "Miami-Dade Chapter 8 HVAC",
        drivers: ["icc"],
      }),
    ).toBe(false);
  });
});
