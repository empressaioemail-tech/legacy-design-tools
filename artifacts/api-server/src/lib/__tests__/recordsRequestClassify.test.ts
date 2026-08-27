/**
 * P-85 WDLL item 8 — classification routing and refuse fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  assertRecordsRequestClauseWritable,
  assertRecordsRequestInstrumentWritable,
  classifyRecordsRequestDocumentType,
  extractRecordsRequestHeaderFacts,
  RecordsRequestClassifyRefuseError,
} from "../recordsRequestInstrumentClassify";

describe("classifyRecordsRequestDocumentType", () => {
  it("routes easement types to clause extraction", () => {
    for (const label of ["EASEMENT", "UTILITY EASEMENT", "RIGHT OF WAY"]) {
      const route = classifyRecordsRequestDocumentType(label);
      expect(route.instrumentType).toBe("easement");
      expect(route.extractsClauses).toBe(true);
    }
  });

  it("routes deed types to header-only with documentKind", () => {
    const route = classifyRecordsRequestDocumentType("WARRANTY DEED");
    expect(route.instrumentType).toBe("other");
    expect(route.documentKind).toBe("deed");
    expect(route.extractsClauses).toBe(false);
  });

  it("routes deed of trust to header-only documentKind", () => {
    const route = classifyRecordsRequestDocumentType("DEED OF TRUST");
    expect(route.instrumentType).toBe("other");
    expect(route.documentKind).toBe("deed-of-trust");
    expect(route.extractsClauses).toBe(false);
  });

  it("routes plat-restriction types to clause extraction", () => {
    const route = classifyRecordsRequestDocumentType("SUBDIVISION PLAT");
    expect(route.instrumentType).toBe("plat-restriction");
    expect(route.extractsClauses).toBe(true);
  });

  it("routes lien to header-only primary type", () => {
    const route = classifyRecordsRequestDocumentType("TAX LIEN");
    expect(route.instrumentType).toBe("lien");
    expect(route.extractsClauses).toBe(false);
  });
});

describe("records request classify refuse fixtures (WDLL item 8)", () => {
  it("refuses instrument without recording reference and without image", () => {
    expect(() =>
      assertRecordsRequestInstrumentWritable({
        recordingRef: null,
        hasImage: false,
      }),
    ).toThrow(RecordsRequestClassifyRefuseError);
    try {
      assertRecordsRequestInstrumentWritable({ recordingRef: null, hasImage: false });
    } catch (err) {
      expect(err).toBeInstanceOf(RecordsRequestClassifyRefuseError);
      expect((err as RecordsRequestClassifyRefuseError).code).toBe(
        "missing_recording_ref_and_image",
      );
    }
  });

  it("allows instrument with recording ref but no image", () => {
    expect(() =>
      assertRecordsRequestInstrumentWritable({
        recordingRef: "2024-12345",
        hasImage: false,
      }),
    ).not.toThrow();
  });

  it("allows instrument with image but no recording ref", () => {
    expect(() =>
      assertRecordsRequestInstrumentWritable({
        recordingRef: null,
        hasImage: true,
      }),
    ).not.toThrow();
  });

  it("refuses clause without sourceCitation", () => {
    expect(() =>
      assertRecordsRequestClauseWritable({ sourceCitation: "  " }),
    ).toThrow(RecordsRequestClassifyRefuseError);
    try {
      assertRecordsRequestClauseWritable({ sourceCitation: null });
    } catch (err) {
      expect((err as RecordsRequestClassifyRefuseError).code).toBe(
        "clause_missing_source_citation",
      );
    }
  });

  it("refuses clause batch write when any citation is missing", () => {
    const batch = [
      { sourceCitation: "Section 1 (p. 1)" },
      { sourceCitation: "" },
    ];
    expect(() => {
      for (const c of batch) {
        assertRecordsRequestClauseWritable(c);
      }
    }).toThrow(RecordsRequestClassifyRefuseError);
  });
});

describe("extractRecordsRequestHeaderFacts", () => {
  it("parses parties from index and amounts from vision text", () => {
    const facts = extractRecordsRequestHeaderFacts({
      parties: "SMITH / JONES",
      recordingDate: "2024-01-15",
      recordingRef: "2024-99",
      documentType: "DEED OF TRUST",
      visionText: "Principal amount $250,000.00",
    });
    expect(facts.parties).toBe("SMITH / JONES");
    expect(facts.statedAmounts.some((a) => a.includes("250,000"))).toBe(true);
  });
});
