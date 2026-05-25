import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxDashboardSection } from "../../components/dashboard/InboxDashboardSection";

vi.mock("../../demo/seed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../demo/seed")>();
  return {
    ...actual,
    isDemoSeedEnabled: () => true,
  };
});

describe("Dashboard inbox section", () => {
  it("renders KPI row and chip grid when demo seed is enabled", () => {
    render(<InboxDashboardSection />);
    expect(screen.getByTestId("inbox-action-queue")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-dashboard-kpis")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-item-grid")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-needs-you")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-ai")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-fyi")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-row-inbox-1")).toBeInTheDocument();
  });
});
