import { defineConfig, devices } from "@playwright/test";
import {
  existsSync,
  openSync,
  readdirSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import path from "node:path";

/**
 * Playwright e2e config for plan-review.
 *
 * Mirrors `artifacts/design-tools/playwright.config.ts`. The specs in
 * `./e2e` exercise the running plan-review UI through the shared
 * workspace proxy on `localhost:80` (which routes `/api/*` to the API
 * server and `/plan-review/*` to plan-review).
 *
 * `pnpm run test:e2e` is intentionally separate from `pnpm run test`
 * (vitest) so CI/local can opt into the heavier suite without paying
 * its cost on every component-test run.
 *
 * `E2E_BASE_URL` lets a dev override the proxy origin (e.g. to run
 * against a deployed environment). When set, `webServer` spawning is
 * suppressed — the assumption is that the remote target is already up.
 */

ensureChromiumLibrariesOnLoaderPath();

const proxyBaseUrl = process.env["E2E_BASE_URL"] ?? "http://localhost:80";

const webServer =
  process.env["E2E_BASE_URL"] === undefined
    ? [
        {
          command: "pnpm --filter @workspace/api-server run dev",
          url: `${proxyBaseUrl}/api/healthz`,
          reuseExistingServer: true,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          timeout: 180_000,
          env: { PORT: "8080" },
        },
        {
          command: "pnpm --filter @workspace/plan-review run dev",
          url: `${proxyBaseUrl}/plan-review/`,
          reuseExistingServer: true,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          timeout: 120_000,
          env: { PORT: "19591", BASE_PATH: "/plan-review/" },
        },
      ]
    : undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    // Trailing slash is load-bearing: plan-review serves under the
    // `/plan-review/` base path, and Playwright resolves relative
    // page.goto() targets via the URL constructor — so the baseURL
    // must end in `/` for `page.goto("engagements/x")` to land on
    // `…/plan-review/engagements/x` instead of `…/engagements/x`.
    baseURL: `${proxyBaseUrl}/plan-review/`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(webServer ? { webServer } : {}),
});

function ensureChromiumLibrariesOnLoaderPath(): void {
  if (!existsSync("/nix/store")) return;
  const dir = findMesaLibgbmDir();
  if (!dir) return;
  const existing = process.env["LD_LIBRARY_PATH"] ?? "";
  if (existing.split(":").includes(dir)) return;
  process.env["LD_LIBRARY_PATH"] = existing ? `${dir}:${existing}` : dir;
}

function findMesaLibgbmDir(): string | null {
  let entries: string[];
  try {
    entries = readdirSync("/nix/store");
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => /-mesa-libgbm-/.test(e))
    .sort()
    .reverse();
  for (const entry of candidates) {
    const candidate = path.join("/nix/store", entry, "lib", "libgbm.so.1");
    try {
      if (!statSync(candidate).isFile()) continue;
      if (!isElf64(candidate)) continue;
      return path.dirname(candidate);
    } catch {
      // not a match; keep scanning
    }
  }
  return null;
}

function isElf64(filePath: string): boolean {
  let fd = -1;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(5);
    const bytesRead = readSync(fd, buf, 0, 5, 0);
    if (bytesRead < 5) return false;
    return (
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46 &&
      buf[4] === 2
    );
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
