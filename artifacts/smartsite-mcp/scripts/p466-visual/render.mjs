/**
 * P-466 visual check. Renders the production artifact (build-prod.mjs app-prod.html)
 * at 720 and 390. The single-parcel and Zone A case is the saved live get_smart_site
 * for 48021:32342 (1305 Fayette, Zone A). 1508 Pecan was not re-read: the brief
 * route returned 401 and this session has no service key. The refused case and the
 * five-parcel list are that same live record with declared edits, not five more reads.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const outDir = process.env.P466_EVIDENCE_DIR;
if (!outDir) {
  console.error("P466_EVIDENCE_DIR is required");
  process.exit(2);
}

process.env.PARCEL_TILES_ORIGIN =
  process.env.PARCEL_TILES_ORIGIN || "https://hauska-artifacts.nyc3.digitaloceanspaces.com";
process.env.MAPBOX_CARD_TOKEN = process.env.MAPBOX_CARD_TOKEN || "pk.gate-mapbox-card-not-a-secret";

const built = spawnSync(process.execPath, ["scripts/prod-bundle-gate/build-prod.mjs"], {
  cwd: pkgRoot,
  encoding: "utf8",
});
if (built.status !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(built.status ?? 1);
}
const htmlPath = path.join(pkgRoot, "scripts/prod-bundle-gate/app-prod.html");
const app = fs.readFileSync(htmlPath, "utf8");

const inlineBuilt = path.join(os.tmpdir(), "p466-inline-card.mjs");
const esbuild = spawnSync(
  process.execPath,
  [
    path.join(pkgRoot, "node_modules/esbuild/bin/esbuild"),
    path.join(pkgRoot, "src/inline-card.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${inlineBuilt}`,
  ],
  { encoding: "utf8" },
);
if (esbuild.status !== 0) {
  console.error(esbuild.stderr || esbuild.stdout);
  process.exit(esbuild.status ?? 1);
}
const { attachInlineCard } = await import(pathToFileURL(inlineBuilt).href);

const recordPath =
  process.env.P466_LIVE_RECORD ||
  "P:/doc_repo/_inbox/2026-09-26_review_mcp_status/record-32342.json";
const live = JSON.parse(fs.readFileSync(recordPath, "utf8"));
delete live.mapRenderReport;

function refusedCopy(src) {
  const copy = JSON.parse(JSON.stringify(src));
  const sections = copy.brief && Array.isArray(copy.brief.sections) ? copy.brief.sections : [];
  for (const section of sections) {
    if (section.id === "setbacks-envelope") {
      section.disposition = "refused";
      section.data = null;
      section.reason = "The code gives no setback figures for this district.";
    }
  }
  if (copy.draw && Array.isArray(copy.draw.overlays)) {
    copy.draw.overlays = copy.draw.overlays.map((o) =>
      o.id === "envelope" ? { ...o, state: "refused", geom: undefined } : o,
    );
  }
  return copy;
}

function listOfFive(src) {
  const parcels = [0, 1, 2, 3, 4].map((i) => {
    const copy = JSON.parse(JSON.stringify(src));
    copy.parcelNodeId = `48021:3234${i}`;
    if (copy.draw) copy.draw.label = `${100 + i} MAIN ST, BASTROP, TX 78602`;
    return copy;
  });
  return { parcels };
}

const board = {
  id: "p466-screen",
  name: "Screening",
  screen: { id: "p466-screen", name: "Screening" },
  rows: [
    {
      query: "1305 FAYETTE ST, BASTROP, TX 78602",
      parcelNodeId: "48021:32342",
      resolution: "resolved",
      stub: { situs: "present", zoning: "present", landUse: "present", flood: "present", drainage: "unread", envelope: "present" },
      stubRead: "ok",
    },
    {
      query: "908 Pine, Bastrop TX",
      parcelNodeId: "48021:34137",
      resolution: "resolved",
      stub: { situs: "present", zoning: "present", landUse: "absent", flood: "present", drainage: "unknown", envelope: "refused" },
      stubRead: "ok",
    },
    {
      query: "111 Rainmaker Cv, Bastrop TX",
      parcelNodeId: "48021:34169",
      resolution: "resolved",
      stub: { situs: "present", zoning: "unknown", landUse: "unread", flood: "present", drainage: "unread", envelope: "unknown" },
      stubRead: "ok",
    },
    { query: "zzzz-not-a-situs-99999", parcelNodeId: null, resolution: "unresolved" },
  ],
};

const share = "https://smartsite.cloud/card#p466";
const cases = [
  { id: "zone-a-32342", record: attachInlineCard(live, share), expand: true },
  { id: "refused-from-32342", record: attachInlineCard(refusedCopy(live), share), expand: false },
  { id: "list-five", record: attachInlineCard(listOfFive(live), share), expand: false },
  { id: "board", record: board, expand: false },
];
const widths = [720, 390];

function hostPage(record, width) {
  const result = { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record };
  return `<!doctype html><html><body style="margin:0;background:#141413">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:${width}px;height:980px;border:0"></iframe>
<script>
const result=${JSON.stringify(result)};
const f=document.getElementById("f");
window.addEventListener("message",(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data;
  if(m&&m.method==="ui/initialize"&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"p466",version:"0"},hostCapabilities:{},hostContext:{theme:"dark",displayMode:"inline",safeAreaInsets:{top:0,right:0,bottom:0,left:0}}}},"*");
  }
  if(m&&m.method==="ui/notifications/initialized"){
    f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-call",params:{toolName:"get_smart_site"}},"*");
    f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:result},"*");
  }
});
f.srcdoc=${JSON.stringify(app).split("</").join("<\\/")};
</script></body></html>`;
}

function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    const from = chromium.executablePath();
    if (from && fs.existsSync(from)) return from;
  } catch { /* not installed */ }
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
  if (local && fs.existsSync(local)) return local;
  return undefined;
}

const exe = resolveChrome();
if (!exe) {
  console.error("chromium missing");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true });
const notes = [];

for (const c of cases) {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (/smartsite\.cloud|mcp\.smartsite/i.test(url)) return route.abort();
      return route.continue();
    });
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err.message).slice(0, 240)));
    await page.setContent(hostPage(c.record, width));
    await page.waitForTimeout(2000);
    const frame = page.frames().find((fr) => fr !== page.mainFrame());
    if (frame) {
      frame.on("pageerror", (err) => errors.push(String(err.message).slice(0, 240)));
      const wordmark = await frame.evaluate(() => document.body.innerText.includes("SMART") && document.body.innerText.includes("SITE"));
      const file = path.join(outDir, `${c.id}-${width}.png`);
      await frame.locator("body").screenshot({ path: file });
      let detail = null;
      if (c.expand) {
        const expand = frame.locator('[data-act="expand"]');
        if (await expand.count()) {
          await expand.click();
          await page.waitForTimeout(400);
          const detailFile = path.join(outDir, `${c.id}-detail-${width}.png`);
          await frame.locator("body").screenshot({ path: detailFile });
          detail = path.basename(detailFile);
          const tile = frame.locator(".ss-row").first();
          if (await tile.count()) await tile.click();
        }
      }
      const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400));
      notes.push({ file: path.basename(file), detail, case: c.id, width, errors, wordmark, text });
    } else {
      notes.push({ case: c.id, width, errors: ["no iframe"], wordmark: false, text: "" });
    }
    await page.close();
  }
}

await browser.close();
fs.writeFileSync(path.join(outDir, "notes.json"), JSON.stringify({
  liveRecord: "48021:32342 Zone A, saved get_smart_site 2026-09-26T00:53Z",
  notFetched: "1508 PECAN ST (48021:27831): POST /api/property-explorer/v1/research/brief returned 401; no SERVICE_API_KEY in this session",
  shots: notes,
}, null, 2));
const failed = notes.filter((n) => n.errors.length);
console.log(JSON.stringify({ shots: notes.length, failed: failed.length, errors: failed }));
if (failed.length) process.exit(1);
