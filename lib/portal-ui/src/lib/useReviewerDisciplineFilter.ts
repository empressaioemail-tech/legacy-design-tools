/**
 * `useReviewerDisciplineFilter` — Track 1.
 *
 * One canonical hook that surfaces the signed-in reviewer's
 * `PlanReviewDiscipline[]` configuration plus a localStorage-persisted
 * "currently selected" subset for the chip-bar above the Inbox /
 * FindingsTab / CannedFindings / OutstandingRequests lists.
 *
 * Behavior:
 *  - Seeds `selected` from localStorage on first mount; falls back to
 *    the user's full configured set if nothing is stored.
 *  - Persists every toggle so the bar remembers the reviewer's
 *    narrowing across page navigations and reloads (per-browser).
 *  - `isShowingAll` is true when no narrowing is in effect: either
 *    the user is an admin (sees everything by default), or has no
 *    disciplines configured (the one-time banner case), or has
 *    explicitly clicked "Show all".
 *  - `userHasNoDisciplines` drives the one-time banner that invites
 *    the reviewer to set their certifications.
 *
 * Source-of-truth for the user's `disciplines` is BE-blocked at the
 * time of writing — until the regenerated session shape carries the
 * field, every reviewer renders as "no disciplines configured" and
 * the hook's `isShowingAll` defaults to true. The cast on
 * `(requestor as { disciplines?: ... })` is intentional: it lets the
 * FE compile against the current contract while BE / CT land Pass A.
 * Swap to a typed import from `@workspace/api-zod` in commit 6.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getGetSessionQueryKey,
  useGetSession,
} from "@workspace/api-client-react";
import {
  type PlanReviewDiscipline,
  PLAN_REVIEW_DISCIPLINES,
  isPlanReviewDiscipline,
} from "./planReviewDiscipline";

const SELECTED_STORAGE_KEY = "plr.reviewerDisciplineFilter.selected.v1";
const ADMIN_PERMISSION = "users:manage";

export interface UseReviewerDisciplineFilter {
  /** The disciplines currently scoping the reviewer's lists. */
  selected: ReadonlySet<PlanReviewDiscipline>;
  /** All seven ICC disciplines, in canonical order, for the chip-bar. */
  allDisciplines: ReadonlyArray<PlanReviewDiscipline>;
  /** True when no narrowing is in effect. */
  isShowingAll: boolean;
  /** Toggle one discipline in/out of the active filter. */
  toggle: (d: PlanReviewDiscipline) => void;
  /** Reset to the user's configured disciplines (or "show all" when none). */
  resetToMine: () => void;
  /** Force "show all" (admin override, explicit user click). */
  showAll: () => void;
  /**
   * True when the signed-in reviewer has no disciplines configured;
   * drives the one-time banner that invites them to set certifications.
   */
  userHasNoDisciplines: boolean;
  /**
   * True when the signed-in user is an admin (i.e. holds the
   * `users:manage` permission). Admins see everything by default and
   * are not prompted to configure disciplines.
   */
  isAdmin: boolean;
}

function readStoredSelection(): ReadonlyArray<PlanReviewDiscipline> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SELECTED_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isPlanReviewDiscipline);
  } catch {
    return null;
  }
}

function writeStoredSelection(values: ReadonlyArray<PlanReviewDiscipline>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SELECTED_STORAGE_KEY,
      JSON.stringify(Array.from(values)),
    );
  } catch {
    /* localStorage may be unavailable (SSR, private mode) — silently skip. */
  }
}

export function useReviewerDisciplineFilter(): UseReviewerDisciplineFilter {
  const { data: session } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });

  // BE BLOCKED — `disciplines` lands on the session response in
  // Track 1 Pass A. Cast through unknown so the FE compiles today.
  const userDisciplines = useMemo<ReadonlyArray<PlanReviewDiscipline>>(() => {
    const requestor = session?.requestor as
      | { disciplines?: ReadonlyArray<unknown> }
      | undefined;
    const raw = requestor?.disciplines;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isPlanReviewDiscipline);
  }, [session]);

  const isAdmin = useMemo<boolean>(
    () => (session?.permissions ?? []).includes(ADMIN_PERMISSION),
    [session],
  );

  const userHasNoDisciplines = userDisciplines.length === 0;

  // Initial selection: localStorage > user's configured disciplines.
  // For admins / no-disciplines reviewers, an empty selection set
  // means "show all" (we never coerce them into a narrowed view).
  const [selected, setSelected] = useState<ReadonlySet<PlanReviewDiscipline>>(
    () => {
      const stored = readStoredSelection();
      if (stored && stored.length > 0) return new Set(stored);
      return new Set();
    },
  );
  const [hasSeeded, setHasSeeded] = useState<boolean>(() => {
    const stored = readStoredSelection();
    return stored !== null && stored.length > 0;
  });

  // Once the session resolves and the user has disciplines configured,
  // seed the selection to their full set so the first paint already
  // narrows the lists. We only seed once per mount so a reviewer who
  // explicitly clears all chips doesn't get re-narrowed on the next
  // render.
  useEffect(() => {
    if (hasSeeded) return;
    if (userDisciplines.length === 0) return;
    setSelected(new Set(userDisciplines));
    setHasSeeded(true);
  }, [hasSeeded, userDisciplines]);

  const toggle = useCallback((d: PlanReviewDiscipline) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      writeStoredSelection(Array.from(next));
      return next;
    });
    setHasSeeded(true);
  }, []);

  const resetToMine = useCallback(() => {
    const next = new Set(userDisciplines);
    setSelected(next);
    writeStoredSelection(Array.from(next));
    setHasSeeded(true);
  }, [userDisciplines]);

  const showAll = useCallback(() => {
    const next = new Set<PlanReviewDiscipline>();
    setSelected(next);
    writeStoredSelection([]);
    setHasSeeded(true);
  }, []);

  // "Show all" is the effective state when the active selection is
  // empty (no narrowing) OR when the user has no disciplines /
  // is an admin and hasn't explicitly toggled anything.
  const isShowingAll =
    selected.size === 0 || (userHasNoDisciplines && selected.size === 0);

  return {
    selected,
    allDisciplines: PLAN_REVIEW_DISCIPLINES,
    isShowingAll,
    toggle,
    resetToMine,
    showAll,
    userHasNoDisciplines,
    isAdmin,
  };
}
