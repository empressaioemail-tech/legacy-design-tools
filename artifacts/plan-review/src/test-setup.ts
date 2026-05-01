/**
 * Vitest setup: register jest-dom matchers and ensure each test starts with
 * a clean DOM. Imported via `setupFiles` in `vitest.config.ts`.
 *
 * Mirrors `artifacts/design-tools/src/test-setup.ts` to keep plan-review's
 * test environment consistent with its sibling artifact.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
