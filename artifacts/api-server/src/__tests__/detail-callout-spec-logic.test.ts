/**
 * Unit coverage for the L4 pure logic
 * (`routes/detailCalloutSpec.logic.ts`) — discriminated-spec
 * validation + push-state machine. No database.
 */

import { describe, it, expect } from "vitest";
import {
  parseCreateDetailCalloutSpecBody,
  parsePushStateBody,
  parseApsRefBody,
  parsePushStateFilter,
  pushStateTransitionEvent,
  isLegalPushTransition,
  isDetailCalloutPushState,
} from "../routes/detailCalloutSpec.logic";

const ROOM_FINISH_SPEC = {
  detailType: "room-finish",
  roomName: "Lobby",
  roomNumber: "101",
  floorFinish: "polished concrete",
  baseFinish: "rubber",
  wallFinish: "paint",
  ceilingFinish: "ACT",
  ceilingHeight: "9'-0\"",
};

describe("parseCreateDetailCalloutSpecBody", () => {
  it("accepts a valid room-finish spec", () => {
    const r = parseCreateDetailCalloutSpecBody({ spec: ROOM_FINISH_SPEC });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.spec.detailType).toBe("room-finish");
  });

  it("accepts a valid door-schedule spec", () => {
    const r = parseCreateDetailCalloutSpecBody({
      spec: {
        detailType: "door-schedule",
        rows: [
          {
            doorMark: "D1",
            doorType: "single",
            width: "3'-0\"",
            height: "7'-0\"",
            material: "HM",
            fireRating: "20 min",
            hardwareSet: "HW-1",
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown detailType", () => {
    expect(
      parseCreateDetailCalloutSpecBody({ spec: { detailType: "ceiling-grid" } }),
    ).toMatchObject({ ok: false, error: "invalid_spec" });
  });

  it("rejects a per-type payload missing a required field", () => {
    const incomplete = { ...ROOM_FINISH_SPEC };
    delete (incomplete as Record<string, unknown>).ceilingHeight;
    expect(
      parseCreateDetailCalloutSpecBody({ spec: incomplete }),
    ).toMatchObject({ ok: false, error: "invalid_spec" });
  });

  it("rejects a missing spec", () => {
    expect(parseCreateDetailCalloutSpecBody({})).toMatchObject({
      ok: false,
      error: "invalid_spec",
    });
  });

  it("carries optional linking ids through", () => {
    const r = parseCreateDetailCalloutSpecBody({
      spec: ROOM_FINISH_SPEC,
      findingId: " f-1 ",
      responseTaskId: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.findingId).toBe("f-1");
    expect(r.value.responseTaskId).toBeNull();
  });
});

describe("parsePushStateBody", () => {
  it("accepts a valid push state", () => {
    expect(parsePushStateBody({ pushState: "pushed" })).toEqual({
      ok: true,
      value: "pushed",
    });
  });
  it("rejects an unknown push state", () => {
    expect(parsePushStateBody({ pushState: "queued" })).toMatchObject({
      ok: false,
      error: "invalid_push_state",
    });
  });
});

describe("parseApsRefBody", () => {
  it("accepts and trims a non-empty ref", () => {
    expect(parseApsRefBody({ apsTaskRef: "  aps-9  " })).toEqual({
      ok: true,
      value: "aps-9",
    });
  });
  it("rejects an empty or missing ref", () => {
    expect(parseApsRefBody({ apsTaskRef: "" })).toMatchObject({
      ok: false,
      error: "invalid_aps_task_ref",
    });
    expect(parseApsRefBody({})).toMatchObject({
      ok: false,
      error: "invalid_aps_task_ref",
    });
  });
});

describe("parsePushStateFilter", () => {
  it("resolves an absent filter to null", () => {
    expect(parsePushStateFilter(undefined)).toEqual({ ok: true, value: null });
  });
  it("rejects an unknown filter", () => {
    expect(parsePushStateFilter("queued")).toMatchObject({
      ok: false,
      error: "invalid_push_state",
    });
  });
});

describe("isLegalPushTransition (engine helper)", () => {
  it("permits the forward lifecycle and the revise path", () => {
    expect(isLegalPushTransition("pending", "pushed")).toBe(true);
    expect(isLegalPushTransition("pushed", "applied")).toBe(true);
    expect(isLegalPushTransition("pushed", "rejected-by-user")).toBe(true);
    expect(isLegalPushTransition("rejected-by-user", "pending")).toBe(true);
  });

  it("forbids skipping states and any transition out of applied", () => {
    expect(isLegalPushTransition("pending", "applied")).toBe(false);
    expect(isLegalPushTransition("applied", "pending")).toBe(false);
    expect(isLegalPushTransition("pushed", "pending")).toBe(false);
  });
});

describe("pushStateTransitionEvent", () => {
  it("names the contract events and leaves the revise path eventless", () => {
    expect(pushStateTransitionEvent("pushed")).toBe(
      "detail-callout-spec.pushed",
    );
    expect(pushStateTransitionEvent("applied")).toBe(
      "detail-callout-spec.applied",
    );
    expect(pushStateTransitionEvent("rejected-by-user")).toBe(
      "detail-callout-spec.rejected",
    );
    expect(pushStateTransitionEvent("pending")).toBeNull();
  });
});

describe("isDetailCalloutPushState", () => {
  it("accepts the four states and rejects others", () => {
    for (const s of ["pending", "pushed", "applied", "rejected-by-user"]) {
      expect(isDetailCalloutPushState(s)).toBe(true);
    }
    expect(isDetailCalloutPushState("queued")).toBe(false);
  });
});
