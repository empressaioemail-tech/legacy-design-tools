/**
 * Sidebar state width clamping — Task #420.
 *
 * The store powers both side panels in `DashboardLayout`, so a
 * regression that lets a setter persist an out-of-range width would
 * load the workspace into an unusable narrow strip on next reload.
 * These tests pin three behaviors:
 *
 *   1. setLeftWidth / setRightWidth clamp to the published min/max.
 *   2. resetLeftWidth / resetRightWidth restore the published default.
 *   3. The persisted width is independent of the collapsed boolean —
 *      collapsing and expanding the panel restores the user's last
 *      chosen width, not a hardcoded 256/420.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  useSidebarState,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  RIGHT_SIDEBAR_MAX_WIDTH,
} from "./sidebar-state";

describe("useSidebarState width clamping", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    useSidebarState.setState({
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
      rightWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH,
    });
  });

  it("seeds with the published default widths", () => {
    const s = useSidebarState.getState();
    expect(s.leftWidth).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    expect(s.rightWidth).toBe(RIGHT_SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps setLeftWidth below the min and above the max", () => {
    const { setLeftWidth } = useSidebarState.getState();

    setLeftWidth(0);
    expect(useSidebarState.getState().leftWidth).toBe(LEFT_SIDEBAR_MIN_WIDTH);

    setLeftWidth(99_999);
    expect(useSidebarState.getState().leftWidth).toBe(LEFT_SIDEBAR_MAX_WIDTH);
  });

  it("clamps setRightWidth below the min and above the max", () => {
    const { setRightWidth } = useSidebarState.getState();

    setRightWidth(10);
    expect(useSidebarState.getState().rightWidth).toBe(
      RIGHT_SIDEBAR_MIN_WIDTH,
    );

    setRightWidth(99_999);
    expect(useSidebarState.getState().rightWidth).toBe(
      RIGHT_SIDEBAR_MAX_WIDTH,
    );
  });

  it("accepts an in-range width verbatim (rounded to integer)", () => {
    const { setLeftWidth, setRightWidth } = useSidebarState.getState();
    setLeftWidth(312.7);
    setRightWidth(503.4);
    expect(useSidebarState.getState().leftWidth).toBe(313);
    expect(useSidebarState.getState().rightWidth).toBe(503);
  });

  it("resetLeftWidth / resetRightWidth restore the defaults", () => {
    const { setLeftWidth, setRightWidth, resetLeftWidth, resetRightWidth } =
      useSidebarState.getState();
    setLeftWidth(LEFT_SIDEBAR_MAX_WIDTH);
    setRightWidth(RIGHT_SIDEBAR_MIN_WIDTH);
    resetLeftWidth();
    resetRightWidth();
    const s = useSidebarState.getState();
    expect(s.leftWidth).toBe(LEFT_SIDEBAR_DEFAULT_WIDTH);
    expect(s.rightWidth).toBe(RIGHT_SIDEBAR_DEFAULT_WIDTH);
  });

  it("preserves the user's chosen width across collapse + expand", () => {
    const { setLeftWidth, setRightWidth, toggleLeft, toggleRight } =
      useSidebarState.getState();
    setLeftWidth(310);
    setRightWidth(540);

    toggleLeft();
    toggleRight();
    expect(useSidebarState.getState().leftCollapsed).toBe(true);
    expect(useSidebarState.getState().rightCollapsed).toBe(true);
    // Widths persist through a collapse — render path uses a separate
    // collapsed-stub width, but the chosen value must still be there
    // when the user expands again.
    expect(useSidebarState.getState().leftWidth).toBe(310);
    expect(useSidebarState.getState().rightWidth).toBe(540);

    toggleLeft();
    toggleRight();
    expect(useSidebarState.getState().leftWidth).toBe(310);
    expect(useSidebarState.getState().rightWidth).toBe(540);
  });
});
