import { defineConfig, devices } from "@playwright/test";
import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Playwright e2e config for design-tools.
 *
 * The specs in `./e2e` exercise the running design-tools UI against the
 * shared workspace proxy at `localhost:80` (which already routes `/api/*`
 * to the API server and `/*` to design-tools). The proxy itself is
 * provided by the surrounding Replit environment and is up regardless of
 * which workflows are running.
 *
 * The `webServer` block below makes the suite self-orchestrating for CI
 * (Task #134): if either upstream is not already responding via the
 * proxy, Playwright spawns the dev command for it and waits for the
 * health-check URL to come up before running any test. When the
 * Replit-managed workflows for `api-server` / `design-tools` are
 * already running (the normal local-dev case), `reuseExistingServer`
 * makes Playwright skip the spawn and reuse them — so this block costs
 * nothing in day-to-day work but unblocks an unattended CI invocation.
 *
 * `pnpm run test:e2e` is intentionally separate from `pnpm run test`
 * (vitest) so CI/local can opt into the heavier suite without paying
 * its cost on every component-test run.
 *
 * `E2E_BASE_URL` lets a dev override the proxy origin (for example, to
 * run against a deployed environment); the default matches the in-repo
 * convention documented in the pnpm-workspace skill. When it is set,
 * the `webServer` spawning is suppressed — the assumption is that the
 * remote target is already up.
 */

/**
 * Replit's NixOS sandbox does not put `libgbm.so.1` (mesa-libgbm) on
 * the default loader path the way standard Linux distros do. The
 * Playwright-bundled `chrome-headless-shell` binary therefore fails at
 * launch with `error while loading shared libraries: libgbm.so.1`
 * unless we tell the dynamic loader where to find it. We discover the
 * canonical `mesa-libgbm-*` store path from `/nix/store` once at
 * config load and prepend it to `LD_LIBRARY_PATH` for the test process
 * (and, transitively, the browser child it spawns). Doing this here —
 * rather than asking every developer to remember to `LD_LIBRARY_PATH=…
 * pnpm test:e2e` — is what keeps `pnpm run test:e2e` a one-command
 * invocation.
 */
ensureChromiumLibrariesOnLoaderPath();

const proxyBaseUrl = process.env["E2E_BASE_URL"] ?? "http://localhost:80";

/**
 * Spawn the workspace dev servers when the suite is invoked outside of
 * a Replit-managed workflow context (i.e. in CI). When `E2E_BASE_URL`
 * points at an external target, or when the developer is already
 * running the workflows locally, `reuseExistingServer: true` makes
 * Playwright skip spawning entirely and just verify the URL responds.
 *
 * Both processes inherit the parent env (so `DATABASE_URL` and the
 * Replit secrets reach the API server / Vite). We pin the ports here
 * because the proxy on `localhost:80` routes by the well-known port
 * mapping declared in each artifact's `artifact.toml` — drift between
 * the two would route the test browser at the wrong upstream.
 */
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
          command: "pnpm --filter @workspace/design-tools run dev",
          url: `${proxyBaseUrl}/`,
          reuseExistingServer: true,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          timeout: 120_000,
          env: { PORT: "20295", BASE_PATH: "/" },
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
    baseURL: proxyBaseUrl,
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

/**
 * Best-effort augmentation of `LD_LIBRARY_PATH` for the Replit Nix
 * environment. No-op on platforms that don't have `/nix/store` and a
 * no-op on environments where the loader can already find every
 * library Chromium needs (we only prepend a directory if it actually
 * contains the `libgbm.so.1` we are looking for).
 */
function ensureChromiumLibrariesOnLoaderPath(): void {
  if (!existsSync("/nix/store")) return;

  // We restrict the search to nixpkgs' `mesa-libgbm-*` package
  // because that is where the canonical 64-bit `libgbm.so.1` lives in
  // the Replit image. Other store paths (e.g. `altair-*-fhs`) ship a
  // copy of the same soname alongside an *older* `libstdc++.so.6` —
  // prepending those dirs would shadow the system libstdc++ and break
  // node itself before the test ever runs.
  const dir = findMesaLibgbmDir();
  if (!dir) return;

  const existing = process.env["LD_LIBRARY_PATH"] ?? "";
  if (existing.split(":").includes(dir)) return;
  process.env["LD_LIBRARY_PATH"] = existing
    ? `${dir}:${existing}`
    : dir;
}

/**
 * Locate the most recent `mesa-libgbm-*` store path that contains a
 * 64-bit `libgbm.so.1`. Returns the `lib/` directory (suitable for
 * `LD_LIBRARY_PATH`) or `null` if no compatible package is present.
 */
function findMesaLibgbmDir(): string | null {
  let entries: string[];
  try {
    entries = readdirSync("/nix/store");
  } catch {
    return null;
  }
  // Restrict to `<hash>-mesa-libgbm-<version>` directories — the only
  // ones we expect to ship the libgbm we want — and prefer newer
  // versions (lexical sort is good enough for nixpkgs' x.y.z naming).
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

/**
 * Read the first 5 bytes of an ELF file and return true iff it is a
 * 64-bit ELF binary. ELF header layout: bytes 0-3 are the magic
 * (`\x7fELF`) and byte 4 is `EI_CLASS` (`1` = 32-bit, `2` = 64-bit).
 */
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
