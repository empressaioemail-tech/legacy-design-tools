#!/usr/bin/env node
/**
 * CTX-C fold-in (2026-09-07): the Tier-1 bake bakes `baseFacts.cadRoll`
 * ALL-NULL by design (nodeFacetBakeTier1Cli.ts:507-514) — population is a
 * separate CLI (nodeFacetPatchCadRollFromCadPropertyCli.ts). Before this
 * wrapper existed, the onboarding runbook (factory_onboarding_runbook.md
 * Step Z7) documented only the bake half, and the patch had never been run
 * for any of the six Central-TX counties: cadRoll read as false absence
 * everywhere, a bug that reads as "looked and found nothing" when nothing
 * looked.
 *
 * This CLI is the fold-in: it runs the Tier-1 bake, then the cad-roll patch,
 * for the SAME county and the SAME --dry-run flag, as one command a runbook
 * step can name. It does not merge the two CLIs' internals (they stay
 * separately runnable, separately testable, and the patch's situs
 * cross-validation — CTX-C 2026-09-07 — stays scoped to its own file). It
 * only removes the way to run one half and forget the other.
 *
 * Usage: --county=<fips> [--dry-run] [--limit=N] [--page-size=N]
 *   (bake-only flags like --prop-ids-file pass through to the bake step;
 *   the patch step always runs whole-county — it has no scoped mode today)
 * Env: DATABASE_URL (or DEPLOYMENT_DATABASE_URL). neondb only.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function runStep(scriptRelPath: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(here, "..", "node_modules", ".bin", "tsx"), path.join(here, scriptRelPath), ...argv],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptRelPath} exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1];
  if (!county || !/^\d{5}$/.test(county)) {
    throw new Error("usage: --county=<5-digit fips> [--dry-run] [...bake flags]");
  }

  console.log(`[bake-with-cad-roll] county=${county} step=1/2 (tier1 bake)`);
  await runStep("nodeFacetBakeTier1Cli.ts", argv);

  const patchArgv = argv.filter(
    (a) => a.startsWith("--county=") || a === "--dry-run" || a.startsWith("--page-size="),
  );
  console.log(`[bake-with-cad-roll] county=${county} step=2/2 (cad-roll patch)`);
  await runStep("nodeFacetPatchCadRollFromCadPropertyCli.ts", patchArgv);

  console.log(`[bake-with-cad-roll] county=${county} done`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
