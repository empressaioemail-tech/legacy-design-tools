#!/usr/bin/env node
/**
 * Spike: POST a PDF to Placid with a signed collateral asset URL, poll to finished.
 *
 * Prerequisites:
 *   - api-server running (dev:local) with COLLATERAL_SIGNING_SECRET set
 *   - PLACID_API_TOKEN + PLACID_TEST_MODE=true
 *   - Optional: start an export job first to get a real signed render URL, or pass
 *     SPIKE_PUBLIC_IMAGE_URL for a known-public image (Placid smoke test).
 *
 * Usage:
 *   node scripts/spike-placid.mjs
 *   API_BASE=http://localhost:8080 node scripts/spike-placid.mjs
 */
import { createHmac, randomUUID } from "node:crypto";

const API_BASE = (process.env.API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const PLACID_TOKEN = process.env.PLACID_API_TOKEN?.trim();
const TEST_MODE = ["1", "true", "yes"].includes(
  (process.env.PLACID_TEST_MODE ?? "true").toLowerCase(),
);
const SIGNING_SECRET = process.env.COLLATERAL_SIGNING_SECRET?.trim();
const PUBLIC_IMAGE =
  process.env.SPIKE_PUBLIC_IMAGE_URL?.trim() ??
  "https://placid.app/static/placeholders/landscape.png";

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signToken(jobId, assetKey) {
  const exp = Date.now() + 15 * 60 * 1000;
  const body = JSON.stringify({ jobId, assetKey, exp });
  const sig = base64UrlEncode(
    createHmac("sha256", SIGNING_SECRET).update(body).digest(),
  );
  return `${base64UrlEncode(Buffer.from(body, "utf8"))}.${sig}`;
}

async function main() {
  if (!PLACID_TOKEN) {
    console.error("Set PLACID_API_TOKEN");
    process.exit(1);
  }

  const cover = process.env.PLACID_TEMPLATE_COVER?.trim();
  const plan = process.env.PLACID_TEMPLATE_PLAN?.trim();
  const closing = process.env.PLACID_TEMPLATE_CLOSING?.trim();
  if (!cover || !plan || !closing) {
    console.warn(
      "PLACID_TEMPLATE_* not set — using placeholder UUIDs (may fail without real templates)",
    );
  }

  let heroImage = PUBLIC_IMAGE;
  if (SIGNING_SECRET) {
    const jobId = randomUUID();
    const assetKey = "render:spike";
    const token = signToken(jobId, assetKey);
    heroImage = `${API_BASE}/api/collateral/fetch/${token}/${encodeURIComponent(assetKey)}`;
    console.log("Signed URL (needs matching job in DB for live fetch):", heroImage);
    console.log(
      "Tip: run a real export first, or use SPIKE_PUBLIC_IMAGE_URL only for Placid API smoke.",
    );
  }

  const pages = [
    {
      template_uuid: cover ?? "00000000-0000-0000-0000-000000000001",
      layers: {
        headline: { text: "Spike headline" },
        address: { text: "1 Test St" },
        project_name: { text: "Hauska spike" },
        hero_image: { image: heroImage },
      },
    },
    {
      template_uuid: plan ?? "00000000-0000-0000-0000-000000000002",
      layers: {
        floor_plan: { image: PUBLIC_IMAGE },
        sheet_label: { text: "A1.01 — Spike sheet" },
      },
    },
    {
      template_uuid: closing ?? "00000000-0000-0000-0000-000000000003",
      layers: {
        talking_points: { text: "Spike talking points" },
      },
    },
  ];

  const body = { pages, passthrough: JSON.stringify({ spike: true }) };
  if (TEST_MODE) body.test = true;

  console.log("POST Placid PDF…");
  const createRes = await fetch("https://api.placid.app/api/rest/pdfs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PLACID_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error("Placid create failed:", created);
    process.exit(1);
  }
  console.log("Queued:", created);

  const id = created.id;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.placid.app/api/rest/pdfs/${id}`, {
      headers: { Authorization: `Bearer ${PLACID_TOKEN}` },
    });
    const status = await pollRes.json();
    console.log(`Poll ${i + 1}:`, status.status);
    if (status.status === "finished" && status.pdf_url) {
      console.log("Finished PDF:", status.pdf_url);
      process.exit(0);
    }
    if (status.status === "error") {
      console.error("Placid error:", status);
      process.exit(1);
    }
  }
  console.error("Timed out waiting for Placid PDF");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
