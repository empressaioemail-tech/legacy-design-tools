/**
 * Render real get_smart_site records in the page printed by the production artifact.
 * Usage: node render-records.mjs <app.html> <out-dir> <record.json>...
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { customerProseViolations } from "./prose-violations.mjs";

const [htmlPath, outDir, ...recordPaths] = process.argv.slice(2);
if (!htmlPath || !outDir || recordPaths.length === 0) {
  console.error("usage: node render-records.mjs <app.html> <out-dir> <record.json>...");
  process.exit(2);
}
const app = fs.readFileSync(htmlPath, "utf8");
fs.mkdirSync(outDir, { recursive: true });

function hostPage(record) {
  const result = {
    content: [
      { type: "resource_link", uri: "ui://smartsite/app-p562.html", name: "Smart Site board" },
      { type: "text", text: JSON.stringify(record) },
    ],
  };
  const params = JSON.stringify(result).split("</").join("<\\/");
  return `<!doctype html><html><body style="margin:0;background:#1f1f1f">
<iframe id="f" sandbox="allow-scripts allow-same-origin" style="width:760px;height:900px;border:0"></iframe>
<script>
const f=document.getElementById('f');
window.addEventListener('message',(e)=>{
  if(e.source!==f.contentWindow) return;
  const m=e.data;
  if(m&&m.method==='ui/initialize'&&m.id!=null){
    f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'harness',version:'0'},hostCapabilities:{},hostContext:{theme:'dark',displayMode:'inline'}}},'*');
  }
  if(m&&m.method==='ui/notifications/initialized'){
    f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-call',params:{toolName:'get_smart_site'}},'*');
    f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${params}},'*');
  }
});
f.srcdoc=${JSON.stringify(app).split("</").join("<\\/")};
</script></body></html>`;
}

function resolveChromeExecutable() {
  if (process.env.CHROME_PATH?.trim()) return process.env.CHROME_PATH.trim();
  try {
    const fromPlaywright = chromium.executablePath();
    if (fromPlaywright && fs.existsSync(fromPlaywright)) return fromPlaywright;
  } catch { /* not installed */ }
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
  if (local && fs.existsSync(local)) return local;
  return undefined;
}

const exe = resolveChromeExecutable();
if (!exe) {
  console.error("chromium missing");
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
const summary = [];
for (const recordPath of recordPaths) {
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const id = String(record.parcelNodeId || "parcel").replace(/[:\\/]/g, "-");
  const page = await browser.newPage({ viewport: { width: 800, height: 980 } });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (/smartsite\.cloud/i.test(url)) return route.abort();
    return route.continue();
  });
  await page.setContent(hostPage(record));
  await page.waitForTimeout(4000);
  const frame = page.frames().find((fr) => fr !== page.mainFrame());
  const text = frame ? await frame.evaluate(() => document.body.innerText) : "";
  const prose = customerProseViolations(text, record.parcelNodeId || "");
  const png = path.join(outDir, `${id}.png`);
  const txt = path.join(outDir, `${id}.txt`);
  if (frame) await frame.locator("body").screenshot({ path: png });
  fs.writeFileSync(txt, text, "utf8");
  summary.push({ id: record.parcelNodeId, prose: prose.length, kinds: [...new Set(prose.map((v) => v.kind))], png, txt });
  await page.close();
}
await browser.close();
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.some((s) => s.prose > 0) ? 1 : 0);
