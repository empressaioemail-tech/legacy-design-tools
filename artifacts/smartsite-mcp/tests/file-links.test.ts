import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FILE_LINK_TTL_MS, mintFileLink, verifyFileLink } from "../src/file-links.js";

describe("export download links (fix register B3/C3)", () => {
  const prev = process.env.SMARTSITE_FILE_LINK_SECRET;
  beforeEach(() => {
    process.env.SMARTSITE_FILE_LINK_SECRET = "test-secret";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SMARTSITE_FILE_LINK_SECRET;
    else process.env.SMARTSITE_FILE_LINK_SECRET = prev;
  });

  it("mints nothing when the secret is unset, so the export stays inline", () => {
    delete process.env.SMARTSITE_FILE_LINK_SECRET;
    expect(mintFileLink("feasibility", "48021:27273")).toBeNull();
  });

  it("round-trips a link to its parcel", () => {
    const link = mintFileLink("feasibility", "48021:27273", 1_000)!;
    expect(link.url).toMatch(/^https:\/\/mcp\.smartsite\.cloud\/files\/feasibility\//);
    const token = link.url.split("/").pop()!;
    expect(verifyFileLink("feasibility", token, 2_000)).toEqual({ parcelNodeId: "48021:27273" });
  });

  it("refuses an expired, tampered or wrong-kind link", () => {
    const token = mintFileLink("feasibility", "48021:27273", 0)!.url.split("/").pop()!;
    expect(verifyFileLink("feasibility", token, FILE_LINK_TTL_MS + 1)).toEqual({ refused: "expired" });
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "feasibility", p: "48021:1", e: 9e15 })).toString("base64url");
    expect(verifyFileLink("feasibility", `${forged}.${sig}`, 1)).toEqual({ refused: "invalid" });
    expect(verifyFileLink("feasibility", `${payload}.x${sig}`, 1)).toEqual({ refused: "invalid" });
  });
});
