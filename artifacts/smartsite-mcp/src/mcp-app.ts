/** P-91 Wave C — MCP App resource. I1/I5/I6. No fourteenth tool. */

export const APP_RESOURCE_URI = "ui://smartsite/app.html";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_HOST_TOOLS = [
  "create_screen",
  "list_screens",
  "get_smart_site",
] as const;

export const RAILS = [
  "situs",
  "zoning",
  "landUse",
  "flood",
  "drainage",
  "envelope",
] as const;

export type RailName = (typeof RAILS)[number];
export type CellState =
  | "present"
  | "absent-verified"
  | "unknown"
  | "refused"
  | "unread";

export type BoardRow = {
  query: string;
  parcelNodeId: string | null;
  resolution: "resolved" | "ambiguous" | "unresolved";
  rails: Record<RailName, CellState>;
};

export type OverlayRow = {
  id: string;
  state: string;
  label: string;
  reason?: string;
};

export type PanelModel = {
  kind: "board" | "parcel" | "empty";
  screenId?: string;
  rows: BoardRow[];
  parcelNodeId?: string;
  label?: string;
  overlays: OverlayRow[];
};

export function appMetaFor(name: string): { ui: { resourceUri: string } } | undefined {
  if ((APP_HOST_TOOLS as readonly string[]).includes(name)) {
    return { ui: { resourceUri: APP_RESOURCE_URI } };
  }
  return undefined;
}

export function glyphClass(state: CellState): string {
  return `g-${state}`;
}

export function looksLikeParcelNodeId(query: string): boolean {
  return /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(query.trim());
}

export function unresolvedCaption(query: string): "node unresolved" | "situs unresolved" {
  return looksLikeParcelNodeId(query) ? "node unresolved" : "situs unresolved";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function railState(value: unknown): CellState {
  if (value === "present") return "present";
  if (value === "absent-verified" || value === "absent") return "absent-verified";
  if (value === "refused") return "refused";
  if (value === "unread") return "unread";
  if (value === "unknown") return "unknown";
  return "unread";
}

function rowFromUnknown(raw: unknown): BoardRow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const query = typeof rec.query === "string" ? rec.query : "";
  const parcelNodeId =
    typeof rec.parcelNodeId === "string"
      ? rec.parcelNodeId
      : typeof rec.id === "string"
        ? rec.id
        : null;
  const resolution =
    rec.resolution === "resolved" ||
    rec.resolution === "ambiguous" ||
    rec.resolution === "unresolved"
      ? rec.resolution
      : parcelNodeId
        ? "resolved"
        : "unresolved";
  const stub = asRecord(rec.stub) ?? asRecord(rec.rails) ?? asRecord(rec.d);
  const rails = {} as Record<RailName, CellState>;
  for (const rail of RAILS) {
    rails[rail] = stub ? railState(stub[rail]) : "unread";
  }
  if (!query && !parcelNodeId) return null;
  return { query: query || parcelNodeId || "situs unresolved", parcelNodeId, resolution, rails };
}

function overlaysFromDraw(draw: Record<string, unknown>): OverlayRow[] {
  const overlays = Array.isArray(draw.overlays) ? draw.overlays : [];
  const rows: OverlayRow[] = [];
  for (const item of overlays) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === "string" ? rec.id : "";
    const state = typeof rec.state === "string" ? rec.state : "unknown";
    const label = typeof rec.label === "string" ? rec.label : id;
    const reason = typeof rec.reason === "string" ? rec.reason : undefined;
    if (!id) continue;
    rows.push({ id, state, label, reason });
  }
  return rows;
}

/**
 * Board source is a screen. Saved-list payloads (`list_my_properties`) are ignored
 * even if they appear in the same JSON.
 */
export function parseToolResult(text: string): PanelModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "empty", rows: [], overlays: [] };
  }
  const rec = asRecord(parsed);
  if (!rec) return { kind: "empty", rows: [], overlays: [] };
  if (Array.isArray(rec.savedProperties) && !rec.rows && !rec.screens) {
    return { kind: "empty", rows: [], overlays: [] };
  }

  const draw = asRecord(rec.draw);
  const firstParcel = Array.isArray(rec.parcels) ? asRecord(rec.parcels[0]) : null;
  const parcelDraw = draw ?? (firstParcel ? asRecord(firstParcel.draw) : null);
  if (parcelDraw && (parcelDraw.ring || parcelDraw.overlays || parcelDraw.label)) {
    const parcelNodeId =
      typeof rec.parcelNodeId === "string"
        ? rec.parcelNodeId
        : typeof firstParcel?.parcelNodeId === "string"
          ? firstParcel.parcelNodeId
          : undefined;
    const label =
      typeof parcelDraw.label === "string"
        ? parcelDraw.label
        : typeof rec.label === "string"
          ? rec.label
          : parcelNodeId;
    return {
      kind: "parcel",
      rows: [],
      overlays: overlaysFromDraw(parcelDraw),
      parcelNodeId,
      label,
    };
  }

  const screen = asRecord(rec.screen) ?? rec;
  const rawRows = Array.isArray(rec.rows)
    ? rec.rows
    : Array.isArray(screen.rows)
      ? screen.rows
      : Array.isArray(rec.screens)
        ? []
        : [];
  const rows: BoardRow[] = [];
  for (const raw of rawRows) {
    const row = rowFromUnknown(raw);
    if (row) rows.push(row);
  }
  if (rows.length > 0) {
    const screenId =
      typeof rec.id === "string"
        ? rec.id
        : typeof screen.id === "string"
          ? screen.id
          : undefined;
    return { kind: "board", screenId, rows, overlays: [] };
  }
  return { kind: "empty", rows: [], overlays: [] };
}

export function panelFingerprint(model: PanelModel): string {
  return JSON.stringify({
    kind: model.kind,
    screenId: model.screenId ?? null,
    rows: model.rows.map((row) => ({
      query: row.query,
      parcelNodeId: row.parcelNodeId,
      resolution: row.resolution,
      rails: row.rails,
    })),
    parcelNodeId: model.parcelNodeId ?? null,
    overlays: model.overlays.map((o) => ({ id: o.id, state: o.state, reason: o.reason ?? null })),
  });
}

export function listingHistoryMessage(model: PanelModel): string {
  const who = model.label || model.parcelNodeId || "this parcel";
  return `Find listing history for ${who}. Search the public web for prior sales, price cuts, and listing copy. Put the answer only in this transcript. Do not write it into the Smart Site board or parcel panel.`;
}

export function listingHistoryClick(model: PanelModel): {
  message: string;
  fingerprintBefore: string;
  fingerprintAfter: string;
} {
  const fingerprintBefore = panelFingerprint(model);
  return {
    message: listingHistoryMessage(model),
    fingerprintBefore,
    fingerprintAfter: panelFingerprint(model),
  };
}

const PRIVATE_ORIGIN = /localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+|192\.168\.|fonts\.googleapis|fonts\.gstatic/i;

export function htmlContractViolations(html: string): string[] {
  const violations: string[] = [];
  if (PRIVATE_ORIGIN.test(html)) {
    violations.push("private_or_font_origin");
  }
  if (!html.includes("g-unread") || !html.includes("g-unknown")) {
    violations.push("missing_unread_or_unknown_glyph");
  }
  if (html.includes("g-unread") && html.includes("g-unknown")) {
    const unread = html.indexOf(".g-unread");
    const unknown = html.indexOf(".g-unknown");
    if (unread < 0 || unknown < 0) violations.push("glyph_selectors_missing");
  }
  if (/coverage %|42\s*%/i.test(html) || /column totals?\s+\d/i.test(html)) {
    violations.push("aggregate_or_invented_pct");
  }
  if (/list_my_properties/.test(html) && /board source/.test(html) === false) {
    /* allowed only as a refused source note */
  }
  if (/fetch\(|XMLHttpRequest|WebSocket/.test(html)) {
    violations.push("direct_network");
  }
  if (/#F3F5F1|#F5F5F0|#EAEEE7/i.test(html)) {
    violations.push("cream_host_theme");
  }
  if (!html.includes('data-theme="claude"') || !html.includes("btn primary")) {
    violations.push("missing_claude_chrome");
  }
  return violations;
}

export function buildAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="claude">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart Site board</title>
<style>
:root{--bg:#1c1c1c;--card:#262626;--well:#111111;--line:#3d3d3d;--ink:#ececec;--muted:#9a9a9a;--key:#e8c36a;--val:#8fde5d;--present:#3d9b7a;--refused:#b08ad4;--unknown:#7a7a7a;--unread:#6a6a6a;--alert:#d08a7a}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
#root{padding:2px}
.card{border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}
.hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;color:var(--muted)}
.mark{width:12px;height:12px;border:1.5px solid var(--muted);border-radius:50%;position:relative;flex:0 0 12px}
.mark:after{content:"";position:absolute;inset:3px;border:1.5px solid var(--muted);border-radius:50%}
.well{margin:0 10px 10px;background:var(--well);border-radius:8px;padding:10px 12px}
.req{font-size:11px;color:var(--muted);margin:0 0 8px}
table{width:100%;border-collapse:collapse}
th{font:10px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;text-align:left;padding:0 6px 8px;border-bottom:1px solid var(--line);color:var(--muted);cursor:pointer}
td{padding:7px 6px;border-bottom:1px solid #2a2a2a;vertical-align:middle}
tr.row{cursor:pointer}
tr.row:hover td{background:#1a1a1a}
.pl{font-weight:500}
.pn,.unres,.why,.mono{font:12px/1.4 ui-monospace,Consolas,monospace}
.pn,.mono{color:var(--muted)}
.pn.lime,.val{color:var(--val)}
.key{color:var(--key)}
.unres{color:var(--alert)}
.g{width:12px;height:12px;display:inline-block;vertical-align:-1px;border:1.4px solid currentColor}
.g-present{background:var(--present);border-color:var(--present)}
.g-absent-verified{background:transparent;border-color:var(--muted)}
.g-unknown{background:repeating-linear-gradient(45deg,var(--unknown),var(--unknown) 2px,transparent 2px,transparent 4px);border-color:var(--unknown)}
.g-refused{background:transparent;border-style:dashed;border-color:var(--refused);background-image:linear-gradient(135deg,transparent 46%,var(--refused) 46%,var(--refused) 54%,transparent 54%)}
.g-unread{background:transparent;border:none;border-top:2px solid var(--unread);height:0;width:12px;vertical-align:4px}
.legend{display:flex;flex-wrap:wrap;gap:10px;padding:0 12px 10px;font:11px ui-monospace,Consolas,monospace;color:var(--muted)}
.ovl{padding:6px 0;border-bottom:1px solid #2a2a2a}
.ovl:last-child{border-bottom:none}
.ovl.refused .lbl{color:var(--refused);font-weight:600}
.why{display:block;color:var(--muted);margin-top:2px}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:0 10px 12px}
.btn{font:13px/1.2 ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);background:#2a2a2a;color:var(--ink);border-radius:8px;padding:7px 12px;cursor:pointer}
.btn.primary{background:#fff;color:#111;border-color:#fff}
.btn:hover{filter:brightness(1.08)}
.empty{color:var(--muted);padding:12px}
</style>
</head>
<body>
<div id="root"><p class="empty">Waiting for a screen or a parcel.</p></div>
<script>
(function(){
  var RAILS=["situs","zoning","landUse","flood","drainage","envelope"];
  var NODE_RE=/^\\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var model={kind:"empty",rows:[],overlays:[]};
  var sortKey="query";
  var sortDir=1;
  var host={
    sendMessage:function(text){
      parent.postMessage({jsonrpc:"2.0",method:"ui/message",params:{role:"user",content:[{type:"text",text:text}]}},"*");
    }
  };
  function fingerprint(m){
    return JSON.stringify({kind:m.kind,screenId:m.screenId||null,rows:m.rows,parcelNodeId:m.parcelNodeId||null,overlays:m.overlays});
  }
  function looksNode(q){return NODE_RE.test(String(q||"").trim())}
  function queryCell(r){
    if(r.resolution!=="unresolved") return '<div class="pl">'+esc(r.query)+"</div>";
    var cap=looksNode(r.query)?"node unresolved":"situs unresolved";
    var cls=looksNode(r.query)?"pn lime":"pn";
    return '<div class="unres">'+cap+'</div><div class="'+cls+'">'+esc(r.query)+"</div>";
  }
  function parse(text){
    var rec; try{rec=JSON.parse(text)}catch(e){return {kind:"empty",rows:[],overlays:[]}}
    if(!rec||typeof rec!=="object") return {kind:"empty",rows:[],overlays:[]};
    if(Array.isArray(rec.savedProperties)&&!rec.rows&&!rec.screens) return {kind:"empty",rows:[],overlays:[]};
    var draw=rec.draw||(rec.parcels&&rec.parcels[0]&&rec.parcels[0].draw);
    if(draw&&(draw.ring||draw.overlays||draw.label)){
      var overlays=[];
      (draw.overlays||[]).forEach(function(o){
        if(!o||!o.id) return;
        overlays.push({id:o.id,state:o.state||"unknown",label:o.label||o.id,reason:o.reason});
      });
      return {kind:"parcel",rows:[],overlays:overlays,parcelNodeId:rec.parcelNodeId||(rec.parcels&&rec.parcels[0]&&rec.parcels[0].parcelNodeId),label:draw.label||rec.label};
    }
    var raw=rec.rows||(rec.screen&&rec.screen.rows)||[];
    var rows=[];
    raw.forEach(function(r){
      if(!r) return;
      var rails={};
      var stub=r.stub||r.rails||r.d||{};
      RAILS.forEach(function(k){rails[k]=stub[k]||"unread"});
      rows.push({query:r.query||r.parcelNodeId||"situs unresolved",parcelNodeId:r.parcelNodeId||null,resolution:r.resolution||(r.parcelNodeId?"resolved":"unresolved"),rails:rails});
    });
    if(rows.length) return {kind:"board",screenId:rec.id||(rec.screen&&rec.screen.id),rows:rows,overlays:[]};
    return {kind:"empty",rows:[],overlays:[]};
  }
  function glyph(state){
    var cls="g g-"+(state==="absent"?"absent-verified":state);
    return '<span class="'+cls+'" title="'+state+'"></span>';
  }
  function render(){
    var root=document.getElementById("root");
    if(model.kind==="board"){
      var rows=model.rows.slice().sort(function(a,b){
        var av=sortKey==="query"?a.query:(a.parcelNodeId||"");
        var bv=sortKey==="query"?b.query:(b.parcelNodeId||"");
        return av<bv?-sortDir:av>bv?sortDir:0;
      });
      var head="<tr><th data-k=query>Query</th><th data-k=id>Node</th>"+RAILS.map(function(r){return "<th>"+r+"</th>"}).join("")+"</tr>";
      var body=rows.map(function(r,i){
        return '<tr class="row" data-i="'+i+'"><td>'+queryCell(r)+'</td><td class="pn lime">'+esc(r.parcelNodeId||"—")+"</td>"+RAILS.map(function(k){return "<td>"+glyph(r.rails[k])+"</td>"}).join("")+"</tr>";
      }).join("");
      root.innerHTML='<div class="card"><div class="hdr"><span class="mark"></span>Smart Site · screen board</div><div class="well"><div class="req">Rows</div><table><thead>'+head+"</thead><tbody>"+body+"</tbody></table></div>"+
        '<div class="legend"><span>'+glyph("present")+" present</span><span>"+glyph("absent-verified")+' absent, verified</span><span>'+glyph("unknown")+" unknown</span><span>"+glyph("refused")+" refused</span><span>"+glyph("unread")+" unread</span></div></div>";
      root.querySelectorAll("th[data-k]").forEach(function(th){
        th.addEventListener("click",function(){sortKey=th.getAttribute("data-k");sortDir*=-1;render();});
      });
      root.querySelectorAll("tr.row").forEach(function(tr){
        tr.addEventListener("click",function(){
          var r=rows[Number(tr.getAttribute("data-i"))];
          if(!r||!r.parcelNodeId) return;
          host.sendMessage("Open parcel "+r.parcelNodeId+" with get_smart_site depth node. Do not save it.");
        });
      });
    } else if(model.kind==="parcel"){
      var ov=model.overlays.map(function(o){
        var refused=o.state==="refused"?" refused":"";
        var why=o.reason?'<span class="why"><span class="key">reason</span> <span class="val">'+esc(o.reason)+"</span></span>":"";
        return '<div class="ovl'+refused+'">'+glyph(o.state==="refused"?"refused":o.state==="unread"?"unread":"present")+' <span class="key">'+esc(o.id)+'</span> <span class="lbl">'+esc(o.label)+"</span>"+why+"</div>";
      }).join("")||'<p class="empty">No overlays on this draw.</p>';
      root.innerHTML='<div class="card"><div class="hdr"><span class="mark"></span>Smart Site · '+esc(model.label||model.parcelNodeId||"parcel")+'</div><div class="well"><div class="req">Request</div>'+ov+"</div>"+
        '<div class="acts"><button type="button" class="btn" data-act="save">Save property</button><button type="button" class="btn primary" data-act="listing">Find listing history</button></div></div>';
    } else {
      root.innerHTML='<div class="card"><div class="hdr"><span class="mark"></span>Smart Site · waiting</div><p class="empty">Waiting for a screen or a parcel.</p></div>';
    }
    var listing=root.querySelector('[data-act="listing"]');
    if(listing){
      listing.addEventListener("click",function(){
        var before=fingerprint(model);
        host.sendMessage("Find listing history for "+(model.label||model.parcelNodeId||"this parcel")+". Search the public web. Put the answer only in this transcript. Do not write it into the Smart Site board or parcel panel.");
        if(fingerprint(model)!==before) throw new Error("i5_panel_mutated");
      });
    }
    var save=root.querySelector('[data-act="save"]');
    if(save&&model.parcelNodeId){
      save.addEventListener("click",function(){
        host.sendMessage("Save property "+model.parcelNodeId+" with save_property. Do not change any screen.");
      });
    }
  }
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
  function accept(result){
    var text="";
    if(result&&Array.isArray(result.content)&&result.content[0]&&result.content[0].text) text=result.content[0].text;
    else if(typeof result==="string") text=result;
    model=parse(text);
    render();
  }
  window.addEventListener("message",function(ev){
    var d=ev.data;
    if(!d) return;
    if(d.method==="ui/notifications/tool-result"&&d.params) accept(d.params);
    if(d.result&&d.result.content) accept(d.result);
  });
  parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{appInfo:{name:"SmartSiteBoard",version:"1"},appCapabilities:{}}},"*");
  parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
})();
</script>
</body>
</html>`;
}

export function registerMcpApp(server: {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
        _meta?: Record<string, unknown>;
      }>;
    }>,
  ) => void;
  resource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => void;
}): void {
  const handler = async (uri: { href: string }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: APP_MIME,
        text: buildAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      },
    ],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
    return;
  }
  if (typeof server.resource === "function") {
    server.resource("Smart Site board", APP_RESOURCE_URI, { mimeType: APP_MIME }, handler);
  }
}
