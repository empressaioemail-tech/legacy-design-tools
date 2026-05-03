/**
 * `useReviewerDisciplineFilter` — Track 1.
 *
 * The hook reads the signed-in user's disciplines off the session
 * response, persists chip-bar narrowing per-browser, and exposes the
 * three branches the chip-bar / banner consumers care about
 * (configured reviewer / no-disciplines reviewer / admin). These
 * tests pin all three plus the localStorage round-trip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// `useGetSession` is the only api-client-react hook the discipline
// filter touches. We mock it with a hoisted accessor so each test can
// reassign the session payload before mounting.
const sessionState = vi.hoisted(() => ({
  data: null as unknown,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => ({ data: sessionState.data }),
  getGetSessionQueryKey: () => ["getSession"] as const,
}));

import { useReviewerDisciplineFilter } from "./useReviewerDisciplineFilter";

const STORAGE_KEY = "plr.reviewerDisciplineFilter.selected.v1";

beforeEach(() => {
  sessionState.data = null;
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useReviewerDisciplineFilter", () => {
  it("seeds the selection from the user's configured disciplines on first mount", () => {
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u-electrical",
        disciplines: ["electrical", "fire-life-safety"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    // Both configured disciplines should be active right away — the
    // reviewer's first paint already shows the narrowed view.
    expect(Array.from(result.current.selected).sort()).toEqual([
      "electrical",
      "fire-life-safety",
    ]);
    expect(result.current.isShowingAll).toBe(false);
    expect(result.current.userHasNoDisciplines).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });

  it("reports userHasNoDisciplines and isShowingAll for a reviewer with no configuration", () => {
    sessionState.data = {
      audience: "internal",
      requestor: { kind: "user", id: "u-new" },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    expect(result.current.userHasNoDisciplines).toBe(true);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.isShowingAll).toBe(true);
  });

  it("reports isAdmin true when the session carries the users:manage permission", () => {
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u-admin",
        disciplines: ["building"],
      },
      permissions: ["users:manage"],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    expect(result.current.isAdmin).toBe(true);
  });

  it("toggle adds and removes a discipline and persists to localStorage", () => {
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u-electrical",
        disciplines: ["electrical"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    expect(Array.from(result.current.selected)).toEqual(["electrical"]);
    act(() => result.current.toggle("fire-life-safety"));
    expect(Array.from(result.current.selected).sort()).toEqual([
      "electrical",
      "fire-life-safety",
    ]);
    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    expect(persisted.sort()).toEqual(["electrical", "fire-life-safety"]);
    act(() => result.current.toggle("electrical"));
    expect(Array.from(result.current.selected)).toEqual(["fire-life-safety"]);
  });

  it("restores the persisted selection on remount even if user disciplines look different", () => {
    // Reviewer narrowed to just fire-life-safety on a previous visit.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["fire-life-safety"]),
    );
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u-electrical",
        disciplines: ["electrical", "fire-life-safety"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    // The persisted value wins over the user's configured set so the
    // reviewer's last narrowing carries across sessions.
    expect(Array.from(result.current.selected)).toEqual(["fire-life-safety"]);
  });

  it("filters out unknown discipline strings from a stale localStorage payload", () => {
    // A previous build wrote a value the new enum doesn't recognise.
    // The hook must drop it silently rather than crash on parse.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["electrical", "telecom"]),
    );
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u",
        disciplines: ["electrical"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    expect(Array.from(result.current.selected)).toEqual(["electrical"]);
  });

  it("showAll empties the selection and persists the empty list", () => {
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u",
        disciplines: ["electrical", "fire-life-safety"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    act(() => result.current.showAll());
    expect(result.current.selected.size).toBe(0);
    expect(result.current.isShowingAll).toBe(true);
    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    expect(persisted).toEqual([]);
  });

  it("resetToMine returns to the user's configured disciplines after toggling away", () => {
    sessionState.data = {
      audience: "internal",
      requestor: {
        kind: "user",
        id: "u",
        disciplines: ["electrical", "fire-life-safety"],
      },
      permissions: [],
      tenantId: "default",
    };
    const { result } = renderHook(() => useReviewerDisciplineFilter());
    act(() => result.current.showAll());
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.resetToMine());
    expect(Array.from(result.current.selected).sort()).toEqual([
      "electrical",
      "fire-life-safety",
    ]);
  });
});
