import { describe, expect, it } from "vitest";
import { highestStage, nextStage, stageForPlan } from "./ssContactStage";

describe("highestStage — forward only, including a skip", () => {
  it("moves Explorer → Sharer", () => {
    expect(highestStage("Explorer", "Sharer")).toBe("Sharer");
  });

  it("a plan with no share skips Sharer and Unlock: Explorer → Solo", () => {
    expect(highestStage("Explorer", "Solo")).toBe("Solo");
  });

  it("does not move the stage backward on a downgrade", () => {
    expect(highestStage("Solo", "Explorer")).toBe("Solo");
    expect(highestStage("Team", "Unlock")).toBe("Team");
  });

  it("null current takes the next stage", () => {
    expect(highestStage(null, "Explorer")).toBe("Explorer");
  });
});

describe("stageForPlan", () => {
  it("maps paid plans and leaves free with no stage of its own", () => {
    expect(stageForPlan("unlock")).toBe("Unlock");
    expect(stageForPlan("solo")).toBe("Solo");
    expect(stageForPlan("studio")).toBe("Studio");
    expect(stageForPlan("team")).toBe("Team");
    expect(stageForPlan("free")).toBeNull();
  });
});

// Ported from the retired peGhlLifecycle.test.ts ("a plan with no share skips
// to Solo") and the nextStage switch it exercised, now in its new home.
describe("nextStage — moved intact from the GoHighLevel leg", () => {
  it("E1 lands a new contact on Explorer", () => {
    expect(nextStage({ event: "e1_account_created", currentStage: null })).toBe("Explorer");
  });

  it("a plan with no share skips to Solo", () => {
    expect(
      nextStage({ event: "e5_plan_started", currentStage: "Explorer", plan: "solo" }),
    ).toBe("Solo");
  });

  it("a share moves Explorer to Sharer but never moves Unlock back", () => {
    expect(nextStage({ event: "e3_share_sent", currentStage: "Explorer" })).toBe("Sharer");
    expect(nextStage({ event: "e3_share_sent", currentStage: "Unlock" })).toBe("Unlock");
  });

  it("an unlock never moves a Studio contact back", () => {
    expect(nextStage({ event: "e4_unlock_bought", currentStage: "Studio" })).toBe("Studio");
  });

  it("a downgrade to a lower plan keeps the stage", () => {
    expect(
      nextStage({ event: "e5_plan_started", currentStage: "Team", plan: "solo" }),
    ).toBe("Team");
  });

  it("count and activity events keep the stage", () => {
    expect(nextStage({ event: "e2_lot_saved", currentStage: "Sharer" })).toBe("Sharer");
    expect(nextStage({ event: "e6_last_active", currentStage: null })).toBe("Explorer");
    expect(nextStage({ event: "plan_cancelled", currentStage: "Solo" })).toBe("Solo");
  });
});
