#!/usr/bin/env node
/**
 * p279-tagged-revision-check.mjs — the ONE wrapper the deploy workflows call after a canary
 * deploy and after a traffic shift. P-362.
 *
 * WHY THIS FILE EXISTS. On 2026-09-18 15:49Z (run 35364723464) the `shift-traffic` job of
 * `.github/workflows/cloud-run-deploy.yml` ran `node scripts/check-tagged-revision-env.mjs`
 * from a job that never checked the repo out. Node died with
 * `Cannot find module scripts/check-tagged-revision-env.mjs` and exited 1. The job's shell
 * wrapper mapped exit 1 to `RESULT=violation - a tag points at a revision missing a
 * credential...` — the most alarming thing in its vocabulary — against a service whose tags
 * were clean, checked by hand, field by field. A check that could not run was reported as a
 * violation. That is worse than silence: it teaches the operator to ignore the step, which is
 * how the next real violation gets through.
 *
 * WHAT THIS WRAPPER DOES. It stops trusting the check's PROCESS EXIT CODE and starts reading
 * the check's OWN REPORTED VERDICT. The check prints a result object carrying the service name
 * and its verdict — on the live path as `--json`, on the `--from-fixture` path always — and
 * nothing else it does produces that shape. This wrapper requires it, in either of the two
 * report shapes the check has. Anything that leaves stdout without one — a missing module, a
 * syntax error, an uncaught exception, a usage error, an unreadable service — reads
 * `RESULT=did-not-run` and fails the step with that text. A violation is a violation only when
 * the predicate itself said FAIL.
 *
 * ONE TABLE. Both live call sites (cloud-run-deploy.yml and cloud-run-deploy-smartsite-mcp.yml,
 * each twice: after the canary deploy and after the shift) run THIS script. There is no second
 * copy of the exit-code case statement to drift (DEV_PROCESS 2.4).
 *
 * WINDOWS. `check-tagged-revision-env.mjs` reads `P279_GCLOUD || "gcloud"` and builds a shell
 * command string, refusing any argument that is not shell-safe. On Windows the standard gcloud
 * install path contains a space (`...\Google\Cloud SDK\...`), so pointing P279_GCLOUD at the
 * real binary is REFUSED and the read returns SERVICE_DESCRIBE_FAILED. This wrapper resolves
 * the binary itself and pins a name the check's guard accepts: `gcloud.cmd` on win32 (the
 * shim cmd.exe, which `shell: true` uses, can execute), `gcloud` elsewhere. It also discards a
 * P279_GCLOUD that the check would refuse, rather than letting it turn a readable service into
 * a refusal.
 *
 * USAGE (the same flags the check takes; they are passed through unchanged)
 *   node scripts/p279-tagged-revision-check.mjs \
 *     --project legacy-design-tools-prod --region us-central1 --service cortex-api
 *   node scripts/p279-tagged-revision-check.mjs --covered
 *   node scripts/p279-tagged-revision-check.mjs --from-fixture scripts/fixtures/tagged-revision-env/fail
 *
 * NOT ROUTED HERE: `--selftest` and `--check-divergence`. They are not service verdicts, they
 * print a different JSON shape, and this wrapper would read them as did-not-run. pr-checks.yml
 * runs them directly (see P-362's close for their exit-code mapping).
 *
 * EXIT CODES — 0 clean · 1 violation · 2 did-not-run. 1 and 2 both fail the calling step; they
 * are distinct because "the class is live" and "the check did not run" are different problems
 * and must not read alike.
 *
 * WHAT BYPASSES IT — named because the answer is never "nothing":
 *   1. A workflow that calls `check-tagged-revision-env.mjs` directly instead of this wrapper.
 *      pr-checks.yml does exactly that for the two OFFLINE jobs (fixtures and the canonical
 *      divergence compare), and their case statements still map by number; see P-362's close.
 *   2. A job that runs this wrapper without checking the repo out. The wrapper is a repo file;
 *      the checkout is the other half of the fix.
 *   3. A hand `gcloud run deploy --tag` / `update-traffic` that runs no check at all.
 *   4. Discarding the exit code, or a `run:` step that swallows it.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "check-tagged-revision-env.mjs");

export const WRAPPER_EXIT = { CLEAN: 0, VIOLATION: 1, DID_NOT_RUN: 2 };

const PREFIX = "p279-tagged-revision-env:";

/**
 * The gcloud name handed to the check through P279_GCLOUD. Windows needs the .cmd shim because
 * the check runs its command through `shell: true`, which on win32 is cmd.exe, and cmd.exe
 * cannot execute the extensionless Git Bash `gcloud` script. A configured P279_GCLOUD that
 * contains a space or a quote is discarded rather than passed on: the check's own guard refuses
 * such an argument and the whole read becomes an unreadable refusal (reproduced 2026-09-18).
 */
export function resolveCheckGcloud(env = process.env, platform = process.platform) {
  const configured = (env.P279_GCLOUD || "").trim();
  const shellSafe = /^[A-Za-z0-9_.:@/=+-]+$/.test(configured);
  if (configured && shellSafe) return configured;
  if (configured) {
    // Not silent: a deliberate configuration is being overridden, and the operator needs to know
    // which name was used instead. On Windows this is the common case (the standard install path
    // has a space); see the Windows note in the header.
    console.error(
      `${PREFIX} P279_GCLOUD=${JSON.stringify(configured)} contains a space or a quote and the check refuses such an argument; using ${platform === "win32" ? "gcloud.cmd" : "gcloud"} from PATH instead`,
    );
  }
  return platform === "win32" ? "gcloud.cmd" : "gcloud";
}

function printResult(result, lines) {
  console.log(`${PREFIX} RESULT=${result}`);
  for (const line of lines) console.log(`  ${line}`);
}

function reportHuman(results) {
  for (const r of results) {
    const head = `${r.service}  serving=${r.servingRevision ?? "?"}  tags=${r.tagsChecked ?? 0}  required=${r.requiredCount ?? 0}  failing=${r.failingTagCount ?? 0}${r.reason ? `  [${r.reason}]` : ""}`;
    console.log(`  ${head}`);
    if (r.detail) console.log(`    detail: ${r.detail}`);
    for (const t of r.tags || []) {
      if (t.absentFromRevisionList) {
        console.log(`    FAIL  ${t.tag} -> ${t.revisionName}  ABSENT FROM REVISION LIST (cannot prove its env; refusing to call it covered)`);
      } else if (t.missingRequired?.length) {
        console.log(`    FAIL  ${t.tag} -> ${t.revisionName}  missing: ${t.missingRequired.join(", ")}`);
      } else if (t.missingNonRequired?.length) {
        console.log(`    note  ${t.tag} -> ${t.revisionName}  missing non-credential vars (not a failure): ${t.missingNonRequired.join(", ")}`);
      }
    }
  }
}

function main() {
  const passthrough = process.argv.slice(2);
  if (passthrough.length === 0) {
    console.error(`${PREFIX} usage: p279-tagged-revision-check.mjs [--covered | --service <name> --project <id> --region <id>]`);
    printResult("did-not-run", ["no target given; the predicate was never asked"]);
    process.exit(WRAPPER_EXIT.DID_NOT_RUN);
  }

  const env = { ...process.env, P279_GCLOUD: resolveCheckGcloud() };
  const child = spawnSync(process.execPath, [CHECK, "--json", ...passthrough], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
    env,
  });

  const stdout = child.stdout ?? "";
  const stderr = (child.stderr ?? "").trim();
  const status = child.status;

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }

  // POSITIVE MARKER: a result object the predicate produces only after it evaluated a service.
  // Requiring `service` as well as `verdict` is what keeps `--check-divergence` (which also
  // reports a PASS/REFUSE verdict, over a byte compare, with no service) from being read here
  // as a service verdict. The check has TWO report shapes and both are the predicate's own
  // report: the live path prints { predicateVersion, results: [ ... ] }, and the offline
  // --from-fixture path prints ONE result object. An earlier version of this wrapper required
  // the live shape only and read every fixture verdict as did-not-run; that is the same defect
  // class in the other direction, and it is why both shapes are named here.
  const asResult = (o) =>
    o && typeof o === "object" && typeof o.service === "string" && typeof o.verdict === "string" ? o : null;

  let results = null;
  if (parsed && Array.isArray(parsed.results)) {
    const mapped = parsed.results.map(asResult);
    if (mapped.length > 0 && mapped.every(Boolean)) results = mapped;
  } else {
    const single = asResult(parsed);
    if (single) results = [single];
  }

  // No parseable report, an empty result set, or a shape that is not a service verdict means
  // the check did NOT run — whatever the exit code says. This is the case P-362 exists for.
  if (!results) {
    const lines = [`the predicate produced no verdict JSON (child exit ${status ?? "null"}); the check did NOT run`];
    if (stderr) lines.push(`stderr: ${stderr.split("\n").slice(-5).join(" | ")}`);
    if (stdout.trim()) lines.push(`stdout did not parse as a service verdict: ${stdout.trim().slice(0, 300)}`);
    printResult("did-not-run", lines);
    process.exit(WRAPPER_EXIT.DID_NOT_RUN);
  }

  const verdicts = new Set(results.map((r) => r.verdict));

  if (verdicts.has("FAIL")) {
    console.log(`${PREFIX} RESULT=violation - a tag points at a revision missing a credential the serving revision carries`);
    reportHuman(results);
    console.log(`  ${PREFIX} removing or repointing a tag is an operator decision; this check mutates nothing`);
    process.exit(WRAPPER_EXIT.VIOLATION);
  }

  if (verdicts.has("REFUSE") || verdicts.size !== 1 || !verdicts.has("PASS")) {
    // Any verdict this wrapper does not understand is a did-not-run, never a clean.
    console.log(`${PREFIX} RESULT=did-not-run (REFUSE - the service or its revisions could not be read; this is NOT a pass)`);
    reportHuman(results);
    process.exit(WRAPPER_EXIT.DID_NOT_RUN);
  }

  printResult("clean", [`${results.length} service(s) checked, every tag carries the serving revision's required variables`]);
  reportHuman(results);
  process.exit(WRAPPER_EXIT.CLEAN);
}

// The same guard the check uses. This file exports so its resolver can be tested; without the
// guard, importing it would run the whole wrapper as a side effect.
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("p279-tagged-revision-check.mjs");
if (isMain) {
  try {
    main();
  } catch (e) {
    // The wrapper itself must never exit 1 by accident: that is the code that reads as "violation".
    printResult("did-not-run", [`the wrapper threw before a verdict: ${String(e && e.stack ? e.stack.split("\n")[0] : e)}`]);
    process.exit(WRAPPER_EXIT.DID_NOT_RUN);
  }
}
