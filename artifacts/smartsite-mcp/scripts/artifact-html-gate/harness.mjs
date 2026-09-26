/**
 * Headless Chromium: MCP Apps host harness for the production-built served card.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { customerProseViolations } from "./prose-violations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.env.APP_HTML_PATH?.trim() || path.join(here, "app-from-server.html");
if (!fs.existsSync(htmlPath)) {
  console.error("APP_HTML_PATH missing:", htmlPath);
  process.exit(2);
}
const app = fs.readFileSync(htmlPath, "utf8");

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

/** 1x1 JPEG. The gate must not call Mapbox with a live token. */
const TINY_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda00080001000100003f00fbffd9",
  "hex",
);

function satelliteTileUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.origin !== "https://api.mapbox.com") return false;
    if (!/^\/v4\/mapbox\.satellite\/\d+\/\d+\/\d+\.jpg90$/.test(u.pathname)) return false;
    const token = u.searchParams.get("access_token") || "";
    return token.startsWith("pk.") && !token.startsWith("sk.");
  } catch {
    return false;
  }
}

/** Connectivity probe baked into the page. It carries no token. */
function probeTileUrl(raw) {
  try {
    const u = new URL(raw);
    return (
      u.origin === "https://api.mapbox.com" &&
      u.pathname === "/v4/mapbox.satellite/0/0/0.jpg90" &&
      !u.searchParams.get("access_token")
    );
  } catch {
    return false;
  }
}

const exe = resolveChromeExecutable();
if (!exe) {
  console.error(
    "Run `pnpm exec playwright-core install chromium` or set CHROME_PATH for the prod-bundle harness",
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
      if (m.type() !== "error") return;
      const text = m.text();
      // Headless file:// harness cannot reach prod health; ignore CORS/network noise.
      if (
        /mcp\.smartsite\.cloud\/health/i.test(text) ||
        /Access-Control-Allow-Origin/i.test(text) ||
        /net::ERR_FAILED/i.test(text)
      ) {
        return;
      }
      errors.push("console: " + text.slice(0, 200));
    });
    let mapboxTiles = 0;
    await page.route("https://api.mapbox.com/**", async (route) => {
      const url = route.request().url();
      const ground = satelliteTileUrl(url);
      if (!ground && !probeTileUrl(url)) {
        errors.push("mapbox request: " + url.slice(0, 180));
        await route.abort();
        return;
      }
      if (ground) mapboxTiles += 1;
      await route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: TINY_JPEG,
      });
    });
    await page.route("https://server.arcgisonline.com/**", async (route) => {
      errors.push("esri imagery host requested");
      await route.abort();
    });
    await page.setContent(hostPage({ seq, result }));
    await page.waitForTimeout(3500);
    const frame = page.frames().find((fr) => fr !== page.mainFrame());
    const fullText = frame ? await frame.evaluate(() => document.body.innerText) : "";
    const body = fullText.replace(/\s+/g, " ").slice(0, 160) || "no frame";
    const prose = customerProseViolations(fullText, "48021:27246");
    const ring = frame
      ? await frame.evaluate(() =>
          document.body.innerHTML.includes('aria-label="parcel ring"'),
        )
      : false;
    const stuck = /Reading this tool result/i.test(body);
    if (mapboxTiles === 0) errors.push("no mapbox satellite tile requested");
    const label = `${sn}/${rn}`;
    if (errors.length || stuck || !ring || prose.length) {
      failures += 1;
      console.error(
        JSON.stringify({ variant: label, stuck, ring, errors, prose, bodyPreview: body }),
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
