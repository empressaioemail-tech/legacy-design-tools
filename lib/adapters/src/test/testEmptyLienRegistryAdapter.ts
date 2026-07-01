/**
 * Test adapter — returns empty liens for harness jurisdiction.
 * Used by verified-absence self-test (Wave 1).
 */

import type { Adapter, AdapterContext, AdapterResult } from "../types.js";

export const testEmptyLienRegistryAdapter: Adapter = {
  adapterKey: "test:empty-registry",
  tier: "federal",
  sourceKind: "federal-adapter",
  layerKind: "test-empty-lien",
  provider: "Test Empty Lien Registry",
  jurisdictionGate: {},
  appliesTo(ctx: AdapterContext): boolean {
    return ctx.jurisdiction.stateKey === "texas";
  },
  async run(ctx): Promise<AdapterResult> {
    const now = new Date().toISOString();
    const jurisdiction =
      ctx.jurisdiction.localKey ?? ctx.jurisdiction.stateKey ?? "unknown";
    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: this.provider,
      snapshotDate: now,
      payload: {
        kind: "test-empty-lien",
        records: [],
      },
      verifiedAbsence: {
        absenceDomain: "lien",
        whatWasChecked: "property-lien index",
        checkScope: {
          jurisdiction,
          record_type: "property-lien",
          date_range_start: "2000-01-01",
          date_range_end: now.slice(0, 10),
        },
        checkMethod: "registry_lookup",
        checkDate: now,
      },
    };
  },
};
