import { describe, it, expect, afterEach } from "vitest";
import {
  brokerageBriefRetrievalMode,
  isBrokerageBriefViaGateEnabled,
} from "../brokerageSpineGate";

describe("brokerageSpineGate", () => {
  afterEach(() => {
    delete process.env.BROKERAGE_BRIEF_VIA_GATE;
    delete process.env.BRIEF_CODE_RETRIEVAL;
  });

  it("enables gate retrieval when BROKERAGE_BRIEF_VIA_GATE=true", () => {
    process.env.BROKERAGE_BRIEF_VIA_GATE = "true";
    expect(isBrokerageBriefViaGateEnabled()).toBe(true);
    expect(brokerageBriefRetrievalMode()).toBe("gate");
  });

  it("defaults to neon when flag off", () => {
    expect(brokerageBriefRetrievalMode()).toBe("neon");
  });
});
