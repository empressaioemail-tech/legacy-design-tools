import { describe, expect, it, vi } from "vitest";
import {
  IndexHitHeaderRefuseError,
  UNRESOLVED_RESULT_ROW_HEADER,
  extractIndexHitsFromPage,
  normalizeIndexHit,
  vendorFamilyFromPortalId,
} from "./indexHits.js";
import type { RecordsRecipeBrowser } from "./types.js";

function mockBrowser(
  rows: Awaited<ReturnType<RecordsRecipeBrowser["extractResultRows"]>>,
): RecordsRecipeBrowser {
  return {
    goto: vi.fn(),
    captureFullPage: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    pressEnter: vi.fn(),
    pageIncludes: vi.fn(),
    currentUrl: vi.fn(),
    extractResultRows: vi.fn().mockResolvedValue(rows),
  };
}

const NAMED_HEADERS = [
  "Instrument Number",
  "Grantor",
  "Document Type",
  "Recording Date",
  "Legal Description",
  "Pages",
];

describe("normalizeIndexHit header bind", () => {
  it("binds each field to the named column", () => {
    expect(
      normalizeIndexHit({
        headers: NAMED_HEADERS,
        cells: [
          "2024-12345",
          "SMITH JOHN A",
          "WARRANTY DEED",
          "01/02/2024",
          "LOT 1 BLK 2 PECAN",
          "3",
        ],
        link: "https://portal/doc/1",
      }),
    ).toEqual({
      recordingRef: "2024-12345",
      documentType: "WARRANTY DEED",
      recordingDate: "01/02/2024",
      parties: "SMITH JOHN A",
      detailUrl: "https://portal/doc/1",
    });
  });

  it("does not take the name column as documentType when name precedes type", () => {
    const hit = normalizeIndexHit({
      headers: ["Grantor", "Document Type", "Instrument Number", "Date"],
      cells: ["SMITH JOHN A", "WARRANTY DEED", "2024-12345", "01/02/2024"],
      link: null,
    });
    expect(hit?.recordingRef).toBe("2024-12345");
    expect(hit?.documentType).toBe("WARRANTY DEED");
    expect(hit?.documentType).not.toBe("SMITH JOHN A");
    expect(hit?.parties).toBe("SMITH JOHN A");
  });

  it("joins only named grantor and grantee columns", () => {
    const hit = normalizeIndexHit({
      headers: [
        "Instrument Number",
        "Grantor",
        "Grantee",
        "Type",
        "Legal Description",
        "Fee",
      ],
      cells: [
        "2024-9",
        "SMITH JOHN A",
        "JONES MARY B",
        "DEED",
        "LOT 4 PECAN ADDN",
        "$7.00",
      ],
      link: null,
    });
    expect(hit?.parties).toBe("SMITH JOHN A / JONES MARY B");
    expect(hit?.parties).not.toContain(" | ");
    expect(hit?.parties).not.toContain("LOT 4");
    expect(hit?.parties).not.toContain("$7.00");
  });

  it("returns null fields for unrecognised headers and never a leftover join", () => {
    const hit = normalizeIndexHit({
      headers: ["Instrument Number", "Checkbox", "Status", "Comments"],
      cells: ["2024-12345", "x", "OPEN", "see clerk"],
      link: null,
    });
    expect(hit).toEqual({
      recordingRef: "2024-12345",
      documentType: null,
      recordingDate: null,
      parties: null,
      detailUrl: null,
    });
    expect(JSON.stringify(hit)).not.toContain(" | ");
  });

  it("refuses when the header is absent", () => {
    expect(() =>
      normalizeIndexHit({
        cells: ["2024-12345", "DEED", "2024-01-02", "SMITH JOHN"],
        link: "https://portal/doc/1",
      }),
    ).toThrow(IndexHitHeaderRefuseError);
    try {
      normalizeIndexHit({
        headers: null,
        cells: ["2024-12345", "DEED", "2024-01-02", "SMITH JOHN"],
        link: null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(IndexHitHeaderRefuseError);
      expect((err as IndexHitHeaderRefuseError).code).toBe(
        UNRESOLVED_RESULT_ROW_HEADER,
      );
    }
  });
});

describe("extractIndexHitsFromPage", () => {
  it("refuses when any result row has no header", async () => {
    const result = await extractIndexHitsFromPage(
      mockBrowser([
        {
          headers: null,
          cells: ["2024-12345", "SMITH JOHN A", "DEED"],
          link: null,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe(UNRESOLVED_RESULT_ROW_HEADER);
    }
  });

  it("returns empty hits when the page has no rows", async () => {
    const result = await extractIndexHitsFromPage(mockBrowser([]));
    expect(result).toEqual({ ok: true, hits: [] });
  });
});

describe("vendorFamilyFromPortalId", () => {
  it("maps the portals this lane already drives", () => {
    expect(vendorFamilyFromPortalId("bastrop-aumentum")).toBe("aumentum");
    expect(vendorFamilyFromPortalId("travis-tccsearch")).toBe("aumentum");
    expect(vendorFamilyFromPortalId("hays-erss")).toBe("tyler");
    expect(vendorFamilyFromPortalId("williamson-publicsearch")).toBe(
      "publicsearch",
    );
    expect(vendorFamilyFromPortalId("caldwell-clerk-web")).toBe("shared");
  });
});
