/**
 * Permit-corpus normalization tests. Headers and fixture rows are
 * verbatim-shaped copies from the acquired Wave-3 CSVs (public record;
 * verified against the live GCS objects 2026-07-15):
 * Austin issued_construction_permits.csv and San Antonio
 * permits_issued_current.csv / permits_issued_2020_2024.csv.
 */

import { describe, expect, it } from "vitest";
import { HeaderIndex } from "../csv";
import {
  assertPermitHeader,
  normalizePermitRow,
  parsePermitDate,
  parsePermitValuation,
  permitRecordHash,
} from "../permits/normalize";

/** Verbatim Austin export header (68 columns). */
const AUSTIN_HEADER = new HeaderIndex(
  "Permit Type,Permit Type Desc,Permit Num,Permit Class Mapped,Permit Class,Work Class,Condominium,Project Name,Description,TCAD ID,Property Legal Description,Applied Date,Issued Date,Day Issued,Calendar Year Issued,Fiscal Year Issued,Issued In Last 30 Days,Issuance Method,Status Current,Status Date,Expires Date,Completed Date,Total Existing Bldg SQFT,Remodel Repair SQFT,Total New Add SQFT,Total Valuation Remodel,Total Job Valuation,Number Of Floors,Housing Units,Building Valuation,Building Valuation Remodel,Electrical Valuation,Electrical Valuation Remodel,Mechanical Valuation,Mechanical Valuation Remodel,Plumbing Valuation,Plumbing Valuation Remodel,MedGas Valuation,MedGas Valuation Remodel,Original Address 1,Original City,Original State,Original Zip,Council District,Jurisdiction,Link,Project ID,Master Permit Num,Latitude,Longitude,Location,Contractor Trade,Contractor Company Name,Contractor Full Name,Contractor Phone,Contractor Address 1,Contractor Address 2,Contractor City,Contractor Zip,Applicant Full Name,Applicant Organization,Applicant Phone,Applicant Address 1,Applicant Address 2,Applicant City,Applicant Zip,Certificate Of Occupancy,Total Lot SQFT".split(
    ",",
  ),
);

/** Verbatim SA export header (both SA files share it). */
const SA_HEADER = new HeaderIndex(
  "PERMIT TYPE,PERMIT #,PROJECT NAME,WORK TYPE,ADDRESS,LOCATION,X_COORD,Y_COORD,DATE SUBMITTED,DATE ISSUED,DECLARED VALUATION,AREA (SF),PRIMARY CONTACT,CD,NCD,HD".split(
    ",",
  ),
);

function austinRow(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    "Permit Type": "EP",
    "Permit Type Desc": "Electrical Permit",
    "Permit Num": "2026-061052 EP",
    "Permit Class Mapped": "Commercial",
    "Permit Class": "Sign Permit",
    "Work Class": "Wall",
    Description: "Mi Casa Family Dentistry",
    "TCAD ID": "0330430122",
    "Property Legal Description": "LOT 1 PEARCE GARDENS",
    "Applied Date": "2026/05/20",
    "Issued Date": "2026/06/11",
    "Status Current": "Active",
    "Total Job Valuation": "",
    "Original Address 1": "12800 PEARCE LN",
    "Original City": "AUSTIN",
    "Original State": "TX",
    "Original Zip": "78617",
  };
  const merged = { ...base, ...overrides };
  // Rebuild the 68-column row in header order.
  const names =
    "Permit Type,Permit Type Desc,Permit Num,Permit Class Mapped,Permit Class,Work Class,Condominium,Project Name,Description,TCAD ID,Property Legal Description,Applied Date,Issued Date,Day Issued,Calendar Year Issued,Fiscal Year Issued,Issued In Last 30 Days,Issuance Method,Status Current,Status Date,Expires Date,Completed Date,Total Existing Bldg SQFT,Remodel Repair SQFT,Total New Add SQFT,Total Valuation Remodel,Total Job Valuation,Number Of Floors,Housing Units,Building Valuation,Building Valuation Remodel,Electrical Valuation,Electrical Valuation Remodel,Mechanical Valuation,Mechanical Valuation Remodel,Plumbing Valuation,Plumbing Valuation Remodel,MedGas Valuation,MedGas Valuation Remodel,Original Address 1,Original City,Original State,Original Zip,Council District,Jurisdiction,Link,Project ID,Master Permit Num,Latitude,Longitude,Location,Contractor Trade,Contractor Company Name,Contractor Full Name,Contractor Phone,Contractor Address 1,Contractor Address 2,Contractor City,Contractor Zip,Applicant Full Name,Applicant Organization,Applicant Phone,Applicant Address 1,Applicant Address 2,Applicant City,Applicant Zip,Certificate Of Occupancy,Total Lot SQFT".split(
      ",",
    );
  return names.map((n) => merged[n] ?? "");
}

function saRow(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    "PERMIT TYPE": "Comm New Building Permit",
    "PERMIT #": "COM-BLG-PMT24-40200788",
    "PROJECT NAME": "Building No: N/A; Unit No: N/A",
    "WORK TYPE": "New",
    ADDRESS: "8751 STATE HWY 151, City of San Antonio, TX 78245",
    LOCATION: "NULL",
    X_COORD: "2076498.5",
    Y_COORD: "13708187.9",
    "DATE SUBMITTED": "2024-08-02",
    "DATE ISSUED": "2025-01-01",
    "DECLARED VALUATION": "3500000.0",
    "AREA (SF)": "9110.0",
    "PRIMARY CONTACT": "Taco Palenque",
    CD: "6",
    NCD: "NULL",
    HD: "NULL",
  };
  const merged = { ...base, ...overrides };
  const names =
    "PERMIT TYPE,PERMIT #,PROJECT NAME,WORK TYPE,ADDRESS,LOCATION,X_COORD,Y_COORD,DATE SUBMITTED,DATE ISSUED,DECLARED VALUATION,AREA (SF),PRIMARY CONTACT,CD,NCD,HD".split(
      ",",
    );
  return names.map((n) => merged[n] ?? "");
}

const COMMON = { sourceFile: "test.csv", acquiredDate: "2026-06-21" };

describe("parsePermitDate", () => {
  it("handles the three real export shapes", () => {
    expect(parsePermitDate("2026/06/11")).toBe("2026-06-11"); // Austin
    expect(parsePermitDate("06/12/2026")).toBe("2026-06-12"); // Austin status-style
    expect(parsePermitDate("2020-07-20T00:00:00")).toBe("2020-07-20"); // SA 2020-24
    expect(parsePermitDate("2025-01-01")).toBe("2025-01-01"); // SA current
  });

  it("never guesses on garbage", () => {
    expect(parsePermitDate(null)).toBe(null);
    expect(parsePermitDate("")).toBe(null);
    expect(parsePermitDate("THURSDAY")).toBe(null);
    expect(parsePermitDate("2026/13/40")).toBe(null);
    expect(parsePermitDate("1492/01/01")).toBe(null);
  });
});

describe("parsePermitValuation", () => {
  it("parses plain and formatted numerics to numeric(14,2) strings", () => {
    expect(parsePermitValuation("3500000.0")).toBe("3500000.00");
    expect(parsePermitValuation("$68,500")).toBe("68500.00");
    expect(parsePermitValuation("0")).toBe("0.00");
  });

  it("nulls garbage, negatives, and out-of-precision values", () => {
    expect(parsePermitValuation(null)).toBe(null);
    expect(parsePermitValuation("N/A")).toBe(null);
    expect(parsePermitValuation("-500")).toBe(null);
    expect(parsePermitValuation("1000000000000")).toBe(null);
  });
});

describe("normalizePermitRow — austin_tx", () => {
  it("maps the verbatim export row", () => {
    const rec = normalizePermitRow({
      metro: "austin_tx",
      header: AUSTIN_HEADER,
      row: austinRow(),
      ...COMMON,
    });
    expect(rec).toMatchObject({
      metro: "austin_tx",
      permitNumber: "2026-061052 EP",
      permitType: "Electrical Permit",
      permitClass: "Commercial",
      workClass: "Wall",
      description: "Mi Casa Family Dentistry",
      status: "Active",
      appliedDate: "2026-05-20",
      issuedDate: "2026-06-11",
      valuation: null,
      addressRaw: "12800 PEARCE LN",
      addressNormalized: "12800 PEARCE LN",
      tcadId: "0330430122",
      sourceFile: "test.csv",
      acquiredDate: "2026-06-21",
    });
  });

  it("normalizes suffix tokens into the shared match key", () => {
    const rec = normalizePermitRow({
      metro: "austin_tx",
      header: AUSTIN_HEADER,
      row: austinRow({ "Original Address 1": "1600 Congress Avenue" }),
      ...COMMON,
    });
    expect(rec?.addressNormalized).toBe("1600 CONGRESS AVE");
  });

  it("skips rows without a permit number", () => {
    const rec = normalizePermitRow({
      metro: "austin_tx",
      header: AUSTIN_HEADER,
      row: austinRow({ "Permit Num": "" }),
      ...COMMON,
    });
    expect(rec).toBe(null);
  });

  it("parses a valuation-bearing remodel row", () => {
    const rec = normalizePermitRow({
      metro: "austin_tx",
      header: AUSTIN_HEADER,
      row: austinRow({ "Total Job Valuation": "68500" }),
      ...COMMON,
    });
    expect(rec?.valuation).toBe("68500.00");
  });
});

describe("normalizePermitRow — san_antonio_tx", () => {
  it("maps the verbatim export row (literal NULLs become null)", () => {
    const rec = normalizePermitRow({
      metro: "san_antonio_tx",
      header: SA_HEADER,
      row: saRow(),
      ...COMMON,
    });
    expect(rec).toMatchObject({
      metro: "san_antonio_tx",
      permitNumber: "COM-BLG-PMT24-40200788",
      permitType: "Comm New Building Permit",
      workClass: "New",
      permitClass: null,
      description: "Building No: N/A; Unit No: N/A",
      status: null, // SA exports carry no status — never fabricated
      appliedDate: "2024-08-02",
      issuedDate: "2025-01-01",
      valuation: "3500000.00",
      addressRaw: "8751 STATE HWY 151",
      addressNormalized: "8751 STATE HWY 151",
      tcadId: null,
    });
  });

  it("keeps trade sub-permits sharing a PERMIT # as distinct rows (distinct hashes)", () => {
    const a = normalizePermitRow({
      metro: "san_antonio_tx",
      header: SA_HEADER,
      row: saRow(),
      ...COMMON,
    });
    const b = normalizePermitRow({
      metro: "san_antonio_tx",
      header: SA_HEADER,
      row: saRow({ "PERMIT TYPE": "Electrical General Permit" }),
      ...COMMON,
    });
    expect(a?.permitNumber).toBe(b?.permitNumber);
    expect(a?.recordHash).not.toBe(b?.recordHash);
  });

  it("derives a match key from a dirty street line with an embedded ZIP", () => {
    const rec = normalizePermitRow({
      metro: "san_antonio_tx",
      header: SA_HEADER,
      row: saRow({ ADDRESS: "9510 Maidenstone Dr 78250" }),
      ...COMMON,
    });
    expect(rec?.addressNormalized).toBe("9510 MAIDENSTONE DR");
    expect(rec?.addressRaw).toBe("9510 Maidenstone Dr 78250");
  });

  it("keeps a row with an unusable address (key null, never guessed)", () => {
    // Real dirty row: a person's name in the address column.
    const rec = normalizePermitRow({
      metro: "san_antonio_tx",
      header: SA_HEADER,
      row: saRow({ ADDRESS: "April Edwards" }),
      ...COMMON,
    });
    expect(rec?.addressNormalized).toBe(null);
    expect(rec?.addressRaw).toBe("April Edwards");
  });
});

describe("permitRecordHash", () => {
  it("is stable for identical rows and distinct across metros", () => {
    const row = saRow();
    expect(permitRecordHash("san_antonio_tx", row)).toBe(
      permitRecordHash("san_antonio_tx", row),
    );
    expect(permitRecordHash("san_antonio_tx", row)).not.toBe(
      permitRecordHash("austin_tx", row),
    );
  });
});

describe("assertPermitHeader", () => {
  it("accepts the matching header and rejects the wrong one", () => {
    expect(() => assertPermitHeader("austin_tx", AUSTIN_HEADER)).not.toThrow();
    expect(() => assertPermitHeader("san_antonio_tx", SA_HEADER)).not.toThrow();
    expect(() => assertPermitHeader("austin_tx", SA_HEADER)).toThrow(
      /missing column/,
    );
    expect(() => assertPermitHeader("san_antonio_tx", AUSTIN_HEADER)).toThrow(
      /missing column/,
    );
  });
});
