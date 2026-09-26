/**
 * P-462. Render the production-printed card for three real records and
 * record whether the ground is Mapbox Satellite with the required credits.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const htmlPath = path.join(here, "app-from-server.html");

function loadHarnessRecord() {
  const src = fs.readFileSync(path.join(here, "harness.mjs"), "utf8");
  const start = src.indexOf("const record = {");
  const end = src.indexOf("const text = JSON.stringify(record)");
  if (start < 0 || end < 0) throw new Error("harness record not found");
  return new Function(`${src.slice(start, end)}; return record;`)();
}

const records = [
  JSON.parse(fs.readFileSync(path.join(here, "records/48021-32342.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(here, "records/48021-34049.json"), "utf8")),
  loadHarnessRecord(),
];

const env = {
  ...process.env,
  PARCEL_TILES_ORIGIN:
    process.env.PARCEL_TILES_ORIGIN || "https://hauska-artifacts.nyc3.digitaloceanspaces.com",
  MAPBOX_CARD_TOKEN: process.env.MAPBOX_CARD_TOKEN || "pk.gate-mapbox-card-not-a-secret",
};

const printed = spawnSync(process.execPath, ["scripts/artifact-html-gate/run-gate.mjs"], {
  cwd: pkgRoot,
  env: { ...env, ARTIFACT_HTML_GATE_SKIP_BROWSER: "1" },
  encoding: "utf8",
  shell: false,
});
if (printed.status !== 0) {
  process.stderr.write(printed.stdout || "");
  process.stderr.write(printed.stderr || "");
  process.exit(printed.status ?? 1);
}
const app = fs.readFileSync(htmlPath, "utf8");

function hostPage(record) {
  const variant = {
    seq: ["tool-result"],
    result: { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record },
  };
  return `<!doctype html><html><body style="margin:0;background:#1f1f1f">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:780px;height:900px;border:0"></iframe>
<script>
const V=${JSON.stringify(variant)};
const f=document.getElementById("f");
window.addEventListener("message",(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data;
  if(m&&m.method==="ui/initialize"&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"p462",version:"0"},hostCapabilities:{},hostContext:{theme:"dark",displayMode:"inline"}}},"*");
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
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
  if (local && fs.existsSync(local)) return local;
  return undefined;
}

const exe = resolveChrome();
if (!exe) {
  console.error("chromium missing");
  process.exit(2);
}

const outDir = process.env.P462_EVIDENCE_DIR;
if (!outDir) {
  console.error("P462_EVIDENCE_DIR is required");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, headless: true });
const observations = {};
let failures = 0;
for (const record of records) {
  const id = record.parcelNodeId;
  const page = await browser.newPage({ viewport: { width: 820, height: 980 } });
  await page.setContent(hostPage(record));
  await page.waitForTimeout(2500);
  const frame = page.frames().find((fr) => fr !== page.mainFrame());
  const read = frame
    ? await frame.evaluate(() => {
        const html = document.body.innerHTML;
        const imgs = [...document.querySelectorAll("img.gt")].map((img) => img.getAttribute("src") || "");
        const text = document.body.innerText;
        return {
          htmlHasEsri: /arcgisonline|World_Imagery/i.test(html),
          htmlHasHold: /Mapbox held|claudemcpcontent/.test(html),
          wordmark: !!document.querySelector("[data-mapbox-wordmark]"),
          mapbox: html.includes("https://www.mapbox.com/about/maps/"),
          osm: html.includes("https://www.openstreetmap.org/copyright"),
          maxar: html.includes("https://www.maxar.com/"),
          improve: html.includes("https://apps.mapbox.com/feedback/"),
          creditVisible: (() => {
            const el = document.querySelector(".mapbox-credit");
            if (!el) return false;
            const style = getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.fontSize.replace("px", "")) >= 10;
          })(),
          tileCount: imgs.length,
          mapboxTiles: imgs.filter((src) => src.includes("api.mapbox.com/v4/mapbox.satellite") && src.includes("access_token=pk.")).length,
          axisOk: imgs.every((src) => /\/mapbox\.satellite\/\d+\/\d+\/\d+\.jpg90\?access_token=/.test(src)),
          text: text.slice(0, 400),
        };
      })
    : null;
  const shot = path.join(outDir, `${String(id).replace(":", "-")}.png`);
  if (frame) await frame.locator("body").screenshot({ path: shot });
  const ok = !!(
    read &&
    read.tileCount > 0 &&
    read.mapboxTiles === read.tileCount &&
    read.axisOk &&
    !read.htmlHasEsri &&
    !read.htmlHasHold &&
    read.wordmark &&
    read.mapbox &&
    read.osm &&
    read.maxar &&
    read.improve &&
    read.creditVisible
  );
  if (!ok) failures += 1;
  observations[id] = {
    mapboxSatelliteTiles: ok,
    esriImageryHostPresent: !!read?.htmlHasEsri,
    engineeringNotePresent: !!read?.htmlHasHold,
    tokenInjectedAsData: !!read && read.mapboxTiles > 0,
    secretToken: false,
    axisZXY: !!read?.axisOk,
    attribution: {
      wordmark: !!read?.wordmark,
      mapbox: !!read?.mapbox,
      osm: !!read?.osm,
      maxar: !!read?.maxar,
      improve: !!read?.improve,
    },
    tileCount: read?.tileCount ?? 0,
    creditVisible: !!read?.creditVisible,
    screenshot: shot,
    textPreview: read?.text ?? "",
  };
  console.log(JSON.stringify({ id, ok, tiles: read?.tileCount ?? 0 }));
  await page.close();
}
await browser.close();
const obsPath = path.join(outDir, "observations.json");
fs.writeFileSync(obsPath, JSON.stringify({ _p462: {}, ...observations }, null, 2));
console.log(obsPath);
if (failures) process.exit(1);
