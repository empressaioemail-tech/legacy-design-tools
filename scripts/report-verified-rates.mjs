#!/usr/bin/env node
/**
 * Report web-verified rates per jurisdiction + code family from reasoning_atoms.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx report-verified-rates.mjs
 *   pnpm --filter @workspace/scripts exec tsx report-verified-rates.mjs austin_tx round_rock_tx
 */
import { db, reasoningAtoms } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  CENTRAL_TX_ADOPTION,
  DEEPEN_PRIORITY,
  CLASS_B_ONBOARD_PENDING,
} from "./centralTxAdoption.mjs";

function familyFromRow(row) {
  const ref = row.codeRef.toUpperCase();
  const edition = row.edition ?? "";
  if (ref.startsWith("IRC")) return `IRC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IBC") || ref.startsWith("IEBC")) {
    return `IBC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  }
  if (ref.startsWith("IECC")) return `IECC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IFC")) return `IFC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IPMC")) return `IPMC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("UMC")) return `UMC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("UPC")) return `UPC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IMC")) return `IMC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IPC")) return `IPC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("IFGC")) return `IFGC ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("A117")) return `A117.1 ${edition.match(/\d{4}/)?.[0] ?? ""}`.trim();
  if (ref.startsWith("TAS")) return "TAS 2012";
  if (ref.startsWith("NEC") || edition.includes("NEC")) return "NEC";
  if (ref.startsWith("NFPA") || edition.includes("NFPA")) return "NFPA";
  if (ref.startsWith("ADA")) return "ADA";
  return `${ref.split("-")[0] ?? "OTHER"} ${edition}`.trim();
}

function summarizeJurisdiction(rows) {
  const families = new Map();
  let total = 0;
  let verified = 0;
  let iccGated = 0;

  for (const row of rows) {
    total += 1;
    const isVerified = row.verificationState === "verified";
    if (isVerified) verified += 1;
    const fam = familyFromRow(row);
    const bucket = families.get(fam) ?? {
      family: fam,
      total: 0,
      verified: 0,
      deeplinkOnly: 0,
      iccLikely: false,
    };
    bucket.total += 1;
    if (isVerified) bucket.verified += 1;
    if (row.displayMode === "deeplink" && !row.snippet) bucket.deeplinkOnly += 1;
    if (fam.startsWith("IFC") || fam.startsWith("IPMC")) {
      bucket.iccLikely = true;
      if (!isVerified) iccGated += 1;
    }
    families.set(fam, bucket);
  }

  const familyRates = [...families.values()]
    .map((b) => ({
      ...b,
      verifiedRate:
        b.total > 0 ? Math.round((1000 * b.verified) / b.total) / 10 : 0,
    }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return {
    total,
    verified,
    verifiedRate: total > 0 ? Math.round((1000 * verified) / total) / 10 : 0,
    iccGatedUnverified: iccGated,
    families: familyRates,
  };
}

export async function buildVerifiedRateReport(keys) {
  const rows = await db
    .select({
      jurisdictionKey: reasoningAtoms.jurisdictionKey,
      codeRef: reasoningAtoms.codeRef,
      edition: reasoningAtoms.edition,
      verificationState: reasoningAtoms.verificationState,
      displayMode: reasoningAtoms.displayMode,
      snippet: reasoningAtoms.snippet,
    })
    .from(reasoningAtoms)
    .where(inArray(reasoningAtoms.jurisdictionKey, keys));

  const byJurisdiction = new Map();
  for (const row of rows) {
    const list = byJurisdiction.get(row.jurisdictionKey) ?? [];
    list.push(row);
    byJurisdiction.set(row.jurisdictionKey, list);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    jurisdictions: [],
  };

  for (const key of keys) {
    const adoption = CENTRAL_TX_ADOPTION[key];
    const summary = summarizeJurisdiction(byJurisdiction.get(key) ?? []);
    report.jurisdictions.push({
      key,
      label: adoption?.label ?? key,
      adoptedEditions: adoption?.adoptedEditions ?? "(not configured)",
      secFloors:
        adoption?.secFloors ??
        "SECO 2015 IRC Ch.11 / 2015 IECC commercial; TAS 2012",
      ...summary,
      status:
        summary.total === 0
          ? "no_reasoning_atoms"
          : summary.verifiedRate >= 30
            ? "deepened"
            : "shallow",
    });
  }

  return report;
}

async function main() {
  const keys =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : [...DEEPEN_PRIORITY, ...CLASS_B_ONBOARD_PENDING];
  const report = await buildVerifiedRateReport(keys);
  console.log(JSON.stringify(report, null, 2));
}

const isMain =
  process.argv[1]?.replace(/\\/g, "/").endsWith("report-verified-rates.mjs") ??
  false;
if (isMain) {
  await main();
}
