/**
 * RTL smoke test for the read-only Revit binding section (A04.7 frontend
 * scope). One test file, two cases: visible-and-correct vs. hidden-when-empty.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RevitBinding } from "../RevitBinding";

describe("RevitBinding", () => {
  it("renders nothing when neither GUID nor document path is present", () => {
    const { container } = render(
      <RevitBinding revitCentralGuid={null} revitDocumentPath={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a truncated GUID pill (full value on title) and the verbatim document path", () => {
    const guid = "12345678-9abc-def0-1234-56789abcdef0";
    const path = "C:/projects/Smith Residence/Smith.rvt";

    render(<RevitBinding revitCentralGuid={guid} revitDocumentPath={path} />);

    expect(screen.getByText("REVIT BINDING")).toBeInTheDocument();
    expect(screen.getByText("Central GUID")).toBeInTheDocument();
    expect(screen.getByText("Document path")).toBeInTheDocument();

    // GUID is truncated in the visible text (full value never appears literally).
    // Truncation is `slice(0,8) + … + slice(-7)`, so we expect "12345678…abcdef0".
    expect(screen.queryByText(guid)).not.toBeInTheDocument();
    const guidPill = screen.getByText("12345678…abcdef0");
    expect(guidPill).toBeInTheDocument();
    // ...but the full GUID is reachable via the title attribute for hover/AT.
    expect(guidPill).toHaveAttribute("title", guid);
    expect(guidPill).toHaveAttribute(
      "aria-label",
      `Revit central GUID ${guid}`,
    );

    // Document path is rendered verbatim, no truncation.
    expect(screen.getByText(path)).toBeInTheDocument();
  });
});
