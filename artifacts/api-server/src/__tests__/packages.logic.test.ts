import { describe, expect, it } from "vitest";
import {
  defaultPackageTitle,
  generateShareToken,
  parseCreateEngagementBody,
  parsePatchPackageBody,
  toClientBrief,
} from "../routes/packages.logic";

describe("packages.logic", () => {
  it("parses create engagement body", () => {
    const parsed = parseCreateEngagementBody({
      name: "Test Project",
      address: "123 Main",
    });
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.name).toBe("Test Project");
    }
  });

  it("defaults package titles by template", () => {
    expect(defaultPackageTitle("client-review")).toBe("Client plan review");
  });

  it("generates share tokens", () => {
    expect(generateShareToken()).toHaveLength(48);
  });

  it("parses create engagement body with client fields", () => {
    const parsed = parseCreateEngagementBody({
      name: "Test Project",
      applicantFirm: "Acme LLC",
      clientNotes: "Wants a modern facade",
    });
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.applicantFirm).toBe("Acme LLC");
      expect(parsed.clientNotes).toBe("Wants a modern facade");
    }
  });

  it("extracts client brief from site context", () => {
    const brief = toClientBrief({
      applicantFirm: "Acme LLC",
      siteContextRaw: {
        intake: {
          clientNotes: "Budget ~$400k",
          intakeSource: "paste",
          capturedAt: "2026-05-24T00:00:00.000Z",
        },
      },
    });
    expect(brief?.clientName).toBe("Acme LLC");
    expect(brief?.clientNotes).toBe("Budget ~$400k");
    expect(brief?.intakeSource).toBe("paste");
  });
});
