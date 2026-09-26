/** P-456c. Browser entry. Imports helpers; data vars are script globals from buildAppHtml. */
import {
  envelopeHumanReason,
  customerBriefReasonInline,
  singleGroundNoteHtml,
  asRecord,
  railState,
  numberOrNull,
  stringOrNull,
  stringList,
  emptyModel,
  countyForNodeId,
  notOnFileSentence,
  noBakedSnapshotSentence,
  retiredRecordSentence,
  escapeHtml,
  rowFromUnknown,
  ringFromDraw,
  edgesFromDraw,
  overlaysFromDraw,
  batchRowsFrom,
  missRowsFrom,
  refusedRowsFrom,
  parseToolResult,
  firstTextPart,
  firstJsonObjectTextPart,
  parseToolContent,
  zoningCitationUrl,
  zoningFromDraw,
  frameFromDraw,
  edgeCaption,
  edgeIndex,
  edgeHasRoad,
  edgeEnds,
  edgeWord,
  edgeIsRow,
  edgeDoor,
  edgeTipHtml,
  zoneFamily,
  floodTint,
  floodZoneLabel,
  floodOverlayOf,
  scaleBarFt,
  ringFit,
  ringPixel,
  ringSvg,
  frameNoteHtml,
  anchorReadFrom,
  anchorFrom,
  groundMetresPerPixel,
  groundPixelsPerFoot,
  groundWorldPixel,
  groundTileUrl,
  groundZoomFor,
  groundVbFromWorld,
  groundPlan,
  groundPct,
  groundLayerHtml,
  groundNoteHtml,
  groundWrapHtml,
  anchorBatchFrom,
  parcelsFromBatch,
  anchorReadWords,
  undrawnReason,
  multiDrawableCount,
  multiGroundReasonWords,
  multiParcelPlan,
  resolveLabelPositions,
  multiCanvasSvg,
  multiDrawnHtml,
  multiUndrawnHtml,
  multiGroundNoteHtml,
  anchorBatchNoteHtml,
  renderParcelSet,
  multiNoCanvasWords,
  multiNoCanvasNoteHtml,
  offCanvasParcels,
  offCanvasHtml,
  previewLine,
  previewRailsHtml,
  previewBlockHtml,
  previewRowFrom,
  glyphClass,
  knownVintage,
  httpsCitations,
  overlayPaint,
  refusalFrom,
  sectionPaint,
  sourceOf,
  dateOnly,
  stateWord,
  citationHtml,
  whyControlHtml,
  reasonLineHtml,
  metaHtml,
  overlayRowHtml,
  floodFactsHtml,
  reportHtml,
  saveChooserHtml,
  pairedSection,
  whyQuestion,
  whyMessage,
  saveMessage,
  addToScreenMessage,
  sectionsFromBrief,
  looksLikeParcelNodeId,
  unresolvedCaption,
  stubReadOf,
  candidatesFrom,
  degradedFrom,
  screensFrom,
  declaredFrom,
  countyFipsOf,
  boardGroups,
  knownRank,
  sortBoardRows,
  useCandidateMessage,
  lookupMessage,
  reopenScreenMessage,
  candidateFor,
  lookupRowFor,
  screenSummaryFor,
  candidateControlsHtml,
  lookupControlHtml,
  stubReadNoteHtml,
  boardRowPrimaryLabel,
  boardQueryCellHtml,
  boardCardTitle,
  parcelCardTitle,
  parcelFactSubheadHtml,
  reportHtmlPartialDefault,
  loadingPanelSubtitle,
  degradedNotesHtml,
  screensListHtml,
  declaredLineHtml,
  mapCardOutcomeFromModel,
  EMPTY_BOARD_BODY,
  EMPTY_BOARD_TITLE,
  LISTING_ACK_LABEL,
  LISTING_TURN_INSTRUCTION,
  LISTING_TURN_OPENER,
  LOADING_PANEL_TITLE,
  NOTHING_TO_OPEN,
  OPEN_DEAD_MS,
  OPEN_DID_NOT_REACH_ME,
  OPEN_SENT,
  OPEN_TURN_INSTRUCTION,
  OPEN_TURN_OPENER,
  UPGRADE_TO_OPEN,
} from "./panel-lib.js";
import { answerFirstCarouselHtml, answerFirstSingleHtml, loadingSkeletonHtml } from "./answer-first-html.js";
import { detailHtml } from "./detail-html.js";

declare const __SS_CARD_DATA__: {
  probeNet: Array<{ key: string; url: string }>;
  probeUri: string;
  mapRenderReportUrl: string;
};

(function(){
  var showDebug=/[?&]debug=1(?:&|$)/.test(typeof location!=="undefined"&&location.search?location.search:"");
  if(showDebug&&document.documentElement){document.documentElement.setAttribute("data-debug","1");}
  var boot=document.getElementById("boot");
  var handshake="off";
  var capText="caps=unread";
  var msgCap="message=unread";
  var replyText="reply=none";
  var foreignCount=0;
  var netText="net=unread";
  var glText="gl=unread";
  var bridgeText="bridge=unread";
  /* M-5 item 3: the fourth channel. p559 measured net, gl and resources/read;
   * an app initiated tools/call is a DIFFERENT method and was never measured.
   * This token says what happened to one: unread until a door dwell fires one
   * (the panel makes no unrequested tool call), then pending, then ok, err<code>
   * or timeout; unsupported the moment the handshake settles without serverTools. */
  var toolsText="tools=unread";
  var pendingMsg=Object.create(null);
  function paintBoot(){
    if(!boot) return;
    boot.setAttribute("data-script","ran");
    boot.setAttribute("data-handshake",handshake);
    boot.setAttribute("data-caps",capText);
    boot.setAttribute("data-message-cap",msgCap);
    boot.setAttribute("data-reply",replyText);
    boot.setAttribute("data-foreign",String(foreignCount));
    boot.setAttribute("data-net",netText.slice(4));
    boot.setAttribute("data-gl",glText.slice(3));
    boot.setAttribute("data-bridge",bridgeText.slice(7));
    boot.setAttribute("data-tools",toolsText.slice(6));
    boot.textContent=["script-ran","handshake="+handshake,capText,msgCap,replyText,"foreign="+foreignCount,netText,glText,bridgeText,toolsText].join(" ");
  }
  paintBoot();
  window.__SS_M=(window.__SS_M||"")+"/*P559_PROBE_BEGIN*/";
  /* p559 probe. gl: synchronous context check. net: per-origin fetch, cors then no-cors
   * (ok<status> = reachable with CORS; opq = reachable, no CORS; blk = blocked; to = timeout).
   * bridge: resources/read through the host rpc once the handshake is ready. */
  try{
    var glc=document.createElement("canvas");
    glText=glc.getContext("webgl2")?"gl=webgl2":(glc.getContext("webgl")||glc.getContext("experimental-webgl"))?"gl=webgl1":"gl=none";
  }catch(eGl){glText="gl=err"}
  paintBoot();
  var PROBE_NET=__SS_CARD_DATA__.probeNet;

  var netParts=Object.create(null);
  var probeIds=Object.create(null);
  var bridgeTimer=null;
  function paintNet(){
    var out=[];
    for(var ni=0;ni<PROBE_NET.length;ni++){var nk=PROBE_NET[ni].key;out.push(nk+":"+(netParts[nk]||"pending"))}
    netText="net="+out.join(",");
    paintBoot();
  }
  function probeOne(t){
    netParts[t.key]="pending";
    var done=false;
    var timer=setTimeout(function(){if(!done){done=true;netParts[t.key]="to";paintNet();}},6000);
    function finish(v){if(done)return;done=true;clearTimeout(timer);netParts[t.key]=v;paintNet();}
    try{
      fetch(t.url,{mode:"cors"}).then(function(r){finish("ok"+r.status)},function(){
        try{
          fetch(t.url,{mode:"no-cors"}).then(function(){finish("opq")},function(){finish("blk")});
        }catch(eNc){finish("blk")}
      });
    }catch(eF){finish("blk")}
  }
  function startNetProbe(){
    if(typeof fetch!=="function"){netText="net=nofetch";paintBoot();return;}
    for(var pi=0;pi<PROBE_NET.length;pi++) probeOne(PROBE_NET[pi]);
    paintNet();
  }
  function startBridgeProbe(){
    if(bridgeText!=="bridge=unread") return;
    bridgeText="bridge=pending";
    var bid=rpcId++;
    probeIds[bid]=1;probeIds[String(bid)]=1;
    bridgeTimer=setTimeout(function(){bridgeText="bridge=timeout";paintBoot();},6000);
    parent.postMessage({jsonrpc:"2.0",id:bid,method:"resources/read",params:{uri:__SS_CARD_DATA__.probeUri}},"*");
    paintBoot();
  }
  startNetProbe();
  window.__SS_M=(window.__SS_M||"")+"/*P559_PROBE_END*/";

  var NODE_RE=/^\\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;

















































  /* M-2 aerial ground. The served scope gets the same constants the tested
   * helpers read, so the tile url and the CSP origin cannot drift apart. */












  /* M-4 multi parcel canvas. Same rule as the ground constants above: the served
   * scope reads the constants the tested helpers read, so the cap, the extent
   * threshold and every sentence have one source. */




















  /* M-5 off canvas naming and the paint only preview. Same rule again: the
   * served scope reads the constants the tested helpers read. */






  var MAP_RENDER_REPORT_URL=__SS_CARD_DATA__.mapRenderReportUrl;













  /* P-437 loadingPanelSubtitle (INLINE_SHARED) reads these; inject or the tool-call path throws. */


  var esc=escapeHtml;
  var model=emptyModel("empty");
  var hasToolResult=false;
  var openWait=null;
  var openFail=null;
  var openSent=null;
  var openTimer=null;
  function clearOpenTimer(){ if(openTimer){ clearTimeout(openTimer); openTimer=null; } }
  var sortKey="completeness";
  var sortDir=1;
  var listingAck=null;
  var hotEl=null;
  var pinnedEl=null;
  /* R1: local view state (I8). Reset on every accepted result; never read from anywhere. */
  var reportOpen=false;
  var pendingToolName=null;
  /* M-2: local view state, same rule. On whenever a ground exists; the toggle turns it off. */
  var groundOn=true;
  var deepView=false;
  var openTile=-1;
  var openRow=-1;
  var sheetHigh=false;
  var floodOn=true;
  var envelopeOn=true;
  var linesOn=true;
  var rpcId=1;
  var initId=rpcId++;
  var ready=false;
  var pending=[];
  function markHandshake(state){
    handshake=state;
    paintBoot();
  }
  function summarizeCaps(result){
    var hc=result&&result.hostCapabilities;
    if(!hc||typeof hc!=="object"){
      capText="caps=none";
      msgCap="message=none";
      return;
    }
    /* M-5: the ONE place the preview channel's precondition is read. Absent,
     * null or false is not a capability; only a declared serverTools is. */
    serverToolsCap=hc.serverTools!=null&&hc.serverTools!==false;
    var keys=[];
    for(var k in hc){if(Object.prototype.hasOwnProperty.call(hc,k)&&k!=="message") keys.push(k)}
    capText="caps="+(keys.length?keys.join(","):"empty");
    if(hc.message==null){
      msgCap="message=none";
    } else if(hc.message===true){
      msgCap="message=yes";
    } else if(typeof hc.message==="object"){
      var mods=[];
      for(var m in hc.message){if(hc.message[m]) mods.push(m)}
      msgCap="message="+(mods.length?mods.join(","):"yes");
    } else {
      msgCap="message="+String(hc.message);
    }
  }
  function postMessage(text){
    var id=rpcId++;
    pendingMsg[id]=1;
    pendingMsg[String(id)]=1;
    postUserMessage(id,text);
  }
  function flushReady(){
    if(ready) return;
    ready=true;
    parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
    while(pending.length) postMessage(pending.shift());
    if(handshake==="ready"){ startBridgeProbe(); }
    else { bridgeText="bridge=nohost"; paintBoot(); }
    /* M-5: one place decides the negative case, so a handshake that errored, a
     * handshake that timed out and a host that simply does not advertise
     * serverTools all report the same measured word. Never left at unread. */
    if(!serverToolsCap){ toolsText="tools=unsupported"; paintBoot(); }
  }
  var host={
    sendMessage:function(text){
      if(!ready){pending.push(text);return;}
      postMessage(text);
    }
  };
  function listingHistoryMessage(m){
    var who=m.label||m.parcelNodeId||"this parcel";
    return LISTING_TURN_OPENER+" "+who+". "+LISTING_TURN_INSTRUCTION;
  }
  function openParcelMessage(node){
    return OPEN_TURN_OPENER+" "+node+". "+OPEN_TURN_INSTRUCTION;
  }
  function openLink(url){
    if(!url) return;
    parent.postMessage({jsonrpc:"2.0",id:rpcId++,method:"ui/open-link",params:{url:url}},"*");
  }
  /* M-5 paint only preview channel. Bounds, all four stated in the module doc:
   * one dwell before any call, one call in flight at a time, one call per
   * neighbour per panel instance (previewState[node] is set the moment a call
   * is issued and never cleared except by accept()), and one timeout after
   * which the tooltip says the call went unanswered. No state below is ever an
   * argument to a turn; the Open and Add to screen controls are untouched. */
  var serverToolsCap=false;
  var previewState=Object.create(null);
  var previewCode=Object.create(null);
  var previewRow=Object.create(null);
  var previewIds=Object.create(null);
  var previewInFlight=null;
  var previewBusyFor=null;
  var previewDwell=null;
  var previewWait=null;
  var previewNode=null;
  var previewEl=null;
  function toolsSeen(word){
    toolsText="tools="+word;
    paintBoot();
  }
  /* null means no block at all. A tooltip with no preview claims nothing; an
   * empty block would claim the neighbour has nothing. */
  function previewStateOf(node){
    var s=previewState[node];
    if(s!==undefined) return s;
    if(previewBusyFor===node) return "busy";
    return null;
  }
  function previewBlockFor(node){
    if(!node) return "";
    var s=previewStateOf(node);
    if(s===null) return "";
    return previewBlockHtml(node,s,s==="ok"?(previewRow[node]||null):null,previewCode[node]||null);
  }
  function cancelPreviewDwell(){
    if(previewDwell){clearTimeout(previewDwell);previewDwell=null;}
  }
  function repaintTip(){
    if(previewEl) showEdge(previewEl);
  }
  function armPreviewDwell(node){
    cancelPreviewDwell();
    previewDwell=setTimeout(function(){previewDwell=null;firePreview(node);},PREVIEW_DWELL_MS);
  }
  /* A door that waited out a busy window gets its dwell back once the channel
   * is free, but only while the pointer is still on it. */
  function releasePreviewBusy(){
    if(previewBusyFor===null) return;
    var n=previewBusyFor;
    previewBusyFor=null;
    if(previewNode===n&&previewState[n]===undefined) armPreviewDwell(n);
  }
  function firePreview(node){
    if(!node) return;
    if(previewState[node]!==undefined) return;
    if(!serverToolsCap){previewState[node]="unsupported";toolsSeen("unsupported");repaintTip();return;}
    if(previewInFlight){previewBusyFor=node;repaintTip();return;}
    previewState[node]="pending";
    previewInFlight=node;
    var pid=rpcId++;
    previewIds[pid]=node;
    previewIds[String(pid)]=node;
    toolsSeen("pending");
    previewWait=setTimeout(function(){
      previewWait=null;
      if(previewInFlight!==node) return;
      previewInFlight=null;
      previewState[node]="timeout";
      toolsSeen("timeout");
      releasePreviewBusy();
      repaintTip();
    },PREVIEW_TIMEOUT_MS);
    sendToolsCall(pid,node);
    repaintTip();
  }
  window.__SS_M=(window.__SS_M||"")+"/*P561_TOOLS_BEGIN*/";
  /* The ONE app initiated tool call in this page. It is postMessage, not fetch,
   * so this block is deliberately NOT exempted from the direct_network rule the
   * way the p559 net probe is; the markers exist so the contract can prove there
   * is exactly one tools/call site and that it is this one. The reply is routed
   * by id in the message listener and never reaches accept(), so a preview can
   * neither repaint the panel nor enter the conversation. */
  function sendToolsCall(pid,node){
    parent.postMessage({jsonrpc:"2.0",id:pid,method:"tools/call",params:{name:PREVIEW_TOOL,arguments:{parcelNodeId:[node],depth:PREVIEW_DEPTH}}},"*");
  }
  window.__SS_M=(window.__SS_M||"")+"/*P561_TOOLS_END*/";
  function tipEl(){
    var root=document.getElementById("root");
    return root&&typeof root.querySelector==="function"?root.querySelector("[data-tip]"):null;
  }
  function showEdge(n){
    var idx=Number(n.getAttribute("data-edge"));
    var e=model.edges&&model.edges[idx];
    if(!e) return;
    if(hotEl&&hotEl!==n) hotEl.setAttribute("class","edge");
    n.setAttribute("class","edge hot");
    hotEl=n;
    /* M-5: only a door carries a preview. The dwell is cancelled unconditionally
     * first, so moving from one door to another cannot leave the first door's
     * timer armed and starve the second. */
    var door=edgeDoor(e);
    cancelPreviewDwell();
    previewNode=door;
    previewEl=door?n:null;
    /* Arming is not the bound. This decides only whether the line is a door;
     * firePreview is the ONE place that decides whether a call happens, so the
     * once per neighbour rule has a single enforcement site rather than two,
     * one of which no fixture could reach. */
    if(door) armPreviewDwell(door);
    var tip=tipEl();
    if(tip){ tip.innerHTML=edgeTipHtml(e,idx)+previewBlockFor(door); tip.setAttribute("data-edge-shown",String(idx)); }
  }
  function clearEdge(){
    if(hotEl) hotEl.setAttribute("class","edge");
    hotEl=null;
    cancelPreviewDwell();
    previewNode=null;
    previewEl=null;
    var tip=tipEl();
    if(tip){ tip.innerHTML=EDGE_TIP_HINT; tip.setAttribute("data-edge-shown","none"); }
  }
  function edgeEnter(n){ showEdge(n); }
  function edgeLeave(n){
    if(pinnedEl){ if(pinnedEl!==n) showEdge(pinnedEl); return; }
    clearEdge();
  }
  function edgeToggle(n){
    if(pinnedEl===n){ pinnedEl=null; clearEdge(); return; }
    pinnedEl=n;
    showEdge(n);
  }
  function bindDrawing(){
    hotEl=null;
    pinnedEl=null;
    var root=document.getElementById("root");
    if(!root||typeof root.querySelectorAll!=="function") return;
    var lines=root.querySelectorAll("[data-edge]");
    for(var i=0;i<lines.length;i++){
      (function(n){
        n.addEventListener("pointerenter",function(){ edgeEnter(n); });
        n.addEventListener("pointerleave",function(){ edgeLeave(n); });
        n.addEventListener("pointerdown",function(){ edgeToggle(n); });
      })(lines[i]);
    }
    var links=root.querySelectorAll("[data-zoning-url]");
    for(var k=0;k<links.length;k++){
      (function(n){ n.addEventListener("click",function(){ openLink(n.getAttribute("data-zoning-url")); }); })(links[k]);
    }
  }
  function fingerprint(m){
    return JSON.stringify({kind:m.kind,screenId:m.screenId||null,rows:m.rows,parcelNodeId:m.parcelNodeId||null,overlays:m.overlays,ring:m.ring||[],edges:(m.edges||[]).map(edgeCaption)});
  }
  function looksNode(q){return NODE_RE.test(String(q||"").trim())}
  /* B1 B2: a resolved row carries its read state; an ambiguous row keeps the typed query and offers its candidates; an unresolved row stays as typed */
  function queryCell(r){ return boardQueryCellHtml(r); }
  function glyph(state){
    var s=railState(state);
    return '<span class="g g-'+esc(s)+'" title="'+esc(s)+'"></span>';
  }
  function idLine(id){ return '<span class="pn atom">'+esc(id)+"</span>"; }
  function reasonLine(reason){ return '<span class="why"><span class="key">reason</span> <span class="reason">'+esc(reason)+"</span></span>"; }
  function missLine(m){
    if(m.missClass==="absent") return '<p class="miss"><b>'+esc(notOnFileSentence(m.parcelNodeId))+"</b>"+idLine(m.parcelNodeId)+"</p>";
    if(m.missClass==="unbaked") return '<p class="miss"><b>'+esc(noBakedSnapshotSentence(m.parcelNodeId))+"</b>"+idLine(m.parcelNodeId)+"</p>";
    if(m.missClass==="retired") return '<p class="miss miss-retired"><b>'+esc(retiredRecordSentence(m.parcelNodeId,m.retiredAsOf))+"</b>"+idLine(m.parcelNodeId)+"</p>";
    return '<p class="miss"><b>'+NOT_RETURNED+"</b>"+idLine(m.parcelNodeId)+reasonLine(m.reason)+"</p>";
  }
  function refusedLine(r){
    if(r.reason==="upgrade_required") return '<p class="miss"><b>'+UPGRADE_TO_OPEN+"</b>"+idLine(r.parcelNodeId)+"</p>";
    return '<p class="miss"><b>'+OPEN_REFUSED+"</b>"+idLine(r.parcelNodeId)+reasonLine(r.reason)+"</p>";
  }
  function stateLines(){
    return (openFail?'<p class="fail">'+esc(openFail)+"</p>":"")+(openSent?'<p class="note">'+OPEN_SENT+"</p>":"");
  }
  function card(title,inner,fit,extra){
    var diag=showDebug?' <span data-script="ran" class="diag">script-ran</span>':"";
    var cls=(fit?"card af-fit":"card")+(extra?" "+extra:"");
    if(extra==="ss-board"){
      var brand='<span class="ss-brand" data-wordmark="1"><span class="ss-smart">SMART</span> <span class="ss-site">SITE</span></span> ';
      return '<div class="'+cls+'"><div class="hdr">'+brand+title+diag+"</div>"+inner+"</div>";
    }
    return '<div class="'+cls+'"><div class="hdr"><span class="mark"></span>Smart Site · '+title+diag+"</div>"+inner+"</div>";
  }
  function cardV2(inner,clip){
    var hidden=clip?'<span class="ss-clip" aria-hidden="true">'+esc(clip)+"</span>":"";
    return '<div class="card af-fit ss-v2">'+inner+hidden+"</div>";
  }
  function render(){
    var root=document.getElementById("root");
    if(deepView&&model.kind==="parcel"){
      root.innerHTML=cardV2(stateLines()+detailHtml(model,{groundOn:groundOn,floodOn:floodOn,envelopeOn:envelopeOn,linesOn:linesOn,sheet:sheetHigh?"high":"low"}));
      bindDrawing();
    } else if(model.inlineCard&&model.inlineCard.layout==="carousel"&&model.kind==="parcels"){
      root.innerHTML=cardV2(stateLines()+answerFirstCarouselHtml(model));
    } else if(model.inlineCard&&model.inlineCard.layout==="single"&&model.kind==="parcel"){
      root.innerHTML=cardV2(stateLines()+answerFirstSingleHtml(model),model.parcelNodeId||"");
      bindDrawing();
    } else if(model.kind==="board"){
      /* B4 B5: groups by county prefix when there is more than one; each group in the local sort order; Open only on a resolved row */
      var grouping=boardGroups(model.rows);
      var head='<tr><th data-k="query">Address</th><th data-k="id" class="idcol">Parcel</th>'+RAILS.map(function(r){return "<th>"+r+"</th>"}).join("")+"<th></th></tr>";
      var pos=0;
      var body=grouping.groups.map(function(grp){
        var hdr=grouping.grouped?'<tr class="grp" data-county-group="'+esc(grp.fips||"unresolved")+'"><th colspan="'+(RAILS.length+3)+'">'+esc(grp.title)+"</th></tr>":"";
        return hdr+sortBoardRows(grp.rows,sortKey,sortDir).map(function(r){
        var i=pos++;
        var open=r.parcelNodeId&&r.resolution==="resolved"
          ?'<button type="button" class="btn" data-act="open" data-node="'+esc(r.parcelNodeId)+'" onclick="window.__ss&&window.__ss.open(this)">Open</button>'
          :'<div class="slot">'+NOTHING_TO_OPEN+"</div>"+lookupControlHtml(r);
        return '<tr class="row" data-i="'+i+'"><td>'+queryCell(r)+'</td><td class="pn atom idcol">'+esc(r.parcelNodeId||"—")+"</td>"+RAILS.map(function(k){
          var g=glyph(r.rails[k]);
          var ask=r.parcelNodeId?whyControlHtml("rail",railState(r.rails[k]),{rail:k,node:r.parcelNodeId},g):"";
          return "<td>"+(ask||g)+"</td>";
        }).join("")+"<td>"+open+"</td></tr>";
        }).join("");
      }).join("");
      var note=model.stubsDegraded===true?'<p class="note">'+RAILS_PARTLY_UNREAD+"</p>":"";
      var boardShare=model.inlineCard&&model.inlineCard.shareUrl?'<button type="button" class="btn" data-act="share" data-url="'+esc(model.inlineCard.shareUrl)+'" onclick="window.__ss&&window.__ss.share(this)">Share</button>':"";
      root.innerHTML=card(esc(boardCardTitle(model.screenName)),stateLines()+'<div class="well"><div class="req">Rows <span class="sortc" data-k="completeness" data-sort-active="'+(sortKey==="completeness"?"1":"0")+'">'+SORT_COMPLETENESS_LABEL+'</span></div><table data-sort="'+esc(sortKey)+'" data-dir="'+sortDir+'"><thead>'+head+"</thead><tbody>"+body+"</tbody></table>"+degradedNotesHtml(model.degraded||null)+"</div>"+note+
        '<div class="legend"><span>'+glyph("present")+" present</span><span>"+glyph("absent-verified")+' absent, verified</span><span>'+glyph("unknown")+" unknown</span><span>"+glyph("refused")+" refused</span><span>"+glyph("unread")+" unread</span></div>"+
        '<div class="af-acts"><button type="button" class="btn primary" data-act="board" onclick="window.__ss&&window.__ss.expand(this)">Open board</button>'+boardShare+"</div>",false,"ss-board");
    } else if(model.kind==="parcel"){
      var ov=model.overlays.map(function(o,i){return overlayRowHtml(o,i)}).join("")||'<p class="empty">No overlays on this draw.</p>';
      var node=model.parcelNodeId?'<div class="pn atom">'+esc(model.parcelNodeId)+"</div>":"";
      var flood=floodOverlayOf(model.overlays);
      var secs=model.sections||[];
      var floodSection=null;
      for(var fi0=0;fi0<secs.length;fi0++){ if(secs[fi0].id==="flood"){ floodSection=secs[fi0]; break; } }
      var floodMethod=floodSection&&floodSection.data?floodSection.data.method:null;
      var envelope=null;
      for(var ei=0;ei<model.overlays.length;ei++){
        var eo=model.overlays[ei];
        if(eo.id==="envelope"&&eo.geom&&eo.geom.length>=3){ envelope=eo; break; }
      }
      var svg=ringSvg(model.ring||[],model.edges||[],{zoning:model.zoning||null,flood:flood,frame:model.frame||null,envelope:envelope?envelope.geom:null,floodMethod:floodMethod});
      /* M-2: same helpers the exported twin uses; a null plan returns svg untouched */
      var gOutcome=groundPlan(model.ring||[],model.anchor||null,model.anchorRead||null);
      var drawn=groundWrapHtml(svg,gOutcome.plan,groundOn);
      if(envelope){
        drawn+='<div class="envnote" data-envelope-disclosure="1">'+esc(envelope.basisDisplayText||"Modelled from the setback table on record. The area is not stated.")+"</div>";
      }
      if(!gOutcome.plan&&gOutcome.reason){ drawn+=singleGroundNoteHtml(gOutcome.reason); }
      var tip=svg?'<div class="tip" data-tip="1">'+EDGE_TIP_HINT+"</div>"+frameNoteHtml(model.frame||null):"";
      var edgeList=(model.edges&&model.edges.length)?'<ul class="edges">'+model.edges.map(function(e){return "<li>"+esc(edgeCaption(e))+"</li>"}).join("")+"</ul>":"";
      var floodFacts="";
      for(var fi=0;fi<secs.length;fi++){ if(secs[fi].id==="flood"){ floodFacts=floodFactsHtml(secs[fi],fi,flood?flood.sfha:undefined); break; } }
      var subhead=parcelFactSubheadHtml(secs);
      var report=reportHtmlPartialDefault(secs,reportOpen);
      /* M-5: what this panel did NOT draw, whenever the result carried more than
       * one parcel. Not conditional on a canvas: the canvas is exactly what this
       * branch does not have. */
      root.innerHTML=card(esc(parcelCardTitle(model)),stateLines()+'<div class="well">'+subhead+node+drawn+tip+edgeList+ov+floodFacts+report+offCanvasHtml(model)+"</div>"+
        '<div class="acts">'+saveChooserHtml()+'<button type="button" class="btn'+(reportOpen?" on":"")+'" data-act="report" data-report-open="'+(reportOpen?"1":"0")+'" onclick="window.__ss&&window.__ss.report()">'+REPORT_TOGGLE+'</button><button type="button" class="btn primary" data-act="listing" onclick="window.__ss&&window.__ss.listing(this)">Find listing history</button></div>'+(listingAck?'<div class="ack" data-listing-chars="'+esc(listingAck.chars)+'">Posted '+esc(listingAck.chars)+" chars</div>":""));
      var listing=root.querySelector('[data-act="listing"]');
      if(listing&&listingAck){
        listing.textContent=LISTING_ACK_LABEL;
        listing.disabled=true;
        listing.setAttribute("data-listing-ack","1");
        listing.setAttribute("data-listing-chars",String(listingAck.chars));
      }
      bindDrawing();
    } else if(model.kind==="parcels"){
      /* M-4: the same helpers the exported twin uses. A set that cannot make a
       * canvas never reaches here: the parser hands it back as a single parcel. */
      root.innerHTML=card(MULTI_CARD_TITLE,stateLines()+'<div class="well">'+renderParcelSet(model,groundOn)+"</div>");
    } else if(model.kind==="miss"){
      root.innerHTML=card("lookup",'<div class="well">'+(model.misses||[]).map(missLine).join("")+"</div>");
    } else if(model.kind==="refused"){
      root.innerHTML=card("refused",'<div class="well">'+(model.refused||[]).map(refusedLine).join("")+"</div>");
    } else if(model.kind==="screens"){
      root.innerHTML=card("screens",stateLines()+'<div class="well"><div class="req">Screens</div>'+screensListHtml(model.screens||[])+"</div>");
    } else if(model.kind==="declared"){
      root.innerHTML=card(esc(model.declared?model.declared.status:"result"),stateLines()+'<div class="well">'+(model.declared?declaredLineHtml(model.declared):"")+"</div>");
    } else if(model.kind==="unreadable"){
      root.innerHTML=card("result",'<p class="empty"><b>'+RESULT_NOT_READABLE+"</b>"+RESULT_NOT_READABLE_BODY+"</p>");
    } else if(!hasToolResult){
      root.innerHTML=cardV2(stateLines()+loadingSkeletonHtml());
    } else {
      root.innerHTML=card("screen board",stateLines()+'<p class="empty"><b>'+EMPTY_BOARD_TITLE+"</b>"+EMPTY_BOARD_BODY+"</p>");
    }
    requestAnimationFrame(function(){ fitHost(); });
  }
  function fitHost(){
    document.documentElement.style.height="";
    document.body.style.height="";
    var measured=Math.ceil(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,420));
    document.documentElement.style.height=measured+"px";
    parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:measured}},"*");
  }
  function armListing(btn){
    if(!btn||btn.getAttribute("data-listing-ack")==="1") return null;
    btn.textContent=LISTING_ACK_LABEL;
    btn.disabled=true;
    btn.setAttribute("data-listing-ack","1");
    var text=listingHistoryMessage(model);
    listingAck={chars:text.length};
    btn.setAttribute("data-listing-chars",String(text.length));
    btn.setAttribute("title",text);
    var acts=btn.parentNode;
    if(acts&&acts.parentNode&&!acts.parentNode.querySelector(".ack")){
      var note=document.createElement("div");
      note.className="ack";
      note.setAttribute("data-listing-chars",String(text.length));
      note.textContent="Posted "+text.length+" chars";
      acts.parentNode.appendChild(note);
    }
    return text;
  }
  function sendListing(btn){
    var text=armListing(btn);
    if(!text) return;
    var before=fingerprint(model);
    host.sendMessage(text);
    if(fingerprint(model)!==before) throw new Error("i5_panel_mutated");
  }
  function armOpenWait(key){
    clearOpenTimer();
    openWait=key;
    openFail=null;
    openSent=null;
    openTimer=setTimeout(function(){
      if(openWait){
        openFail=OPEN_DID_NOT_REACH_ME;
        openWait=null;
        render();
      }
    },OPEN_DEAD_MS);
  }
  function requestMode(mode){
    parent.postMessage({jsonrpc:"2.0",id:rpcId++,method:"ui/request-display-mode",params:{mode:mode}},"*");
  }
  function sendExpand(){
    deepView=true;
    requestMode("fullscreen");
    render();
  }
  function sendCollapse(){
    deepView=false;
    openTile=-1;
    openRow=-1;
    requestMode("inline");
    render();
  }
  function sendTile(btn){
    var i=Number(btn&&btn.getAttribute("data-i"));
    if(!Number.isFinite(i)) return;
    openTile=openTile===i?-1:i;
    paintOpen(".ss-tile","data-i",openTile,".ss-source");
  }
  function sendRow(btn){
    var i=Number(btn&&btn.getAttribute("data-i"));
    if(!Number.isFinite(i)) return;
    openRow=openRow===i?-1:i;
    paintOpen(".ss-row","data-i",openRow,".ss-source");
  }
  function paintOpen(sel,attrName,open,panelSel){
    var root=document.getElementById("root");
    if(!root) return;
    var nodes=root.querySelectorAll(sel);
    var text="";
    for(var n=0;n<nodes.length;n++){
      var on=String(nodes[n].getAttribute(attrName))===String(open);
      if(on) nodes[n].setAttribute("data-open","1");
      else nodes[n].removeAttribute("data-open");
      if(on){
        var d=nodes[n].querySelector(".ss-tile-detail");
        text=d?d.textContent:"";
      }
    }
    var panel=root.querySelector(panelSel);
    if(!panel) return;
    if(open<0||!text){ panel.setAttribute("hidden",""); panel.textContent=""; return; }
    panel.removeAttribute("hidden");
    panel.textContent=text;
  }
  function sendLayer(btn){
    var key=attr(btn,"data-layer");
    if(key==="aerial") groundOn=!groundOn;
    else if(key==="flood") floodOn=!floodOn;
    else if(key==="envelope") envelopeOn=!envelopeOn;
    else if(key==="lines") linesOn=!linesOn;
    else return;
    render();
  }
  function sendSheet(){
    sheetHigh=!sheetHigh;
    render();
  }
  function sendShare(btn){
    var url=attr(btn,"data-url");
    if(!url) return;
    var clip=navigator.clipboard&&navigator.clipboard.writeText;
    if(!clip){ openLink(url); return; }
    clip.call(navigator.clipboard,url).then(function(){ btn.textContent="Link copied"; }).catch(function(){ openLink(url); });
  }
  function sendOpen(btn){
    var url=attr(btn,"data-url");
    if(url){ openLink(url); return; }
    var node=btn&&btn.getAttribute("data-node");
    if(!node) return;
    armOpenWait(node);
    host.sendMessage(openParcelMessage(node));
  }
  /* B3: a reopen is an Open on a screen the panel painted; same timer, same Sent line, never a new screen. */
  function sendReopen(btn){
    var id=attr(btn,"data-screen");
    if(!screenSummaryFor(model,id)) return;
    armOpenWait(id);
    host.sendMessage(reopenScreenMessage(id));
  }
  /* B1: a candidate is used only from the ambiguous row that carries it; the panel picks nothing. */
  function sendUseCandidate(btn){
    var node=attr(btn,"data-node");
    var query=attr(btn,"data-query");
    if(!candidateFor(model,node,query)) return;
    host.sendMessage(useCandidateMessage(node,query));
  }
  function sendLookup(btn){
    var query=attr(btn,"data-query");
    if(!lookupRowFor(model,query)) return;
    host.sendMessage(lookupMessage(query));
  }
  function attr(btn,name){
    return btn&&typeof btn.getAttribute==="function"?btn.getAttribute(name):null;
  }
  /* C1: one draft per choice; a status off the enum drafts nothing; no saved state is read (I6). */
  function sendSave(btn){
    var status=attr(btn,"data-status");
    if(!model.parcelNodeId||!status||SAVE_STATUSES.indexOf(status)<0) return;
    host.sendMessage(saveMessage(model.parcelNodeId,status));
  }
  /* F1: the control's own https url, through the same ui/open-link path as the district. */
  function sendCite(btn){
    var url=attr(btn,"data-url");
    if(!url||String(url).slice(0,8).toLowerCase()!=="https://") return;
    openLink(url);
  }
  /* P1: a question, not an Open: same sendMessage path, no timer, no ack. */
  function sendWhy(btn){
    var q=whyQuestion(model,attr(btn,"data-why-kind"),{i:attr(btn,"data-why-i"),rail:attr(btn,"data-why-rail"),node:attr(btn,"data-why-node")});
    if(!q) return;
    host.sendMessage(whyMessage(q));
  }
  /* C2: the neighbor the door names; the screen id stays with Claude. */
  function sendAddToScreen(btn){
    var node=attr(btn,"data-node");
    if(!node) return;
    host.sendMessage(addToScreenMessage(node));
  }
  /* R1: local toggle (I8); render posts size-changed and nothing else. */
  function toggleReport(){
    if(model.kind!=="parcel") return;
    reportOpen=!reportOpen;
    render();
  }
  /* M-2: local toggle, R1's pattern. Off removes every tile from the html; it does not hide them. */
  function toggleGround(){
    if(model.kind!=="parcel"&&model.kind!=="parcels") return;
    groundOn=!groundOn;
    render();
  }
  window.__ss={listing:sendListing,open:sendOpen,expand:sendExpand,collapse:sendCollapse,share:sendShare,save:sendSave,cite:sendCite,why:sendWhy,addToScreen:sendAddToScreen,report:toggleReport,ground:toggleGround,useCandidate:sendUseCandidate,lookup:sendLookup,reopen:sendReopen,tile:sendTile,row:sendRow,layer:sendLayer,sheet:sendSheet,fp:function(){return fingerprint(model)},parse:parseToolResult};
  document.body.addEventListener("click",function(ev){
    var el=ev.target;
    if(!el||!el.closest) return;
    var th=el.closest("[data-k]");
    if(th){
      sortKey=th.getAttribute("data-k");
      sortDir*=-1;
      render();
    }
  });
  var pendingMapRenderReport=null;
  function mapRenderReportFromRecord(host){
    var m=asRecord(host.mapRenderReport);
    if(!m) return null;
    var cid=stringOrNull(m.correlationId);
    var tok=stringOrNull(m.reportToken);
    if(!cid||!tok) return null;
    return {correlationId:cid,reportToken:tok};
  }
  function mapCardOutcomeFromModel(m){
    if(m.kind==="unreadable") return {outcome:"failed",reasonCode:"panel_unreadable"};
    if(m.kind==="miss"||m.kind==="refused"||m.kind==="declared") return {outcome:"fallback",reasonCode:m.kind};
    if(m.kind==="parcel"||m.kind==="parcels"||m.kind==="board"||m.kind==="screens") return {outcome:"drawn",reasonCode:"ok"};
    return {outcome:"fallback",reasonCode:m.kind||"unknown"};
  }
  function emitMapRenderReport(m,override){
    if(!pendingMapRenderReport||!MAP_RENDER_REPORT_URL) return;
    var pick=override||mapCardOutcomeFromModel(m);
    var payload={correlationId:pendingMapRenderReport.correlationId,reportToken:pendingMapRenderReport.reportToken,outcome:pick.outcome,reasonCode:pick.reasonCode};
    if(pendingToolName) payload.tool=pendingToolName;
    pendingMapRenderReport=null;
    window.__SS_M=(window.__SS_M||"")+"/*P456B_MAP_RENDER_REPORT_BEGIN*/";
    try{
      fetch(MAP_RENDER_REPORT_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}).catch(function(){});
    }catch(e){}
    window.__SS_M=(window.__SS_M||"")+"/*P456B_MAP_RENDER_REPORT_END*/";
  }
  function accept(result){
    hasToolResult=true;
    clearOpenTimer();
    openWait=null;
    openFail=null;
    openSent=null;
    reportOpen=false;
    groundOn=true;
    deepView=false;
    openTile=-1;
    openRow=-1;
    sheetHigh=false;
    floodOn=true;
    envelopeOn=true;
    linesOn=true;
    pendingToolName=null;
    pendingMapRenderReport=null;
    sortKey="completeness";
    sortDir=1;
    /* M-5: a new result is a new panel instance, so the per neighbour once
     * budget resets with it and no preview of the previous parcel's neighbours
     * can survive into this one. */
    cancelPreviewDwell();
    if(previewWait){clearTimeout(previewWait);previewWait=null;}
    previewState=Object.create(null);
    previewCode=Object.create(null);
    previewRow=Object.create(null);
    previewIds=Object.create(null);
    previewInFlight=null;
    previewBusyFor=null;
    previewNode=null;
    previewEl=null;
    var wire=asRecord(result);
    if(wire&&wire.structuredContent){
      var sc=asRecord(wire.structuredContent);
      if(sc) pendingMapRenderReport=mapRenderReportFromRecord(sc);
    }
    if(!pendingMapRenderReport&&wire&&wire.content){
      var jt=firstJsonObjectTextPart(wire.content);
      if(jt){
        try{ pendingMapRenderReport=mapRenderReportFromRecord(JSON.parse(jt)); }catch(e){}
      }
    }
    model=parseToolContent(result);
    try{
      render();
      emitMapRenderReport(model);
    }catch(err){
      emitMapRenderReport(model,{outcome:"failed",reasonCode:"render_threw"});
      throw err;
    }
  }
  window.addEventListener("message",function(ev){
    if(ev.source!==window.parent){ foreignCount++; paintBoot(); return; }
    var d=ev.data;
    if(!d) return;
    if(String(d.id)===String(initId)&&(d.result!==undefined||d.error)){
      if(d.error){
        capText="caps=error";
        msgCap="message=error";
        markHandshake("error");
      } else {
        summarizeCaps(d.result);
        markHandshake("ready");
      }
      flushReady();
      return;
    }
    if(d.id!=null&&probeIds[d.id]){
      delete probeIds[d.id];delete probeIds[String(d.id)];
      if(bridgeTimer){clearTimeout(bridgeTimer);bridgeTimer=null;}
      if(d.error){bridgeText="bridge=err"+(d.error.code!=null?String(d.error.code):"");}
      else if(d.result&&d.result.contents&&d.result.contents.length){bridgeText="bridge=ok";}
      else if(d.result!==undefined){bridgeText="bridge=empty";}
      else {bridgeText="bridge=odd";}
      paintBoot();
      return;
    }
    /* M-5: an app initiated tools/call reply. Routed by id and handled here, so
     * it can never reach accept(): a preview repaints one tooltip and nothing
     * else. A reply for a previous panel instance finds no id (accept() drops
     * them) and falls through to be ignored. */
    if(d.id!=null&&previewIds[d.id]!==undefined){
      var pnode=previewIds[d.id];
      delete previewIds[d.id];delete previewIds[String(d.id)];
      if(previewWait){clearTimeout(previewWait);previewWait=null;}
      if(previewInFlight===pnode) previewInFlight=null;
      if(d.error){
        var pcode=d.error.code!=null?String(d.error.code):"";
        previewState[pnode]="error";
        previewCode[pnode]=pcode;
        toolsSeen("err"+pcode);
      } else if(d.result&&d.result.isError){
        /* The CHANNEL worked and the tool declined. The token measures the
         * channel; the tooltip states the decline. */
        previewState[pnode]="declined";
        toolsSeen("ok");
      } else if(d.result!==undefined){
        var prow=previewRowFrom(d.result,pnode);
        if(prow){previewRow[pnode]=prow;previewState[pnode]="ok";}
        else{previewState[pnode]="empty";}
        toolsSeen("ok");
      } else {
        previewState[pnode]="empty";
        toolsSeen("ok");
      }
      releasePreviewBusy();
      repaintTip();
      return;
    }
    if(d.id!=null&&pendingMsg[d.id]){
      delete pendingMsg[d.id];
      delete pendingMsg[String(d.id)];
      if(d.error){
        replyText="reply="+(d.error.code!=null?String(d.error.code):"error");
        if(openWait){
          clearOpenTimer();
          openFail=OPEN_DID_NOT_REACH_ME;
          openWait=null;
          openSent=null;
          render();
        }
      } else if(d.result&&d.result.isError){
        replyText="reply=isError";
        accept(d.result);
      } else if(d.result!==undefined){
        replyText="reply=ok";
        if(d.result&&d.result.content) accept(d.result);
        else if(openWait){
          clearOpenTimer();
          openSent=openWait;
          openWait=null;
          openFail=null;
          render();
        }
      } else {
        replyText="reply=empty";
      }
      paintBoot();
      return;
    }
    if(d.method==="ui/notifications/tool-call"&&d.params&&d.params.toolName){
      pendingToolName=String(d.params.toolName);
      if(!hasToolResult) render();
      return;
    }
    if(d.method==="ui/notifications/tool-result"&&d.params){
      if(d.params.toolName) pendingToolName=String(d.params.toolName);
      else if(d.params._meta&&d.params._meta.tool) pendingToolName=String(d.params._meta.tool);
      accept(d.params);
    }
  });
  markHandshake("wait");
  parent.postMessage({jsonrpc:"2.0",id:initId,method:"ui/initialize",params:{protocolVersion:"2026-01-26",appInfo:{name:"SmartSiteBoard",version:"1"},appCapabilities:{availableDisplayModes:["inline"]}}},"*");
  setTimeout(function(){
    if(!ready){markHandshake("timeout");flushReady();}
  },2000);
})();
