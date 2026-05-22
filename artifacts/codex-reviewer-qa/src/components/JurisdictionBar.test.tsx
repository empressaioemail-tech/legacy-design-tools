import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JurisdictionBar } from "./JurisdictionBar";
import { makeJurisdiction } from "../__fixtures__/jurisdiction";

describe("JurisdictionBar", () => {
  it("renders nothing until an engagement is selected", () => {
    const { container } = render(
      <JurisdictionBar engagement={null} submission={null} jurisdictions={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the engagement's recorded jurisdiction", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Grand County" }}
        submission={null}
        jurisdictions={[]}
      />,
    );
    expect(screen.getByTestId("jurisdiction-name").textContent).toBe(
      "Grand County",
    );
  });

  it("shows the indexed corpus when the label matches", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Grand County" }}
        submission={null}
        jurisdictions={[
          makeJurisdiction({
            key: "grand-county",
            displayName: "Grand County",
            atomCount: 1240,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("jurisdiction-corpus").textContent).toContain(
      "indexed code atoms",
    );
    expect(screen.queryByTestId("jurisdiction-corpus-missing")).toBeNull();
  });

  it("warns when no indexed corpus matches the jurisdiction label", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Travis County" }}
        submission={null}
        jurisdictions={[
          makeJurisdiction({ key: "grand-county", displayName: "Grand County" }),
        ]}
      />,
    );
    expect(screen.getByTestId("jurisdiction-corpus-missing")).toBeTruthy();
  });

  it("does not claim a missing corpus while the list is loading", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Travis County" }}
        submission={null}
        jurisdictions={[]}
        corpusLoading
      />,
    );
    expect(screen.queryByTestId("jurisdiction-corpus-missing")).toBeNull();
  });

  it("flags an engagement with no jurisdiction recorded", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: null }}
        submission={null}
        jurisdictions={[]}
      />,
    );
    expect(screen.getByTestId("jurisdiction-name").textContent).toBe(
      "Not recorded",
    );
    expect(screen.getByTestId("jurisdiction-empty")).toBeTruthy();
  });

  it("warns when the submission's filed jurisdiction is stale", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Bastrop UDC" }}
        submission={{ jurisdiction: "Grand County" }}
        jurisdictions={[]}
      />,
    );
    const warning = screen.getByTestId("jurisdiction-snapshot-warning");
    expect(warning.textContent).toContain("Grand County");
    expect(warning.textContent).toContain("Bastrop UDC");
  });

  it("does not warn when the submission jurisdiction matches", () => {
    render(
      <JurisdictionBar
        engagement={{ jurisdiction: "Bastrop UDC" }}
        submission={{ jurisdiction: "Bastrop UDC" }}
        jurisdictions={[]}
      />,
    );
    expect(screen.queryByTestId("jurisdiction-snapshot-warning")).toBeNull();
  });
});
