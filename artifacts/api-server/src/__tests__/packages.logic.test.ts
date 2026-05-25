import { describe, expect, it } from "vitest";
import {
  defaultPackageTitle,
  generateShareToken,
  mergeIntakePatchIntoSiteContextRaw,
  parseCreateEngagementBody,
  parsePatchPackageBody,
  sanitizePackageSelection,
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

  it("sanitizes invalid selection ids", () => {
    const ctx = {
      renderIds: new Set(["r1"]),
      videoIds: new Set(["v1"]),
      sheetIds: new Set(["s1"]),
    };
    const out = sanitizePackageSelection(
      {
        renderIds: ["r1", "bad"],
        videoIds: ["v1", "bad"],
        sheetIds: ["s1", "bad"],
        heroRenderId: "bad",
      },
      ctx,
    );
    expect(out.renderIds).toEqual(["r1"]);
    expect(out.videoIds).toEqual(["v1"]);
    expect(out.sheetIds).toEqual(["s1"]);
    expect(out.heroRenderId).toBe("r1");
  });

  it("merges intake patch into site context", () => {
    const merged = mergeIntakePatchIntoSiteContextRaw(
      { intake: { clientNotes: "Old" }, geocode: { lat: 1 } },
      { clientNotes: "Updated notes", clientEmail: "a@b.com" },
    );
    expect(merged?.intake).toMatchObject({
      clientNotes: "Updated notes",
      clientEmail: "a@b.com",
    });
    expect(merged?.geocode).toEqual({ lat: 1 });
  });
});
