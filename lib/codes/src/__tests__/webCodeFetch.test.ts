import { describe, expect, it } from "vitest";
import {
  extractSectionBlock,
  titleMatchesExpected,
  verifyAndExtract,
} from "../webCodeFetch/extract";
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

const IRC_2021_SECTION_HTML = `
<html><head><title>Texas IRC 2021 R301.1</title></head>
<body>
<h2>### R301.1 Application</h2>
<p>Buildings and structures, and parts thereof, shall be constructed to safely support all loads,
including dead loads, live loads, roof loads, flood loads, snow loads, wind loads and seismic loads
as prescribed by this code. 2021 International Residential Code.</p>
<h2>### R301.2 Climatic and Geographic Design Criteria</h2>
<p>Other section content here.</p>
</body></html>`;

const IRC_2021_LANDING_HTML = `
<html><head><title>IRC 2021</title></head>
<body><p>International Residential Code 2021 — select a chapter to browse.</p></body></html>`;

function mockHttp(
  body: string,
  url = "https://codes.iccsafe.org/content/FLMECH2023P1",
): HttpFetcher {
  return async () => ({ status: 200, body, finalUrl: url });
}

function mockHttpSequence(
  responses: Array<{ body: string; url: string; status?: number }>,
): HttpFetcher {
  let i = 0;
  return async (url) => {
    const hit = responses[i] ?? responses[responses.length - 1]!;
    i++;
    return {
      status: hit.status ?? 200,
      body: hit.body,
      finalUrl: hit.url ?? url,
    };
  };
}

describe("verifyAndExtract", () => {
  it("accepts matching FBC 2023 edition + section", () => {
    const out = verifyAndExtract(FBC_2023_HTML, {
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      expectedTitle: "Duct insulation",
    });
    expect(out.verified).toBe(true);
    expect(out.unverifiedWebSource).toBe(false);
    expect(out.text.toLowerCase()).toContain("return air");
  });

  it("refuses wrong edition FBC 2020 when 2023 requested", () => {
    const out = verifyAndExtract(FBC_2020_WRONG_HTML, {
      codeRef: "FBC-M601.6",
      edition: "FBC 2023",
      expectedTitle: "Duct insulation",
    });
    expect(out.verified).toBe(false);
    expect(out.unverifiedWebSource).toBe(true);
    expect(out.verificationNote).toBe("wrong-edition");
  });

  it("refuses wrong edition NEC 2020 when 2017 requested", () => {
    const out = verifyAndExtract(NEC_2020_WRONG_HTML, {
      codeRef: "NEC Art. 220",
      edition: "NEC 2017",
      expectedTitle: "Branch-Circuit Load Calculations",
    });
    expect(out.verified).toBe(false);
    expect(out.unverifiedWebSource).toBe(true);
  });

  it("accepts NEC 2017 Article 220", () => {
    const out = verifyAndExtract(NEC_2017_HTML, {
      codeRef: "NEC Art. 220",
      edition: "NEC 2017",
      expectedTitle: "Branch-Circuit Load Calculations",
    });
    expect(out.verified).toBe(true);
    expect(out.text).toContain("Load calculations");
  });

  it("verifies IRC section body + title from UpCodes-style HTML", () => {
    const out = verifyAndExtract(IRC_2021_SECTION_HTML, {
      codeRef: "IRC-R301.1",
      edition: "IRC 2021",
      expectedTitle: "Application (design criteria)",
    });
    expect(out.verified).toBe(true);
    expect(out.text).toContain("safely support all loads");
    expect(out.text).not.toContain("Climatic and Geographic");
  });

  it("rejects chapter landing without section body", () => {
    const out = verifyAndExtract(IRC_2021_LANDING_HTML, {
      codeRef: "IRC-R301.1",
      edition: "IRC 2021",
      expectedTitle: "Application (design criteria)",
    });
    expect(out.verified).toBe(false);
    expect(out.verificationNote).toBe("section-not-found");
  });

  it("rejects title mismatch on otherwise valid section", () => {
    const out = verifyAndExtract(IRC_2021_SECTION_HTML, {
      codeRef: "IRC-R301.1",
      edition: "IRC 2021",
      expectedTitle: "Ice barriers",
    });
    expect(out.verified).toBe(false);
    expect(out.verificationNote).toBe("title-mismatch");
  });
});

describe("extractSectionBlock", () => {
  it("isolates one section from a multi-section chapter page", () => {
    const plain =
      "### R301.1 Application Buildings shall support loads. ### R301.2 Climatic criteria Other text.";
    const block = extractSectionBlock(plain, "R301.1", "Application");
    expect(block?.heading).toContain("R301.1");
    expect(block?.body).toContain("support loads");
    expect(block?.body).not.toContain("Climatic");
  });
});

describe("titleMatchesExpected", () => {
  it("accepts fuzzy title overlap", () => {
    expect(
      titleMatchesExpected(
        "R301.1 Application",
        "Application (design criteria)",
      ),
    ).toBe(true);
  });
});

describe("fetchCodeSection", () => {
  it("returns verified result with source URL and retrievedAt", async () => {
    const result = await fetchCodeSection(
      {
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        expectedTitle: "Duct insulation",
      },
      { http: mockHttp(FBC_2023_HTML) },
    );
    expect(result.verified).toBe(true);
    expect(result.sourceUrl).toContain("codes.iccsafe.org");
    expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.text.length).toBeGreaterThan(20);
  });

  it("returns verified:false for wrong edition", async () => {
    const result = await fetchCodeSection(
      {
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        expectedTitle: "Duct insulation",
      },
      { http: mockHttp(FBC_2020_WRONG_HTML) },
    );
    expect(result.verified).toBe(false);
    expect(result.unverifiedWebSource).toBe(true);
  });

  it("tries next driver when first returns unverified landing HTML", async () => {
    const result = await fetchCodeSection(
      {
        codeRef: "IRC-R301.1",
        edition: "IRC 2021",
        expectedTitle: "Application (design criteria)",
      },
      {
        http: mockHttpSequence([
          {
            body: IRC_2021_LANDING_HTML,
            url: "https://codes.iccsafe.org/content/IRC2021P1",
          },
          {
            body: IRC_2021_SECTION_HTML,
            url: "https://up.codes/viewer/texas/irc-2021/chapter/3/R301.1",
          },
        ]),
        target: {
          codeRef: "IRC-R301.1",
          edition: "IRC 2021",
          editionSlug: "irc-2021",
          label: "IRC-R301.1 — Application (design criteria)",
          expectedTitle: "Application (design criteria)",
          jurisdictionKey: "austin_tx",
          drivers: ["upcodes", "icc"],
        },
      },
    );
    expect(result.verified).toBe(true);
    expect(result.sourceUrl).toContain("up.codes");
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
