/**
 * Metering signals for MCP service callers on brokerage Layer 2 routes.
 *
 * The MCP gate (not cortex-api's wallet paywall) is the Layer 2 metering
 * authority for service-token callers. These constants surface the billable
 * SKU so hauska-mcp-server can account calls once SDK charging lands.
 */

export const BROKERAGE_BRIEF_BILLABLE_SKU = "property-brief-v1";

export const BROKERAGE_BRIEF_BILLABLE_HEADER = "X-Hauska-Billable";

export type BrokerageMeteringSignal = {
  billable: true;
  sku: typeof BROKERAGE_BRIEF_BILLABLE_SKU;
};

export function brokerageBriefMeteringMeta(): {
  metering: BrokerageMeteringSignal;
} {
  return {
    metering: {
      billable: true,
      sku: BROKERAGE_BRIEF_BILLABLE_SKU,
    },
  };
}
