/**
 * Live smoke: Track 2/3 federal GIS layers on cortex-api canary.
 * Usage: BROKERAGE_EXTENSION_PUBLIC_KEY=... node scripts/_federal-layers-canary-smoke.mjs [baseUrl] [installId]
 */
const BASE =
  process.argv[2]?.trim() ||
  "https://canary---cortex-api-tds7av26va-uc.a.run.app";
const INSTALL =
  process.argv[3]?.trim() ||
  process.env.BROKERAGE_SMOKE_INSTALL_ID?.trim() ||
  "extension-agent-map-max-qa";
const KEY = process.env.BROKERAGE_EXTENSION_PUBLIC_KEY?.trim();
if (!KEY) {
  console.error("BROKERAGE_EXTENSION_PUBLIC_KEY required");
  process.exit(1);
}

const BBOX_BASTROP = {
  westLng: -97.33,
  southLat: 30.1,
  eastLng: -97.3,
  northLat: 30.12,
};

/** Austin downtown — Edwards COA mirror has polygon coverage here. */
const BBOX_EDWARDS = {
  westLng: -97.8,
  southLat: 30.2,
  eastLng: -97.7,
  northLat: 30.3,
};

/** Austin metro — TCEQ water districts with MUD/PID coverage. */
const BBOX_MUD = {
  westLng: -97.9,
  southLat: 30.1,
  eastLng: -97.6,
  northLat: 30.4,
};

/** Houston metro — Harris County TXRRC wells layer. */
const BBOX_RRC = {
  westLng: -95.6,
  southLat: 29.6,
  eastLng: -95.2,
  northLat: 29.9,
};

const headers = {
  "Content-Type": "application/json",
  "X-Hauska-Key": KEY,
  "X-Hauska-Install-Id": INSTALL,
  Authorization: `Bearer ${KEY}`,
};

async function post(path, body) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json, url };
}

function featureCount(json) {
  if (typeof json.featureCount === "number") return json.featureCount;
  if (typeof json.payload?.featureCount === "number")
    return json.payload.featureCount;
  if (json.geojson?.features?.length != null) return json.geojson.features.length;
  if (json.payload?.geojson?.features?.length != null)
    return json.payload.geojson.features.length;
  if (json.features?.length != null) return json.features.length;
  return 0;
}

console.log(`=== FEDERAL LAYERS CANARY SMOKE ===`);
console.log(`base=${BASE}`);
console.log(`install=${INSTALL}`);
console.log("");

{
  const res = await fetch(`${BASE}/api/brokerage/v1/map-data/gis-layers`, {
    headers,
  });
  const text = await res.text();
  console.log(`GET /gis-layers status=${res.status}`);
  try {
    const j = JSON.parse(text);
    for (const layer of j.layers ?? []) {
      const deg = layer.degraded ? " DEGRADED" : "";
      console.log(`  ${layer.layer}${deg}`);
    }
    console.log(`  packageTier=${j.packageTier ?? j.error ?? "?"}`);
  } catch {
    console.log(`  body=${text.slice(0, 300)}`);
  }
  console.log("");
}

async function smokeGis(layer, bbox, note = "") {
  const { status, json } = await post("/api/brokerage/v1/map-data/gis-layer", {
    layer,
    bbox,
    fixture: false,
  });
  const count = featureCount(json);
  const err = json.error ?? json.message ?? "";
  console.log(
    `${layer}${note ? ` (${note})` : ""}: status=${status} features=${count}${err ? ` error=${err}` : ""}`,
  );
  if (status !== 200 || (count === 0 && status !== 404)) {
    console.log(`  detail=${JSON.stringify(json).slice(0, 600)}`);
  }
  return { status, count, err };
}

console.log("--- GATE LAYERS (fixture:false) ---");
const gw = await smokeGis("groundwater", BBOX_BASTROP, "Bastrop bbox");
const ed = await smokeGis("edwards-aquifer", BBOX_EDWARDS, "Austin COA mirror bbox");
await smokeGis("ssurgo-soils", BBOX_BASTROP, "known-degraded, Bastrop bbox");

console.log("");
console.log("--- ADAPTER CONFIRM (wider bbox; 404 no-coverage = valid-empty) ---");
const mud = await smokeGis("mud-pid", BBOX_MUD, "Austin metro");
const rrc = await smokeGis("texas-rrc", BBOX_RRC, "Houston metro");

console.log("");
console.log("--- ENTITLEMENT REGRESSION ---");
const MAX_INSTALL = "c8d40654-d3b7-4ae4-9331-79e9c9ace317";
const entRes = await fetch(`${BASE}/api/brokerage/v1/entitlement`, {
  headers: { ...headers, "X-Hauska-Install-Id": MAX_INSTALL },
});
const entText = await entRes.text();
console.log(`GET /entitlement install=${MAX_INSTALL} status=${entRes.status}`);
try {
  const ent = JSON.parse(entText);
  console.log(
    `  maxActive=${ent.maxActive} subscriptionTier=${ent.subscriptionTier}`,
  );
} catch {
  console.log(`  body=${entText.slice(0, 300)}`);
}

console.log("");
const gateGreen =
  gw.status === 200 &&
  gw.count > 0 &&
  ed.status === 200 &&
  ed.count > 0;
const adaptersOk =
  (mud.status === 200 && mud.count > 0) ||
  (mud.status === 404 && mud.err === "no-coverage");
const rrcOk =
  (rrc.status === 200 && rrc.count > 0) ||
  (rrc.status === 404 && rrc.err === "no-coverage");
console.log(
  `SHIFT_READY=${gateGreen && adaptersOk && rrcOk} (groundwater+edwards must be 200+features)`,
);
