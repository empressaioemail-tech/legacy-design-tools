/**
 * Vitest setup: register jest-dom matchers and clean the DOM between
 * tests. Imported via `setupFiles` in `vitest.config.ts`. Mirrors the
 * sibling artifacts' setup.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
