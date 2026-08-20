#!/usr/bin/env node
/**
 * BOOT SMOKE TEST — start the built server, wait for the port, kill it.
 *
 * WHY THIS EXISTS. On 2026-08-19 a canary deploy of `5688aa31` failed with
 * "The user-provided container failed to start and listen on the port defined
 * provided by the PORT=8080 environment variable within the allocated
 * timeout." Every merge to this repo since 2026-08-16 had shipped unbootable
 * and nobody knew, because CI ran typecheck and vitest and never started the
 * process. Four green CI runs, correct verdicts, consuming nothing that could
 * catch it.
 *
 * The cause was `routes/index.ts` pulling `countyCoverageScoreCli.ts` into the
 * boot graph through the `lib/railScoring` barrel. The CLI has an
 * `isDirectRun()` entrypoint guard, and the guard does not survive bundling:
 * esbuild folds every module into `dist/index.mjs`, so inside the bundle
 * `import.meta.url` IS the bundle's own URL and `argv[1]` is that same path.
 * The guard read TRUE at server boot, `main()` ran with no `--county`, and
 * `process.exit(1)` fired before Express listened. The same misfire is already
 * recorded in the header of `src/lib/nodeFacetTier2Constants.ts`.
 *
 * A typecheck cannot see this. A unit test cannot see this. Only starting the
 * process can, so this starts the process.
 *
 * THIS IS TOOLING, SO IT FAILS LOUD, NOT CLOSED (61_enforcement_doctrine).
 * Three outcomes, never two:
 *
 *   exit 0   RESULT=pass            the server reached a listening socket
 *   exit 1   RESULT=violation       the server exited, or never listened
 *   exit 2   RESULT=did-not-run     the INSTRUMENT could not answer
 *
 * A check that cannot run and silently passes is the defect this whole
 * programme is about, so "did not run" is its own greppable outcome
 * (marker GATE-DID-NOT-RUN) and never collapses into pass.
 *
 * SELF-TEST FIRST, IN BOTH DIRECTIONS. Before any verdict on the real bundle
 * is trusted, the same probe runs against a fixture that exits without
 * listening (must be flagged) and a fixture that listens (must pass). A probe
 * that flags nothing is a starved gate; a probe that flags everything is a
 * dead gate. Either failure reports DID-NOT-RUN rather than a verdict. This
 * wires in "a check observed only passing has not been observed working".
 *
 * PORT PREFLIGHT IS NOT COSMETIC. If something else is already listening on
 * the probe port, a "listening" observation cannot be attributed to the child
 * and the pass would be the cheapest wrong value. An occupied port is
 * DID-NOT-RUN.
 *
 * EXIT-BOUNDED BY CONSTRUCTION. Every wait has a deadline and the child is
 * killed in a `finally`. A boot test that leaves a server running is itself a
 * defect.
 *
 * WHAT THIS DOES NOT PROVE. It boots with a well-formed but SYNTHETIC env
 * (dummy secrets, deliberately unreachable DATABASE_URL). It proves the
 * process reaches `app.listen`. It does not prove the production secret set is
 * correct, and it does not exercise any route.
 *
 * Usage:
 *   node artifacts/api-server/scripts/bootSmokeTest.mjs
 *   node artifacts/api-server/scripts/bootSmokeTest.mjs --entry dist/index.mjs --port 8123
 */

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE_ID = "ci-api-server-boot-smoke";

const EXIT_PASS = 0;
const EXIT_VIOLATION = 1;
const EXIT_DID_NOT_RUN = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(API_SERVER_DIR, "..", "..");

function didNotRun(message) {
  console.error(`GATE-DID-NOT-RUN ${GATE_ID}: ${message}`);
  console.error("RESULT=did-not-run");
  process.exit(EXIT_DID_NOT_RUN);
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i += 1;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

/**
 * The synthetic boot env.
 *
 * These are DUMMIES, and that is stated rather than hidden. DATABASE_URL points
 * at a port nothing listens on, on purpose: boot must not require a live
 * database to reach `listen`, and if it does that is a finding this harness
 * should surface rather than mask by provisioning a database.
 *
 * NODE_ENV=production because that is the path a deploy takes, and several
 * boot validators only refuse in production.
 */
function smokeEnv(port) {
  return {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    PORT: String(port),
    DATABASE_URL: "postgres://bootsmoke:bootsmoke@127.0.0.1:5599/bootsmoke",
    AIR_FINDING_LLM_MODE: "mock",
    BRIEFING_LLM_MODE: "mock",
    CLASSIFICATION_LLM_MODE: "mock",
    SHEET_CONTENT_LLM_MODE: "mock",
    MNML_RENDER_MODE: "mock",
    DXF_CONVERTER_MODE: "mock",
    RENDERS_PROD_ENABLED: "false",
    PUBLIC_OBJECT_SEARCH_PATHS: "/boot-smoke-bucket/public",
    PRIVATE_OBJECT_DIR: "/boot-smoke-bucket/private",
    SESSION_SECRET: "boot-smoke-dummy",
    SNAPSHOT_SECRET: "boot-smoke-dummy",
    BIM_MODEL_SHARED_SECRET: "boot-smoke-dummy",
    PE_SESSION_EXCHANGE_SECRET: "boot-smoke-dummy",
    SERVICE_API_KEY: "boot-smoke-dummy",
    AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "https://api.anthropic.invalid",
    AI_INTEGRATIONS_ANTHROPIC_API_KEY: "boot-smoke-dummy",
    // Presence-checked at boot by validateEngineSpineEnvAtBoot. Never dialled
    // during boot, so an unroutable host is the honest value here: it must not
    // be able to pass by reaching something real.
    ENGINE_API_URL: "https://engine-api.boot-smoke.invalid",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One bounded TCP connect attempt. Resolves true only on an actual connect. */
function tcpConnects(port, connectTimeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(connectTimeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/** Kill the child and everything it spawned. Bounded; never returns early. */
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* the child may already be gone; the bounded wait below is the check */
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  console.error(
    `${GATE_ID}: WARNING — child pid ${child.pid} did not exit within 10s of SIGKILL`,
  );
}

/**
 * Spawn `entry` and watch for a listening socket.
 *
 * Returns one of:
 *   { outcome: "listening" }
 *   { outcome: "exited", code, signal }
 *   { outcome: "timeout" }
 * plus the captured output in every case.
 */
async function probeBoot({ entry, port, timeoutMs, cwd }) {
  const chunks = [];
  const child = spawn(process.execPath, ["--enable-source-maps", entry], {
    cwd,
    env: smokeEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));

  const output = () => Buffer.concat(chunks).toString("utf8");

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        return { outcome: "spawn-error", error: spawnError, output: output() };
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        // One last probe: a process that listened and then exited is still a
        // boot failure for Cloud Run's purposes, but the exit is the finding.
        return {
          outcome: "exited",
          code: child.exitCode,
          signal: child.signalCode,
          output: output(),
        };
      }
      if (await tcpConnects(port, 500)) {
        return { outcome: "listening", output: output() };
      }
      await sleep(250);
    }
    return { outcome: "timeout", output: output() };
  } finally {
    await killTree(child);
  }
}

function writeFixture(dir, name, source) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, source, "utf8");
  return p;
}

function currentCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return "unknown (git rev-parse failed)";
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  const entryArg = args.entry ?? path.join("dist", "index.mjs");
  const entry = path.isAbsolute(entryArg)
    ? entryArg
    : path.resolve(API_SERVER_DIR, entryArg);
  const basePort = Number(args.port ?? process.env.BOOT_SMOKE_PORT ?? 8123);
  const timeoutMs = Number(args["timeout-ms"] ?? 90_000);

  if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65_530) {
    didNotRun(`--port must be a usable TCP port; got ${args.port}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    didNotRun(`--timeout-ms must be a positive number; got ${args["timeout-ms"]}`);
  }

  console.log(`${GATE_ID}: commit ${currentCommit()}`);
  console.log(`${GATE_ID}: entry  ${entry}`);
  console.log(`${GATE_ID}: ports  self-test ${basePort + 1}/${basePort + 2}, verdict ${basePort}`);

  // ---- SELF-TEST, BOTH DIRECTIONS -----------------------------------------
  // The probe is run against a known violation and a known compliant entry
  // before its verdict on the real bundle means anything.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-smoke-"));
  try {
    const exiter = writeFixture(
      fixtureDir,
      "exiter.mjs",
      [
        "// Fixture: the shape of the defect. Exits before listening.",
        'process.stderr.write("boot-smoke fixture: exiting without listening\\n");',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const listener = writeFixture(
      fixtureDir,
      "listener.mjs",
      [
        "// Fixture: the shape of a healthy boot. Listens and stays up.",
        'import net from "node:net";',
        "const port = Number(process.env.PORT);",
        'net.createServer().listen(port, "127.0.0.1", () => {',
        '  process.stdout.write("boot-smoke fixture: listening\\n");',
        "});",
        "",
      ].join("\n"),
    );

    const selfTestPortA = basePort + 1;
    const selfTestPortB = basePort + 2;

    if (await tcpConnects(selfTestPortA, 500)) {
      didNotRun(
        `self-test port ${selfTestPortA} is already in use; the self-test could not be attributed to its fixture`,
      );
    }
    const a = await probeBoot({
      entry: exiter,
      port: selfTestPortA,
      timeoutMs: 20_000,
      cwd: fixtureDir,
    });
    if (a.outcome === "listening") {
      didNotRun(
        "self-test A failed: the probe reported a listening socket for an entry that exits immediately, so a pass verdict would be meaningless",
      );
    }
    if (a.outcome !== "exited") {
      didNotRun(
        `self-test A failed: expected outcome 'exited' for the exiting fixture, got '${a.outcome}'`,
      );
    }

    if (await tcpConnects(selfTestPortB, 500)) {
      didNotRun(
        `self-test port ${selfTestPortB} is already in use; the self-test could not be attributed to its fixture`,
      );
    }
    const b = await probeBoot({
      entry: listener,
      port: selfTestPortB,
      timeoutMs: 20_000,
      cwd: fixtureDir,
    });
    if (b.outcome !== "listening") {
      didNotRun(
        `self-test B failed: the probe did not see a listening socket for a fixture that listens (outcome '${b.outcome}'), so this gate is permanently red and enforces nothing`,
      );
    }
    console.log(`${GATE_ID}: self-test passed in both directions`);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  // ---- VERDICT ON THE REAL BUNDLE -----------------------------------------
  if (!fs.existsSync(entry)) {
    didNotRun(
      `${entry} does not exist; build the server first (pnpm --filter @workspace/api-server run build)`,
    );
  }
  if (await tcpConnects(basePort, 500)) {
    didNotRun(
      `port ${basePort} is already in use; a listening observation could not be attributed to the server under test`,
    );
  }

  const result = await probeBoot({
    entry,
    port: basePort,
    timeoutMs,
    cwd: API_SERVER_DIR,
  });

  if (result.outcome === "spawn-error") {
    didNotRun(`could not spawn the server: ${result.error?.message}`);
  }

  if (result.outcome === "listening") {
    console.log(`${GATE_ID}: server listened on ${basePort} and was killed`);
    console.log("RESULT=pass");
    process.exit(EXIT_PASS);
  }

  console.error("---- captured server output ----");
  console.error(result.output.trimEnd() || "(no output)");
  console.error("--------------------------------");
  if (result.outcome === "exited") {
    console.error(
      `FAIL ${GATE_ID}: the server process exited (code ${result.code}, signal ${result.signal}) before listening on ${basePort}. This is the Cloud Run "container failed to start and listen on PORT" failure, reproduced locally.`,
    );
  } else {
    console.error(
      `FAIL ${GATE_ID}: the server did not listen on ${basePort} within ${timeoutMs}ms and was killed.`,
    );
  }
  console.error("RESULT=violation");
  process.exit(EXIT_VIOLATION);
}

main().catch((err) => {
  didNotRun(`the harness itself threw: ${err?.stack ?? err}`);
});
