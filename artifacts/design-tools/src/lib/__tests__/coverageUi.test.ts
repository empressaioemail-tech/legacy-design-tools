import { describe, expect, it } from "vitest";
import {
  canRunPlanReview,
  isCoverageInformational,
  shouldShowRequestCoverage,
} from "../coverageUi";

describe("canRunPlanReview", () => {
  it("allows run when jurisdiction resolves regardless of coverage status", () => {
    expect(canRunPlanReview("Miami Beach, FL", "warming")).toBe(true);
    expect(canRunPlanReview("Miami Beach, FL", "not_in_catalog")).toBe(true);
    expect(canRunPlanReview("Miami Beach, FL", "substrate_only")).toBe(true);
    expect(canRunPlanReview("Miami Beach, FL", "ready")).toBe(true);
    expect(canRunPlanReview("miami_beach_fl", undefined)).toBe(true);
  });

  it("blocks run only when jurisdiction is missing", () => {
    expect(canRunPlanReview(null, "ready")).toBe(false);
    expect(canRunPlanReview(undefined, "ready")).toBe(false);
    expect(canRunPlanReview("   ", "ready")).toBe(false);
  });
});

describe("isCoverageInformational", () => {
  it("is true for non-ready statuses", () => {
    expect(isCoverageInformational("warming")).toBe(true);
    expect(isCoverageInformational("not_in_catalog")).toBe(true);
    expect(isCoverageInformational("substrate_only")).toBe(true);
    expect(isCoverageInformational("unknown")).toBe(true);
  });

  it("is false when ready or absent", () => {
    expect(isCoverageInformational("ready")).toBe(false);
    expect(isCoverageInformational(undefined)).toBe(false);
  });
});

describe("shouldShowRequestCoverage", () => {
  it("still offers request coverage for catalog gaps", () => {
    expect(shouldShowRequestCoverage("not_in_catalog")).toBe(true);
    expect(shouldShowRequestCoverage("substrate_only")).toBe(true);
    expect(shouldShowRequestCoverage("warming")).toBe(false);
  });
});
