/**
 * Purchase required is a property of THIS instrument, not of the page HTML.
 * page.content().includes("pay") matches "Pay Taxes" nav, payment CSS, and
 * paypal script tags. That fails toward paid, so capture never runs.
 */

export interface DocumentPurchaseSignal {
  /** Visible text from the document surface. Not raw HTML. */
  visibleMainText: string;
  /** Visible control labels on the document surface, not nav/header/footer. */
  visibleMainControls: string[];
  /** Price cell on this instrument's index row, if the grid published one. */
  rowPriceText: string | null;
}

const CART_CONTROL =
  /\b(add to cart|purchase (this|document|image|copy)|buy (this|document|image|copy)|checkout)\b/i;

const PRICE = /\$\s*\d|\b\d+\s*cents?\b|\bfee:\s*\d/i;

export function documentRequiresPurchase(
  signal: DocumentPurchaseSignal,
): boolean {
  if (signal.rowPriceText && PRICE.test(signal.rowPriceText.trim())) {
    return true;
  }
  for (const label of signal.visibleMainControls) {
    if (CART_CONTROL.test(label)) return true;
  }
  if (CART_CONTROL.test(signal.visibleMainText)) return true;
  return false;
}

export const PURCHASE_APPROVED_ROUTES_TO_HUMAN =
  "purchaseApproved queues a human clerk; this card does not drive checkout";
