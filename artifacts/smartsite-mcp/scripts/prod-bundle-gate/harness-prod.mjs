/**
 * Headless Chromium: MCP Apps host harness for the production-built served card.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, "app-prod.html"), "utf8");

const record = {
  parcelNodeId: "48021:27246",
  onRecord: {
    apn: "27246",
    acreage: { value: 1.0861, sqft: 47309 },
    countyFips: "48021",
    countyName: "Bastrop",
    situsState: "TX",
  },
  brief: {
    sections: [
      {
        id: "zoning",
        title: "Zoning",
        data: { district: "PI" },
        citations: [],
        disposition: "present",
        dispositionDisplayText: "Present",
      },
      {
        id: "setbacks-envelope",
        title: "Setbacks and buildable envelope",
        data: {
          frontFt: 25,
          sideFt: 15,
          rearFt: 20,
          cornerFt: 20,
          district: "PI",
        },
        citations: [],
        disposition: "present",
        dispositionDisplayText: "Present",
      },
      {
        id: "flood",
        title: "Flood",
        data: { floodZone: "X", floodway: false },
        citations: [],
        disposition: "present",
        dispositionDisplayText: "Present",
      },
      {
        id: "land-use",
        title: "Land use",
        data: { landUseCode: "XV" },
        citations: [],
        disposition: "present",
        dispositionDisplayText: "Present",
      },
      {
        id: "drainage",
        title: "Drainage",
        data: null,
        citations: [],
        disposition: "unread",
        reason: "drainage facet not produced for this parcel",
        dispositionDisplayText: "Not read",
      },
    ],
    disclosure: [],
  },
  draw: {
    node: "48021:27246",
    kind: "parcel",
    label: "1201 WATER , BASTROP, TX 78602",
    url: "https://smartsite.cloud/p/48021:27246",
    frame: {
      units: "ft",
      origin: "centroid",
      yAxis: "true-north",
      anchor: { lat: 30.11332, lng: -97.31835 },
    },
    attrs: { zoning: { v: "PI", state: "present" }, apn: "27246" },
    overlays: [
      {
        id: "flood",
        label: "Zone X",
        sfha: false,
        geom: "none",
        draw: "tint-ring",
        state: "present",
        citations: [],
      },
      {
        id: "footprint",
        label: "Structure of record (1963)",
        geom: "none",
        draw: "hatch-interior",
        state: "present",
      },
    ],
    ring: [
      [50.14, -71.87],
      [48.57, 5.31],
      [47.5, 73.31],
      [46.02, 142.98],
      [-7.59, 141.69],
      [-7.79, 56.21],
      [-117.04, 55.12],
      [-113.4, -202.05],
      [53.61, -200.71],
    ],
    ringOrder: "ccw",
    edges: [],
  },
  anchor: {
    lat: 30.11332,
    lon: -97.31835,
    precision: "1e-5-deg",
    source: "bake-latlng-index",
  },
  anchorRead: { status: "ok" },
};

const text = JSON.stringify(record);
const shapes = {
  textAndStructured: {
    content: [{ type: "text", text }],
    structuredContent: record,
  },
  textOnly: { content: [{ type: "text", text }] },
  linkThenText: {
    content: [
      {
        type: "resource_link",
        uri: "ui://smartsite/app-p562.html",
        name: "Smart Site board",
      },
      { type: "text", text },
    ],
  },
};
const sequences = {
  specInputThenResult: ["tool-input", "tool-result"],
  callThenResult: ["tool-call", "tool-result"],
  resultOnly: ["tool-result"],
};

function hostPage(variant) {
  return `<!doctype html><html><body style="margin:0;background:#1f1f1f">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:700px;height:520px;border:0"></iframe>
<script>
const V=${JSON.stringify(variant)};
const f=document.getElementById('f');
window.__log=[];
window.addEventListener('message',(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data; window.__log.push(m&&m.method||('resp:'+(m&&m.id)));
  if(m&&m.method==='ui/initialize'&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'harness',version:'0'},hostCapabilities:{},hostContext:{theme:'dark',displayMode:'inline'}}},'*');
  }
  if(m&&m.method==='ui/notifications/initialized'){
    for(const step of V.seq){
      if(step==='tool-input') f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{parcelNodeId:'48021:27246',depth:'node'}}},'*');
      if(step==='tool-call') f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-call',params:{toolName:'get_smart_site'}},'*');
      if(step==='tool-result') f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:V.result},'*');
    }
  }
});
f.srcdoc=${JSON.stringify(app).split("</").join("<\\/")};
</script></body></html>`;
}

function resolveChromeExecutable() {
  if (process.env.CHROME_PATH?.trim()) return process.env.CHROME_PATH.trim();
  if (process.env.PUPPETEER_EXECUTABLE_PATH?.trim()) {
    return process.env.PUPPETEER_EXECUTABLE_PATH.trim();
  }
  try {
    const fromPlaywright = chromium.executablePath();
    if (fromPlaywright && fs.existsSync(fromPlaywright)) return fromPlaywright;
  } catch {
    /* playwright browsers not installed yet */
  }
  const local =
    process.env.LOCALAPPDATA &&
    path.join(
      process.env.LOCALAPPDATA,
      "ms-playwright/chromium-1228/chrome-win64/chrome.exe",
    );
  if (local && fs.existsSync(local)) return local;
  return undefined;
}

const exe = resolveChromeExecutable();
if (!exe) {
  console.error(
    "Run `pnpm exec playwright install chromium` or set CHROME_PATH for the prod-bundle harness",
  );
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
let failures = 0;
for (const [sn, seq] of Object.entries(sequences)) {
  for (const [rn, result] of Object.entries(shapes)) {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200));
    });
    await page.setContent(hostPage({ seq, result }));
    await page.waitForTimeout(3500);
    const frame = page.frames().find((fr) => fr !== page.mainFrame());
    const body = frame
      ? (await frame.evaluate(() => document.body.innerText))
          .replace(/\s+/g, " ")
          .slice(0, 160)
      : "no frame";
    const ring = frame
      ? await frame.evaluate(() =>
          document.body.innerHTML.includes('aria-label="parcel ring"'),
        )
      : false;
    const stuck = /Reading this tool result/i.test(body);
    const label = `${sn}/${rn}`;
    if (errors.length || stuck || !ring) {
      failures += 1;
      console.error(
        JSON.stringify({ variant: label, stuck, ring, errors, bodyPreview: body }),
      );
    } else {
      console.log(JSON.stringify({ variant: label, ok: true }));
    }
    await page.close();
  }
}
await browser.close();
if (failures) process.exit(1);
console.log(JSON.stringify({ variants: 9, failures: 0 }));
