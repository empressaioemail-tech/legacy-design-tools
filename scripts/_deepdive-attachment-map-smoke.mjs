#!/usr/bin/env node
/**
 * Smoke — research-chat address body, encumbrance complete-upload, map-data Max hero.
 *
 * Usage:
 *   BROKERAGE_EXTENSION_PUBLIC_KEY=... [BROKERAGE_OPERATOR_KEY=...] \
 *     node scripts/_deepdive-attachment-map-smoke.mjs [baseUrl]
 *
 * Optional env:
 *   BROKERAGE_OPERATOR_KEY — operator tier for map-data 200 (Max)
 *   REAL_CCR_PDF — path to a real CC&R PDF (default scripts/_404-remodel-b.pdf)
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE =
  process.argv[2]?.trim() ||
  "https://canary---cortex-api-tds7av26va-uc.a.run.app";
const EXT_KEY = process.env.BROKERAGE_EXTENSION_PUBLIC_KEY?.trim();
const OP_KEY = process.env.BROKERAGE_OPERATOR_KEY?.trim();
if (!EXT_KEY) {
  console.error("BROKERAGE_EXTENSION_PUBLIC_KEY required");
  process.exit(1);
}

const INSTALL = `cc-agent-C-deepdive-${Date.now()}`;
const BASTROP = "251 Cool Water Dr, Bastrop, TX 78602";
const BASTROP_LAT = 30.1109;
const BASTROP_LNG = -97.3153;

const extHeaders = {
  Authorization: `Bearer ${EXT_KEY}`,
  "X-Hauska-Install-Id": INSTALL,
  "Content-Type": "application/json",
};

const __dir = dirname(fileURLToPath(import.meta.url));
const realPdfPath =
  process.env.REAL_CCR_PDF?.trim() ||
  join(__dir, "_404-remodel-b.pdf");
const BAD_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
);

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, raw: text };
}

async function presignComplete(workspaceDid, name, bytes, headers) {
  const presign = await jsonFetch(
    `${BASE}/api/brokerage/v1/workspaces/encumbrances/request-upload-url`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceDid,
        name,
        size: bytes.length,
        contentType: "application/pdf",
      }),
    },
  );
  if (presign.status !== 200) return { presign, complete: null };

  const put = await fetch(presign.body.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!put.ok) {
    return {
      presign,
      complete: { status: put.status, body: { error: "gcs_put_failed" } },
    };
  }

  const complete = await jsonFetch(
    `${BASE}/api/brokerage/v1/workspaces/encumbrances/complete-upload`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceDid,
        objectPath: presign.body.objectPath,
        name,
        size: bytes.length,
        contentType: "application/pdf",
      }),
    },
  );
  return { presign, complete };
}

async function main() {
  console.log("BASE", BASE);
  console.log("INSTALL", INSTALL);

  console.log("\n===== POST /brief (Bastrop) =====");
  const brief = await jsonFetch(`${BASE}/api/brokerage/v1/brief`, {
    method: "POST",
    headers: extHeaders,
    body: JSON.stringify({ address: BASTROP }),
  });
  console.log("HTTP", brief.status);
  console.log(brief.raw.slice(0, 400));
  if (brief.status !== 200) throw new Error("brief failed");

  const workspaceDid = brief.body?.meta?.encumbranceUploadCta?.workspaceDid;
  const runId = brief.body?.runId;

  console.log("\n===== POST /research/chat { message, address } =====");
  const chat = await jsonFetch(`${BASE}/api/brokerage/v1/research/chat`, {
    method: "POST",
    headers: extHeaders,
    body: JSON.stringify({
      address: BASTROP,
      message: "Can the buyer add an ADU?",
      history: [],
    }),
  });
  console.log("HTTP", chat.status);
  console.log(chat.raw.slice(0, 500));
  if (chat.status !== 200) throw new Error("research chat address body failed");

  console.log("\n===== complete-upload bad PDF → expect 422 =====");
  if (!workspaceDid) throw new Error("missing workspaceDid from brief meta");
  const bad = await presignComplete(
    workspaceDid,
    "broken.pdf",
    BAD_PDF,
    extHeaders,
  );
  console.log("complete HTTP", bad.complete?.status);
  console.log(JSON.stringify(bad.complete?.body, null, 2));
  if (bad.complete?.status !== 422) {
    throw new Error(`bad PDF expected 422, got ${bad.complete?.status}`);
  }
  if (bad.complete?.body?.error !== "pdf_unparseable") {
    throw new Error("bad PDF expected pdf_unparseable");
  }

  if (existsSync(realPdfPath)) {
    console.log("\n===== complete-upload real CC&R PDF → expect 201 =====");
    const realBytes = readFileSync(realPdfPath);
    const good = await presignComplete(
      workspaceDid,
      "ccr-real.pdf",
      realBytes,
      extHeaders,
    );
    console.log("complete HTTP", good.complete?.status);
    console.log(
      JSON.stringify(
        {
          instruments: good.complete?.body?.instruments?.length,
          clauses: good.complete?.body?.clauses?.length,
          accessPolicy:
            good.complete?.body?.instruments?.[0]?.instrument?.accessPolicy,
          installId: good.complete?.body?.instruments?.[0]?.installId,
        },
        null,
        2,
      ),
    );
    if (good.complete?.status !== 201) {
      throw new Error(`real PDF expected 201, got ${good.complete?.status}`);
    }
  } else {
    console.log("\n(skip real PDF — file not found:", realPdfPath, ")");
  }

  const mapKey = OP_KEY ?? EXT_KEY;
  const mapHeaders = {
    Authorization: `Bearer ${mapKey}`,
    "X-Hauska-Install-Id": INSTALL,
    "Content-Type": "application/json",
  };

  console.log("\n===== POST /map-data (Max) =====");
  const map = await jsonFetch(`${BASE}/api/brokerage/v1/map-data`, {
    method: "POST",
    headers: mapHeaders,
    body: JSON.stringify({
      latitude: BASTROP_LAT,
      longitude: BASTROP_LNG,
      address: BASTROP,
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
    }),
  });
  console.log("HTTP", map.status);
  if (map.status === 200) {
    const layers = map.body?.mapData?.layers ?? [];
    const overlays = map.body?.reasoningOverlays ?? [];
    console.log(
      "layers",
      layers.map((l) => `${l.layerKey}:${l.status}`).join(", "),
    );
    console.log(
      "reasoningOverlays",
      overlays.map((o) => `${o.kind}:${o.citationAdapter ?? "—"}`).join(", "),
    );
    console.log("packageTier", map.body?.packageTier);
  } else {
    console.log(map.raw.slice(0, 600));
    if (!OP_KEY && map.status === 403) {
      console.log(
        "(map-data 403 expected for extension_public — set BROKERAGE_OPERATOR_KEY for Max smoke)",
      );
    } else {
      throw new Error(`map-data unexpected ${map.status}`);
    }
  }

  console.log("\n===== PASS =====");
  console.log(JSON.stringify({ install: INSTALL, runId, workspaceDid }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
