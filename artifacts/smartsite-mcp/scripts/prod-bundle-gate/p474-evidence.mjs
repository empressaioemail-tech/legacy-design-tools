/**
 * P-474 / P-456 part 3: screenshots from the production esbuild artifact with real records.
 * Usage: P474_EVIDENCE_DIR=<path> node scripts/prod-bundle-gate/p474-evidence.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const recordsDir = path.join(pkgRoot, "scripts/artifact-html-gate/records");
const htmlPath = path.join(here, "app-prod.html");

const STUDIO_OWNER = {
  state: "present",
  source: "owner-fact",
  taxYear: 2025,
  ownerName: "SMITH, RICHARD P & SUSAN J",
  ownerMailingAddress: "908 PINE ST, BASTROP, TX 78602",
  exemptionFlags: { homestead: true, seniorOrDisability: false, agricultural: false, veteran: false },
  sourceAdapter: "cad-property-owner-v1",
  sourceVintage: "data-export-01.14.2026",
};

const SOLO_OWNER = {
  state: "refused",
  code: "studio-gated",
  source: "owner-fact",
  reason:
    "owner-fact is Studio or Team only, or requires an active property unlock on this parcel.",
};

const env = {
  ...process.env,
  PARCEL_TILES_ORIGIN:
    process.env.PARCEL_TILES_ORIGIN || "https://hauska-artifacts.nyc3.digitaloceanspaces.com",
  MAPBOX_CARD_TOKEN: process.env.MAPBOX_CARD_TOKEN || "pk.gate-mapbox-card-not-a-secret",
  PROD_BUNDLE_GATE_SKIP_BROWSER: "1",
};

const build = spawnSync(process.execPath, ["run-gate.mjs"], {
  cwd: here,
  env,
  encoding: "utf8",
});
if (build.status !== 0) {
  process.stderr.write(build.stdout || "");
  process.stderr.write(build.stderr || "");
  process.exit(build.status ?? 1);
}
const app = fs.readFileSync(htmlPath, "utf8");

function loadRecord(name) {
  return JSON.parse(fs.readFileSync(path.join(recordsDir, name), "utf8"));
}

const scenarios = [
  { id: "48021-32342-zone-a", record: loadRecord("48021-32342.json"), step: "flood-zone-a" },
  { id: "48021-34049", record: loadRecord("48021-34049.json"), step: "bastrop-parcel" },
  { id: "48453-445501", record: loadRecord("48453-445501.json"), step: "austin-parcel" },
  {
    id: "48021-32342-owner-studio",
    record: { ...loadRecord("48021-32342.json"), ownerFact: STUDIO_OWNER },
    step: "owner-studio-detail",
    detailOnly: true,
  },
  {
    id: "48021-32342-owner-solo",
    record: { ...loadRecord("48021-32342.json"), ownerFact: SOLO_OWNER },
    step: "owner-solo-gated",
    detailOnly: true,
  },
];

const viewports = [
  { tag: "720-dark", width: 720, height: 900, theme: "dark" },
  { tag: "720-light", width: 720, height: 900, theme: "light" },
  { tag: "390-dark", width: 390, height: 844, theme: "dark" },
  { tag: "390-light", width: 390, height: 844, theme: "light" },
];

function hostPage(record, theme) {
  const variant = {
    seq: ["tool-result"],
    result: { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record },
  };
  return `<!doctype html><html><body style="margin:0;background:${theme === "light" ? "#f5f5f5" : "#1f1f1f"}">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:100%;height:100%;border:0"></iframe>
<script>
const V=${JSON.stringify(variant)};
const THEME=${JSON.stringify(theme)};
const f=document.getElementById("f");
window.addEventListener("message",(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data;
  if(m&&m.method==="ui/initialize"&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"p474-evidence",version:"0"},hostCapabilities:{},hostContext:{theme:THEME,displayMode:"inline"}}},"*");
  }
  if(m&&m.method==="ui/notifications/initialized"){
    f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:V.result},"*");
  }
});
f.srcdoc=${JSON.stringify(app).split("</").join("<\\/")};
</script></body></html>`;
}

function resolveChrome() {
  if (process.env.CHROME_PATH?.trim()) return process.env.CHROME_PATH.trim();
  try {
    const fromPlaywright = chromium.executablePath();
    if (fromPlaywright && fs.existsSync(fromPlaywright)) return fromPlaywright;
  } catch { /* not installed */ }
  const local =
    process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
  if (local && fs.existsSync(local)) return local;
  return undefined;
}

const outDir = process.env.P474_EVIDENCE_DIR;
if (!outDir) {
  console.error("P474_EVIDENCE_DIR is required");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const exe = resolveChrome();
if (!exe) {
  console.error("chromium missing");
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
const manifest = [];

for (const sc of scenarios) {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.setContent(hostPage(sc.record, vp.theme));
    await page.waitForTimeout(3500);
    const frame = page.frames().find((fr) => fr !== page.mainFrame());
    if (!frame) {
      manifest.push({ id: sc.id, viewport: vp.tag, error: "no frame" });
      await page.close();
      continue;
    }
    const inlineName = `${sc.id}__${vp.tag}__inline.png`;
    await frame.locator("body").screenshot({ path: path.join(outDir, inlineName) });

    let detailName = null;
    let ownerCheck = null;
    if (!sc.detailOnly || sc.detailOnly) {
      await frame.evaluate(() => {
        if (window.__ss && typeof window.__ss.expand === "function") window.__ss.expand();
      });
      await page.waitForTimeout(800);
      detailName = `${sc.id}__${vp.tag}__detail.png`;
      await frame.locator("body").screenshot({ path: path.join(outDir, detailName) });
      ownerCheck = await frame.evaluate(() => {
        const gated = document.querySelector('[data-owner="gated"]');
        const present = document.querySelector('[data-owner="present"]');
        const inlineOwner = document.querySelector('[data-inline="1"] [data-owner]');
        return {
          detailGated: !!gated,
          detailPresent: !!present,
          inlineHasOwner: !!inlineOwner,
          ring: document.body.innerHTML.includes('aria-label="parcel ring"'),
          mapboxCredit: !!document.querySelector(".mapbox-credit"),
          floodHeavy: document.body.innerHTML.includes('data-flood-tint="heavy"'),
          floodLight: document.body.innerHTML.includes('data-flood-tint="light"'),
        };
      });
    }

    manifest.push({
      id: sc.id,
      step: sc.step,
      viewport: vp.tag,
      inline: inlineName,
      detail: detailName,
      checks: ownerCheck,
    });
    console.log(JSON.stringify({ id: sc.id, viewport: vp.tag, ok: !!ownerCheck?.ring }));
    await page.close();
  }
}

const manifestPath = path.join(outDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify({ artifact: "prod-bundle-gate/app-prod.html", manifest }, null, 2));
console.log(manifestPath);
await browser.close();
