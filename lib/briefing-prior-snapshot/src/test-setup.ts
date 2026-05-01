/**
 * Vitest setup for `@workspace/briefing-prior-snapshot` (Task #361).
 *
 * Registers the `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 * `toHaveTextContent`, `toHaveAttribute`, …) so the lib's unit suite can
 * make the same assertions the two artifact-side integration tests do
 * without each test file importing the matchers itself, and runs
 * `cleanup()` between tests so a leaked DOM from one test can't poison
 * the next (the 2 s revert test in particular leaves a timer running
 * until the unmount cleanup fires).
 *
 * Mirrors `artifacts/plan-review/src/test-setup.ts` and
 * `artifacts/design-tools/src/test-setup.ts` so the lib's environment
 * stays consistent with both surfaces it backs.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
