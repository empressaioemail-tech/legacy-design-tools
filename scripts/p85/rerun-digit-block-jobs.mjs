#!/usr/bin/env node
/**
 * Re-queue one representative job per Bastrop digit-BLOCK parcel under the
 * 2026-09-01 portal-access ruling. Operator-permitted population: 14 jobs on
 * 3 parcels; one fresh run per parcel is sufficient to grade the landed parser.
 *
 * Prerequisites: worker deployed with BL(?:OC)?K parser + portal ruling engineering.
 * STOP: exits non-zero on portal-access-blocked (403/429/WAF) — do not retry.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/p85/rerun-digit-block-jobs.mjs [--dry-run]
 *   DATABASE_URL=... node scripts/p85/rerun-digit-block-jobs.mjs --apply
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "../../lib/db/package.json"),
);
const pg = require("pg");

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;

const WORKER_URL =
  process.env.RECORDS_REQUEST_WORKER_URL?.trim() ||
  "https://records-request-worker-1062716564162.us-central1.run.app/run";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

/** One template job id per parcel from _inbox/2026-08-31_p85_block_job_audit.json misses. */
const RERUN_TEMPLATE_JOB_IDS = [
  "9703c205-040f-4707-8535-8335d610db5a", // apn:48021:34161 block 13
  "28844a8a-a694-4097-9973-ecd4b0c881a3", // apn:48021:34753 block 27
  "cbc08afe-cdb8-4be9-8a77-598d9a425228", // apn:48021:35481 block 49
];

const CURRENT_BLOCK_PATTERN = /\bBL(?:OC)?K\.?\s+(\d+[A-Z]?)\b/i;

function parseBlock(legal) {
  if (!legal?.trim()) return null;
  return legal.trim().match(CURRENT_BLOCK_PATTERN)?.[1]?.trim() ?? null;
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function waitForTerminal(jobId, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT id, status, error_code, error_message,
              request_payload->'searchTerms'->>'block' AS stored_block,
              scope_searched->'robotsTxt' AS robots_txt
       FROM records_request_jobs WHERE id = $1`,
      [jobId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`job_missing:${jobId}`);
    }
    const terminal = ["complete", "failed", "needs-human"].includes(row.status);
    if (terminal) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timeout_waiting:${jobId}`);
}

async function main() {
  const results = [];

  for (const templateId of RERUN_TEMPLATE_JOB_IDS) {
    const { rows } = await pool.query(
      `SELECT id, parcel_key, county_fips, engagement_id, user_id, user_email,
              request_payload, live_instant_gis, place_key
       FROM records_request_jobs WHERE id = $1`,
      [templateId],
    );
    const template = rows[0];
    if (!template) {
      console.error(JSON.stringify({ error: "template_not_found", templateId }));
      process.exit(1);
    }

    const payload =
      template.request_payload && typeof template.request_payload === "object"
        ? { ...template.request_payload }
        : {};
    const searchTerms =
      payload.searchTerms && typeof payload.searchTerms === "object"
        ? { ...payload.searchTerms }
        : {};
    const legal = searchTerms.legalDescription ?? null;
    const parsedBlock = parseBlock(legal);
    if (!parsedBlock) {
      console.error(
        JSON.stringify({
          error: "block_not_parsed",
          templateId,
          parcelKey: template.parcel_key,
          legalDescription: legal,
        }),
      );
      process.exit(1);
    }
    searchTerms.block = parsedBlock;
    payload.searchTerms = searchTerms;
    payload.rerunOf = templateId;
    payload.rerunReason = "2026-09-01_portal_ruling_digit_block";

    const plan = {
      templateId,
      parcelKey: template.parcel_key,
      parsedBlock,
      dryRun,
    };

    if (dryRun) {
      results.push({ ...plan, action: "dry-run" });
      continue;
    }

    const active = await pool.query(
      `SELECT id, status FROM records_request_jobs
       WHERE engagement_id = $1 AND user_id = $2
         AND status IN ('queued', 'running', 'awaiting-purchase-approval')
       LIMIT 1`,
      [template.engagement_id, template.user_id],
    );
    if (active.rows[0]) {
      console.error(
        JSON.stringify({
          error: "active_job_blocks_rerun",
          engagementId: template.engagement_id,
          userId: template.user_id,
          activeJobId: active.rows[0].id,
          activeStatus: active.rows[0].status,
        }),
      );
      process.exit(1);
    }

    const inserted = await pool.query(
      `INSERT INTO records_request_jobs (
         engagement_id, place_key, user_id, user_email, parcel_key, county_fips,
         status, request_payload, live_instant_gis, recipe_version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7::jsonb,$8::jsonb,$9,NOW(),NOW())
       RETURNING id`,
      [
        template.engagement_id,
        template.place_key,
        template.user_id,
        template.user_email,
        template.parcel_key,
        template.county_fips,
        JSON.stringify(payload),
        JSON.stringify(template.live_instant_gis ?? {}),
        "p85-rerun-digit-block-2026-09-01",
      ],
    );
    const jobId = inserted.rows[0].id;

    const workerRes = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    const workerBody = await workerRes.text();

    const final = await waitForTerminal(jobId);

    if (final.error_code === "portal-access-blocked") {
      console.error(
        JSON.stringify({
          event: "STOP_portal_access_blocked",
          jobId,
          parcelKey: template.parcel_key,
          errorMessage: final.error_message,
          robotsTxt: final.robots_txt,
        }),
      );
      process.exit(3);
    }

    results.push({
      ...plan,
      action: "ran",
      jobId,
      workerHttpStatus: workerRes.status,
      workerBodySnippet: workerBody.slice(0, 300),
      finalStatus: final.status,
      errorCode: final.error_code,
      storedBlock: final.stored_block,
      hasRobotsTxtLog: final.robots_txt != null,
    });
  }

  console.log(JSON.stringify({ event: "p85_digit_block_rerun", results }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
