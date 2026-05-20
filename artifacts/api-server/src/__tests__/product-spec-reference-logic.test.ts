/**
 * Unit coverage for the L5 pure logic — request validation
 * (`routes/productSpecReference.logic.ts`) + the ICC-ES URL builder
 * and status parser (`lib/iccEsClient.ts`). No network, no database;
 * the live ICC-ES poll runs only at runtime.
 */

import { describe, it, expect } from "vitest";
import {
  parseCreateProductSpecReferenceBody,
  parseStatusFilter,
  isProductSpecStatus,
} from "../routes/productSpecReference.logic";
import { iccEsReportUrl, parseIccEsStatus } from "../lib/iccEsClient";

const VALID_PRODUCT = {
  name: "Strong-Drive SDWS Timber Screw",
  manufacturer: "Simpson Strong-Tie",
};

describe("parseCreateProductSpecReferenceBody", () => {
  it("accepts a valid body", () => {
    const r = parseCreateProductSpecReferenceBody({
      product: VALID_PRODUCT,
      esrNumber: "ESR-1234",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.product.name).toBe(VALID_PRODUCT.name);
      expect(r.value.esrNumber).toBe("ESR-1234");
    }
  });

  it("rejects a missing or malformed product", () => {
    expect(
      parseCreateProductSpecReferenceBody({ esrNumber: "ESR-1" }),
    ).toMatchObject({ ok: false, error: "invalid_product" });
    expect(
      parseCreateProductSpecReferenceBody({
        product: { name: "x", manufacturer: "" },
        esrNumber: "ESR-1",
      }),
    ).toMatchObject({ ok: false, error: "invalid_product" });
  });

  it("rejects a malformed ESR number", () => {
    for (const esr of ["1234", "ESR1234", "ESR-", "esr-12", "ESR-12a"]) {
      expect(
        parseCreateProductSpecReferenceBody({ product: VALID_PRODUCT, esrNumber: esr }),
      ).toMatchObject({ ok: false, error: "invalid_esr_number" });
    }
  });

  it("trims the ESR number and accepts it", () => {
    const r = parseCreateProductSpecReferenceBody({
      product: VALID_PRODUCT,
      esrNumber: "  ESR-2929  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.esrNumber).toBe("ESR-2929");
  });

  it("carries optional linking ids through", () => {
    const r = parseCreateProductSpecReferenceBody({
      product: VALID_PRODUCT,
      esrNumber: "ESR-7",
      findingId: " f-1 ",
      responseTaskId: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.findingId).toBe("f-1");
    expect(r.value.responseTaskId).toBeNull();
  });
});

describe("parseStatusFilter", () => {
  it("resolves an absent filter to null", () => {
    expect(parseStatusFilter(undefined)).toEqual({ ok: true, value: null });
  });
  it("accepts a valid status and rejects an unknown one", () => {
    expect(parseStatusFilter("withdrawn")).toEqual({
      ok: true,
      value: "withdrawn",
    });
    expect(parseStatusFilter("revoked")).toMatchObject({
      ok: false,
      error: "invalid_status",
    });
  });
});

describe("isProductSpecStatus", () => {
  it("accepts the three statuses, rejects others", () => {
    for (const s of ["active", "withdrawn", "expired"]) {
      expect(isProductSpecStatus(s)).toBe(true);
    }
    expect(isProductSpecStatus("revoked")).toBe(false);
  });
});

describe("iccEsReportUrl", () => {
  it("substitutes the ESR number into the URL template", () => {
    const url = iccEsReportUrl("ESR-1310");
    expect(url).toContain("ESR-1310");
    expect(url.startsWith("http")).toBe(true);
  });
});

describe("parseIccEsStatus", () => {
  it("detects withdrawn / expired markers", () => {
    expect(parseIccEsStatus("<p>This report has been WITHDRAWN.</p>")).toBe(
      "withdrawn",
    );
    expect(parseIccEsStatus("Report status: Expired")).toBe("expired");
  });

  it("detects an active marker", () => {
    expect(parseIccEsStatus("<span>Status: Active</span>")).toBe("active");
  });

  it("returns null when no marker is present", () => {
    expect(parseIccEsStatus("<html><body>no status here</body></html>")).toBe(
      null,
    );
  });
});
