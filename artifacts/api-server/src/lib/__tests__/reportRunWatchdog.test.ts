/**
 * Report-run watchdog — `running` can never be a forever state.
 * (2026-07-14 live incident: client disconnect mid-synchronous drainage
 * run left the in-flight entry behind; status GET said "running" 8+ min.)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WATCHDOG_STALE_GRACE_MS,
  isInFlightRunStale,
  reportRunWatchdogBudgetMs,
  runWithWatchdog,
} from "../reportRunWatchdog";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("reportRunWatchdogBudgetMs", () => {
  it("defaults to 6 minutes", () => {
    expect(reportRunWatchdogBudgetMs()).toBe(360_000);
  });

  it("honors REPORT_RUN_WATCHDOG_MS", () => {
    vi.stubEnv("REPORT_RUN_WATCHDOG_MS", "1000");
    expect(reportRunWatchdogBudgetMs()).toBe(1000);
  });

  it("ignores garbage env values", () => {
    vi.stubEnv("REPORT_RUN_WATCHDOG_MS", "not-a-number");
    expect(reportRunWatchdogBudgetMs()).toBe(360_000);
  });
});

describe("isInFlightRunStale", () => {
  const entry = { generationId: "gen-1", startedAt: 1_000_000 };

  it("is fresh within budget + grace", () => {
    expect(
      isInFlightRunStale(entry, entry.startedAt + 5_000, 10_000),
    ).toBe(false);
    expect(
      isInFlightRunStale(
        entry,
        entry.startedAt + 10_000 + WATCHDOG_STALE_GRACE_MS,
        10_000,
      ),
    ).toBe(false);
  });

  it("is stale past budget + grace", () => {
    expect(
      isInFlightRunStale(
        entry,
        entry.startedAt + 10_001 + WATCHDOG_STALE_GRACE_MS,
        10_000,
      ),
    ).toBe(true);
  });
});

describe("runWithWatchdog", () => {
  it("returns the result when work settles within budget", async () => {
    const outcome = await runWithWatchdog(Promise.resolve(42), 5_000);
    expect(outcome).toEqual({ timedOut: false, result: 42 });
  });

  it("propagates work rejection (caller's catch owns it)", async () => {
    await expect(
      runWithWatchdog(Promise.reject(new Error("boom")), 5_000),
    ).rejects.toThrow("boom");
  });

  it("times out when work outlives the budget and reports the late settle", async () => {
    let releaseWork!: (v: string) => void;
    const work = new Promise<string>((resolve) => {
      releaseWork = resolve;
    });
    const late: Array<{ ok: boolean; detail: string }> = [];
    const outcome = await runWithWatchdog(work, 20, (o) => late.push(o));
    expect(outcome).toEqual({ timedOut: true });

    releaseWork("too late");
    await new Promise((r) => setTimeout(r, 10));
    expect(late).toHaveLength(1);
    expect(late[0].ok).toBe(true);
    expect(late[0].detail).toContain("late completion");
  });

  it("swallows a late rejection (no unhandledRejection) and reports it", async () => {
    let failWork!: (e: Error) => void;
    const work = new Promise<string>((_, reject) => {
      failWork = reject;
    });
    const late: Array<{ ok: boolean; detail: string }> = [];
    const outcome = await runWithWatchdog(work, 20, (o) => late.push(o));
    expect(outcome).toEqual({ timedOut: true });

    failWork(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 10));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ ok: false, detail: "late failure" });
  });
});
