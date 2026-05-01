/**
 * Vitest setup for the portal-ui lib: register jest-dom matchers and
 * ensure each test starts with a clean DOM. Imported via `setupFiles`
 * in `vitest.config.ts`.
 *
 * Mirrors `artifacts/plan-review/src/test-setup.ts` and
 * `artifacts/design-tools/src/test-setup.ts` so a portal-ui component
 * test behaves identically to the surface-level integration tests on
 * the two consuming artifacts.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
