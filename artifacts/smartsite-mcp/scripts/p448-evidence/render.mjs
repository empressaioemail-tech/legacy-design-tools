/**
 * P-448 evidence. Renders the page printed by dist/server.mjs --print-app-html.
 * Before: the tool result as the widget receives it with no inlineCard (today's layout).
 * After: the same result after attachInlineCard (the layout this lane ships).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const htmlPath = path.join(pkgRoot, "scripts/artifact-html-gate/app-from-server.html");
const outDir = process.env.P448_EVIDENCE_DIR;
if (!outDir) {
  console.error("P448_EVIDENCE_DIR is required");
  process.exit(2);
}
if (!fs.existsSync(htmlPath)) {
  console.error("printed page missing; run scripts/artifact-html-gate/run-gate.mjs first");
  process.exit(2);
}

const built = path.join(os.tmpdir(), "p448-inline-card.mjs");
const esbuild = spawnSync(
  process.execPath,
  [
    path.join(pkgRoot, "node_modules/esbuild/bin/esbuild"),
    path.join(pkgRoot, "src/inline-card.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${built}`,
  ],
  { encoding: "utf8" },
);
if (esbuild.status !== 0) {
  console.error(esbuild.stderr || esbuild.stdout);
  process.exit(esbuild.status ?? 1);
}
const { attachInlineCard } = await import(pathToFileURL(built).href);

const reviewRecordPath = process.env.P448_REVIEW_RECORD;
const one = reviewRecordPath && fs.existsSync(reviewRecordPath)
  ? JSON.parse(fs.readFileSync(reviewRecordPath, "utf8"))
  : null;
if (!one) {
  console.error("P448_REVIEW_RECORD missing");
  process.exit(2);
}

function cloneParcel(i) {
  const copy = JSON.parse(JSON.stringify(one));
  copy.parcelNodeId = `48021:3234${i}`;
  if (copy.draw && typeof copy.draw === "object") {
    copy.draw.label = `${100 + i} MAIN ST, BASTROP, TX 78602`;
  }
  return copy;
}

const list = { parcels: [0, 1, 2, 3, 4].map(cloneParcel) };
const mapSelection = {
  name: "Map selection",
  screen: { id: "screen-evidence", name: "Map selection" },
  rows: [1, 2, 3, 4, 5].map((i) => ({
    query: `${i} Pine St, Bastrop, TX`,
    parcelNodeId: `48021:5000${i}`,
    resolution: "resolved",
    rails: { zoning: "present", landUse: "present", flood: "unknown", envelope: "unread" },
  })),
};

const cases = [
  { id: "parcel", raw: one },
  { id: "list", raw: list },
  { id: "map", raw: mapSelection },
];
const widths = [
  { id: "desktop", width: 1100 },
  { id: "phone", width: 390 },
];

const app = fs.readFileSync(htmlPath, "utf8");

function hostPage(record, width) {
  const result = { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record };
  return `<!doctype html><html><body style="margin:0;background:#1f1f1f">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:${width}px;height:900px;border:0"></iframe>
<script>
const result=${JSON.stringify(result)};
const f=document.getElementById('f');
window.addEventListener('message',(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data;
  if(m&&m.method==='ui/initialize'&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'harness',version:'0'},hostCapabilities:{},hostContext:{theme:'dark',displayMode:'inline',safeAreaInsets:{top:0,right:0,bottom:0,left:0}}}},'*');
  }
  if(m&&m.method==='ui/notifications/initialized'){
    f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
  }
});
f.srcdoc=${JSON.stringify(app).split("</").join("<\\/")};
</script></body></html>`;
}

function resolveChrome() {
  if (process.env.CHROME_PATH?.trim()) return process.env.CHROME_PATH.trim();
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

for (const phase of ["before", "after"]) {
  for (const c of cases) {
    const record = phase === "after" ? attachInlineCard(c.raw, "https://smartsite.cloud/card#evidence") : c.raw;
    for (const w of widths) {
      const page = await browser.newPage({ viewport: { width: w.width, height: 900 } });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (/smartsite\.cloud|mcp\.smartsite/i.test(url)) return route.abort();
        return route.continue();
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 180)));
      await page.setContent(hostPage(record, w.width));
      await page.waitForTimeout(2500);
      const frame = page.frames().find((fr) => fr !== page.mainFrame());
      const text = frame ? await frame.evaluate(() => document.body.innerText) : "";
      const tap = frame
        ? await frame.evaluate(() => {
            const btn = document.querySelector(".af-fit .btn");
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { h: Math.round(r.height), w: Math.round(r.width) };
          })
        : null;
      const file = path.join(outDir, `${phase}-${c.id}-${w.id}.png`);
      if (frame) await frame.locator("body").screenshot({ path: file });
      else await page.screenshot({ path: file });
      notes.push({
        file: path.basename(file),
        phase,
        case: c.id,
        width: w.width,
        errors,
        lines: text.split(/\n/).map((s) => s.trim()).filter(Boolean).length,
        tap,
        text: text.replace(/\s+/g, " ").slice(0, 500),
      });
      await page.close();
    }
  }
}
await browser.close();
fs.writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));
const failed = notes.filter((n) => n.errors.length);
console.log(JSON.stringify({ shots: notes.length, failed: failed.length }));
if (failed.length) process.exit(1);
