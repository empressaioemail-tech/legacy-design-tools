/**
 * Unit coverage for the L1 response-task pure logic
 * (`routes/responseTasks.logic.ts`) — the request-validation and
 * state-machine layer that the route handler is a thin DB/HTTP shell
 * around. No database; the full route integration coverage (404s,
 * persistence, audit events) runs in CI against a live Postgres.
 */

import { describe, it, expect } from "vitest";
import {
  RESPONSE_TASK_LEGAL_TRANSITIONS,
  isLegalResponseTaskTransition,
  responseTaskTransitionEvent,
  parseCreateResponseTaskBody,
  parseStateBody,
  parseLinkFindingBody,
  parseStateFilter,
  isResponseTaskState,
} from "../routes/responseTasks.logic";

describe("isLegalResponseTaskTransition", () => {
  it("allows every forward transition out of open", () => {
    expect(isLegalResponseTaskTransition("open", "in-progress")).toBe(true);
    expect(isLegalResponseTaskTransition("open", "done")).toBe(true);
    expect(isLegalResponseTaskTransition("open", "cancelled")).toBe(true);
  });

  it("allows in-progress to complete, cancel, or drop back to open", () => {
    expect(isLegalResponseTaskTransition("in-progress", "done")).toBe(true);
    expect(isLegalResponseTaskTransition("in-progress", "cancelled")).toBe(
      true,
    );
    expect(isLegalResponseTaskTransition("in-progress", "open")).toBe(true);
  });

  it("allows reopening from the terminal-ish states", () => {
    expect(isLegalResponseTaskTransition("done", "in-progress")).toBe(true);
    expect(isLegalResponseTaskTransition("cancelled", "open")).toBe(true);
  });

  it("forbids a no-op same-state transition", () => {
    expect(isLegalResponseTaskTransition("open", "open")).toBe(false);
    expect(isLegalResponseTaskTransition("done", "done")).toBe(false);
  });

  it("forbids skipping straight from done to cancelled", () => {
    expect(isLegalResponseTaskTransition("done", "cancelled")).toBe(false);
    expect(isLegalResponseTaskTransition("cancelled", "done")).toBe(false);
    expect(isLegalResponseTaskTransition("done", "open")).toBe(false);
  });

  it("never names a state as its own legal next state", () => {
    for (const [from, tos] of Object.entries(
      RESPONSE_TASK_LEGAL_TRANSITIONS,
    )) {
      expect(tos).not.toContain(from);
    }
  });
});

describe("responseTaskTransitionEvent", () => {
  it("maps each target state to its dot-form event type", () => {
    expect(responseTaskTransitionEvent("in-progress")).toBe(
      "response-task.progressed",
    );
    expect(responseTaskTransitionEvent("open")).toBe(
      "response-task.progressed",
    );
    expect(responseTaskTransitionEvent("done")).toBe(
      "response-task.completed",
    );
    expect(responseTaskTransitionEvent("cancelled")).toBe(
      "response-task.cancelled",
    );
  });
});

describe("isResponseTaskState", () => {
  it("accepts the four valid states and rejects everything else", () => {
    for (const s of ["open", "in-progress", "done", "cancelled"]) {
      expect(isResponseTaskState(s)).toBe(true);
    }
    expect(isResponseTaskState("archived")).toBe(false);
    expect(isResponseTaskState("")).toBe(false);
    expect(isResponseTaskState(42)).toBe(false);
    expect(isResponseTaskState(null)).toBe(false);
  });
});

describe("parseCreateResponseTaskBody", () => {
  it("accepts a minimal valid body and defaults the optionals", () => {
    const result = parseCreateResponseTaskBody({
      title: "  Resolve egress comment  ",
      description: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      title: "Resolve egress comment",
      description: "",
      sourceClientCommentId: null,
      findingId: null,
      dueAt: null,
      actorId: null,
      principalActorId: null,
    });
  });

  it("treats a missing description as the empty string", () => {
    const result = parseCreateResponseTaskBody({ title: "T" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.description).toBe("");
  });

  it("rejects a missing or empty title", () => {
    expect(parseCreateResponseTaskBody({ description: "" })).toMatchObject({
      ok: false,
      error: "invalid_title",
    });
    expect(
      parseCreateResponseTaskBody({ title: "   ", description: "" }),
    ).toMatchObject({ ok: false, error: "invalid_title" });
  });

  it("rejects a non-object body", () => {
    expect(parseCreateResponseTaskBody(null)).toMatchObject({
      ok: false,
      error: "invalid_request_body",
    });
    expect(parseCreateResponseTaskBody("nope")).toMatchObject({
      ok: false,
      error: "invalid_request_body",
    });
  });

  it("rejects a non-string description", () => {
    expect(
      parseCreateResponseTaskBody({ title: "T", description: 7 }),
    ).toMatchObject({ ok: false, error: "invalid_description" });
  });

  it("normalizes a valid dueAt to an ISO string", () => {
    const result = parseCreateResponseTaskBody({
      title: "T",
      description: "",
      dueAt: "2026-06-01",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dueAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rejects an unparseable dueAt", () => {
    expect(
      parseCreateResponseTaskBody({
        title: "T",
        description: "",
        dueAt: "not-a-date",
      }),
    ).toMatchObject({ ok: false, error: "invalid_due_at" });
  });

  it("trims optional id fields and nulls the empty ones", () => {
    const result = parseCreateResponseTaskBody({
      title: "T",
      description: "",
      sourceClientCommentId: "  comment-7  ",
      findingId: "",
      actorId: "actor-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceClientCommentId).toBe("comment-7");
    expect(result.value.findingId).toBeNull();
    expect(result.value.actorId).toBe("actor-1");
  });

  it("rejects a non-string optional id field", () => {
    expect(
      parseCreateResponseTaskBody({
        title: "T",
        description: "",
        findingId: 123,
      }),
    ).toMatchObject({ ok: false, error: "invalid_finding_id" });
  });
});

describe("parseStateBody", () => {
  it("accepts a valid state", () => {
    expect(parseStateBody({ state: "in-progress" })).toEqual({
      ok: true,
      value: "in-progress",
    });
  });

  it("rejects an unknown or missing state", () => {
    expect(parseStateBody({ state: "archived" })).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
    expect(parseStateBody({})).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
    expect(parseStateBody(null)).toMatchObject({
      ok: false,
      error: "invalid_request_body",
    });
  });
});

describe("parseLinkFindingBody", () => {
  it("accepts and trims a non-empty findingId", () => {
    expect(parseLinkFindingBody({ findingId: "  f-1  " })).toEqual({
      ok: true,
      value: "f-1",
    });
  });

  it("rejects a missing, empty, or non-string findingId", () => {
    expect(parseLinkFindingBody({ findingId: "" })).toMatchObject({
      ok: false,
      error: "invalid_finding_id",
    });
    expect(parseLinkFindingBody({})).toMatchObject({
      ok: false,
      error: "invalid_finding_id",
    });
    expect(parseLinkFindingBody({ findingId: 5 })).toMatchObject({
      ok: false,
      error: "invalid_finding_id",
    });
  });
});

describe("parseStateFilter", () => {
  it("resolves an absent filter to null", () => {
    expect(parseStateFilter(undefined)).toEqual({ ok: true, value: null });
    expect(parseStateFilter("")).toEqual({ ok: true, value: null });
  });

  it("accepts a valid state filter", () => {
    expect(parseStateFilter("done")).toEqual({ ok: true, value: "done" });
  });

  it("rejects an unknown state filter", () => {
    expect(parseStateFilter("archived")).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });
});
