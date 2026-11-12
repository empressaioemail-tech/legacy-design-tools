import { describe, expect, it } from "vitest";
import {
  districtConfidenceFromLabel,
  districtConfidenceFromRaw,
  districtDisclosure,
  mergeDistrictConfidence,
} from "./districtConfidence";

describe("districtConfidence mapping", () => {
  it("high is confirmed, any other present label is review, absent is null", () => {
    expect(districtConfidenceFromLabel("high")?.level).toBe("confirmed");
    expect(districtConfidenceFromLabel("HIGH")?.level).toBe("confirmed");
    expect(districtConfidenceFromLabel("medium")).toEqual({ level: "review", label: "medium" });
    expect(districtConfidenceFromLabel("low")?.level).toBe("review");
    expect(districtConfidenceFromLabel("0.4")?.level).toBe("review");
    expect(districtConfidenceFromLabel(null)).toBeNull();
    expect(districtConfidenceFromLabel(undefined)).toBeNull();
  });

  it("reads a factory cell's carried label or level", () => {
    expect(districtConfidenceFromRaw({ zoningConfidence: "medium", districtConfidence: "review" })?.level).toBe("review");
    expect(districtConfidenceFromRaw({ districtConfidence: "review" })?.level).toBe("review");
    expect(districtConfidenceFromRaw({ kind: "value", value: 20 })).toBeNull();
    expect(districtConfidenceFromRaw(null)).toBeNull();
  });

  it("review wins a merge; confirmed disclosure is null", () => {
    const review = { level: "review" as const, label: "medium" };
    const ok = { level: "confirmed" as const, label: "high" };
    expect(mergeDistrictConfidence(ok, review)).toBe(review);
    expect(mergeDistrictConfidence(review, ok)).toBe(review);
    expect(mergeDistrictConfidence(null, ok)).toBe(ok);
    expect(mergeDistrictConfidence(null, null)).toBeNull();
    expect(districtDisclosure(ok)).toBeNull();
    expect(districtDisclosure(null)).toBeNull();
  });
});
