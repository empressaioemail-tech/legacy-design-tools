import { describe, expect, it } from "vitest";
import { highestStage, stageForPlan } from "./peLifecycleTypes";

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
