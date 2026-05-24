import { describe, expect, it } from "vitest";
import type { EngagementDetail } from "@workspace/api-client-react";
import {
  buildPublisherIntakeDraft,
  mergePublisherIntakeDraft,
} from "../buildPublisherIntakeDraft";
import { emptyPublisherIntakeForm } from "../exhibitCConstants";

function engagementFixture(
  overrides: Partial<EngagementDetail> = {},
): EngagementDetail {
  return {
    id: "eng-1",
    name: "Modern Cabin",
    jurisdiction: "Boulder, CO",
    address: "456 Pine St",
    status: "active",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-06-01T00:00:00.000Z",
    snapshotCount: 0,
    latestSnapshot: null,
    snapshots: [],
    site: {
      address: "456 Pine St",
      geocode: null,
      projectType: "new_build",
      zoningCode: "R-1",
      lotAreaSqft: 8500,
    },
    revitCentralGuid: "abc-guid-12345",
    revitDocumentPath: "C:/Projects/ModernCabin.rvt",
    applicantFirm: "Studio Hauska",
    architectOfRecord: null,
    ...overrides,
  };
}

describe("buildPublisherIntakeDraft", () => {
  it("auto-fills plan identity from engagement and model metadata", () => {
    const { form, sources } = buildPublisherIntakeDraft(engagementFixture());
    expect(form.designerPlanName).toBe("Modern Cabin");
    expect(form.designerName).toBe("Studio Hauska");
    expect(form.designerPlanNumber).toBe("ModernCabin");
    expect(sources.designerPlanName).toBe("engagement");
    expect(sources.designerPlanNumber).toBe("model");
    expect(form.planType).toBe("single_family");
    expect(form.architecturalStyles).toContain("Cabin");
  });

  it("preserves manual fields when merging a refreshed draft", () => {
    const draft = buildPublisherIntakeDraft(engagementFixture());
    const manual = {
      ...draft.form,
      abhpNumber: "ABHP-999",
    };
    const sources = {
      ...draft.sources,
      abhpNumber: "manual" as const,
    };
    const refreshed = buildPublisherIntakeDraft(
      engagementFixture({ name: "Renamed Plan" }),
    );
    const merged = mergePublisherIntakeDraft(manual, sources, refreshed);
    expect(merged.form.abhpNumber).toBe("ABHP-999");
    expect(merged.form.designerPlanName).toBe("Renamed Plan");
  });

  it("starts from empty template with full room schedule", () => {
    const empty = emptyPublisherIntakeForm();
    expect(empty.rooms.length).toBeGreaterThan(40);
    expect(empty.planProductsPricing["CAD Files"]).toBe("");
  });
});
