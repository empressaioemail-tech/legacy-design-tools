/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 *
 * Verify the inspect payload is a string (tsx __name) and that a Pay Taxes
 * nav plus a free document does not surface a cart control. page.content()
 * on this fixture contains "pay" and would have failed toward paid.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { INSPECT_DOCUMENT_PURCHASE_SOURCE } from "./inspectDocumentPurchaseSource.js";
import { documentRequiresPurchase } from "./recipes/documentPurchase.js";

function runInspect() {
  expect(typeof INSPECT_DOCUMENT_PURCHASE_SOURCE).toBe("string");
  expect(INSPECT_DOCUMENT_PURCHASE_SOURCE.includes("__name")).toBe(false);
  return new Function(`return (${INSPECT_DOCUMENT_PURCHASE_SOURCE})`)();
}

describe("inspectDocumentPurchase source", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("ignores Pay Taxes in nav on a free document", () => {
    document.body.innerHTML = `
      <nav><a href="/taxes">Pay Taxes</a></nav>
      <div class="payment-theme" data-paypal="sdk"></div>
      <main>
        <h1>Official Record 202008880</h1>
        <img alt="page 1" />
        <a href="/doc/1.png">Download image</a>
      </main>
    `;
    const rawHtml = document.documentElement.outerHTML.toLowerCase();
    expect(rawHtml.includes("pay")).toBe(true);
    const signal = runInspect();
    expect(signal.visibleMainControls.join(" ")).not.toMatch(/pay taxes/i);
    expect(documentRequiresPurchase(signal)).toBe(false);
  });

  it("sees Add to cart on the document surface", () => {
    document.body.innerHTML = `
      <nav><a href="/taxes">Pay Taxes</a></nav>
      <main>
        <h1>Official Record 202008880</h1>
        <button>Add to cart</button>
      </main>
    `;
    const signal = runInspect();
    expect(documentRequiresPurchase(signal)).toBe(true);
  });
});
