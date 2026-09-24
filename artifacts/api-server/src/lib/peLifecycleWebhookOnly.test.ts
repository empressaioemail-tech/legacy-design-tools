/**
 * E4 and E5 are unreachable from any non-webhook path. This is a
 * source-level lock, not just a runtime check: the paid emit helper is
 * imported only by the Stripe webhook module.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8");
}

describe("E4/E5 source lock", () => {
  it("emitPaidFromStripeWebhook is imported only by brokerageStripe.ts", () => {
    const stripe = read("./brokerageStripe.ts");
    expect(stripe).toMatch(/emitPaidFromStripeWebhook/);

    const forbiddenImporters = [
      "./peSignInCompletion.ts",
      "./peGhlContact.ts",
      "./peScreenSave.ts",
      "../routes/peAuth.ts",
      "../routes/peMagicLink.ts",
      "../routes/propertyExplorer.ts",
    ];
    for (const file of forbiddenImporters) {
      expect(read(file)).not.toMatch(/emitPaidFromStripeWebhook|e4_unlock_bought|e5_plan_started/);
    }
  });

  it("a checkout-return shaped call is refused by the runtime guard", async () => {
    const { assertPaidEventFromWebhook } = await import("./peLifecycleOutbox");
    expect(() =>
      assertPaidEventFromWebhook("e4_unlock_bought", "checkout_return_page"),
    ).toThrow(/paid_lifecycle_event_refused:e4_unlock_bought:source=checkout_return_page/);
  });
});
