import { describe, expect, it } from "vitest";
import {
  assertLifecyclePayloadSafe,
  findForbiddenLifecycleFields,
} from "./peLifecycleDenylist";

describe("lifecycle payload denylist", () => {
  it("allows counts, dates, plan and source", () => {
    expect(
      findForbiddenLifecycleFields({
        email: "a@b.com",
        tags: ["ss_explorer", "ss_src_ad"],
        customFields: [
          { id: "f1", field_value: "free" },
          { id: "f2", field_value: "3" },
        ],
      }),
    ).toEqual([]);
  });

  it("fails if a note body reaches the payload", () => {
    const hits = findForbiddenLifecycleFields({
      email: "a@b.com",
      note: "look at the flood on this lot",
    });
    expect(hits.some((h) => h.key === "note")).toBe(true);
    expect(() =>
      assertLifecyclePayloadSafe({ note: "look at the flood on this lot" }),
    ).toThrow(/lifecycle_payload_denied/);
  });

  it("fails if an owner name reaches the payload", () => {
    expect(
      findForbiddenLifecycleFields({ ownerName: "SMITH, JANE" }).map((h) => h.key),
    ).toContain("ownerName");
  });

  it("fails if a parcel field reaches the payload", () => {
    expect(
      findForbiddenLifecycleFields({ parcelNodeId: "48055:10068" }).map(
        (h) => h.key,
      ),
    ).toContain("parcelNodeId");
  });

  it("the allowed fixture would fail if the denylist were deleted (control)", () => {
    // A deliberately broken payload that a mute denylist would accept.
    const broken = { note: "secret", ownerName: "X", parcelNodeId: "1" };
    expect(findForbiddenLifecycleFields(broken).length).toBeGreaterThanOrEqual(3);
  });
});
