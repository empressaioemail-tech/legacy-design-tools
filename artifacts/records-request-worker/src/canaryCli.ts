/**
 * P-85 WDLL item 14 — CLI entry for daily portal canary (invoked by scripts/p85).
 */

import { runDailyPortalCanary } from "./portalCanary.js";
import { withPlaywrightBrowser } from "./playwrightBrowser.js";
import { closePortalCanaryStorePool } from "./portalCanaryStore.js";

function parsePortalIdsArg(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const portalIdsArg = process.argv.find((a) => a.startsWith("--portal-ids="));
  const portalIds = parsePortalIdsArg(portalIdsArg?.slice("--portal-ids=".length));

  const outcomes = await runDailyPortalCanary({
    portalIds,
    persist: !dryRun,
    browserFactory: withPlaywrightBrowser,
  });

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    JSON.stringify({
      event: "p85_portal_canary_complete",
      dryRun,
      total: outcomes.length,
      failed: failed.length,
      outcomes,
    }),
  );

  await closePortalCanaryStorePool();

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await closePortalCanaryStorePool().catch(() => {});
  process.exit(1);
});
