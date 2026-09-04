import { describe, expect, it } from "vitest";
import {
  documentRequiresPurchase,
  type DocumentPurchaseSignal,
} from "./documentPurchase.js";

const FREE_WITH_TAX_NAV: DocumentPurchaseSignal = {
  visibleMainText: "Official Record 202008880\nPage 1 of 3",
  visibleMainControls: ["View", "Download image"],
  rowPriceText: null,
};

describe("documentRequiresPurchase", () => {
  it("does not treat a Pay Taxes nav link as a document purchase wall", () => {
    expect(documentRequiresPurchase(FREE_WITH_TAX_NAV)).toBe(false);
  });

  it("does not treat payment CSS or paypal script text as a wall", () => {
    expect(
      documentRequiresPurchase({
        visibleMainText: "Official Record",
        visibleMainControls: ["View"],
        rowPriceText: null,
      }),
    ).toBe(false);
  });

  it("requires purchase when the document surface has Add to cart", () => {
    expect(
      documentRequiresPurchase({
        visibleMainText: "Official Record 202008880",
        visibleMainControls: ["Add to cart"],
        rowPriceText: null,
      }),
    ).toBe(true);
  });

  it("requires purchase when this row published a price", () => {
    expect(
      documentRequiresPurchase({
        ...FREE_WITH_TAX_NAV,
        rowPriceText: "$3.50",
      }),
    ).toBe(true);
  });

  it("requires purchase on a document interstitial", () => {
    expect(
      documentRequiresPurchase({
        visibleMainText: "Purchase this document to continue",
        visibleMainControls: ["Purchase this document"],
        rowPriceText: null,
      }),
    ).toBe(true);
  });
});
