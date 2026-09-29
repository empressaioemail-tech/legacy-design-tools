/**
 * The ICC plan review preview page. Built on the SmartCity design system
 * tokens and the plan review console's matrix row (_design/all-canvas/
 * PlanReviewConsole.dc.html). Self-contained: no bundle, no external origin.
 *
 * ICC links open through the host (ui/open-link). Only chapters whose page
 * address was confirmed in Chrome deep-link to the section (chapter 7 and
 * chapter 10, the same rule as plan-review PR #26); every other IBC citation
 * links to the book, labelled as the book.
 */

const ICC_BOOK = "https://codes.iccsafe.org/content/IBC2018P6";
const ICC_SECTION: Record<string, string> = {
  "1001.1": "https://codes.iccsafe.org/content/IBC2018P6/chapter-10-means-of-egress#IBC2018P6_Ch10_Sec1001.1",
  "705.5": "https://codes.iccsafe.org/content/IBC2018P6/chapter-7-fire-and-smoke-protection-features#IBC2018P6_Ch07_Sec705.5",
};

type Row = {
  id: string;
  book: string;
  section: string;
  title: string;
  text: string;
  atom: string;
  confidence: string;
  status: "Fail" | "Uncertain" | "Unchecked" | "Pass";
  licensed?: boolean;
};

const ROWS: { group: string; tally: string; rows: Row[] }[] = [
  {
    group: "City of Bastrop Building Block B3 (2026 adopted)",
    tally: "1 fail · 1 uncertain · 1 unchecked",
    rows: [
      { id: "b1", book: "BASTROP-UDC", section: "14-02-003", title: "Dimensional standards, SF-1", text: "Proposed front setback 22′-0″ is less than the 25′-0″ minimum for SF-1. The proposed figure was typed at intake, not captured from sheet A-101.", atom: "bastrop_tx-bdc-2026-adopted/14-02-003", confidence: "high", status: "Fail" },
      { id: "b2", book: "BASTROP-UDC", section: "14-02-008", title: "Permitted use, residential districts", text: "Use is permitted. Whether the addition triggers the Old Town overlay standards could not be resolved from the submitted scope.", atom: "bastrop_tx-bdc-2026-adopted/14-02-008", confidence: "medium", status: "Uncertain" },
      { id: "b3", book: "BASTROP-UDC", section: "14-02-005", title: "Lot coverage and impervious cover", text: "Not wired on this manifest. The section exists in the store and is not in this edition manifest.", atom: "bastrop_tx-bdc-2026-adopted/14-02-005", confidence: "not earned", status: "Unchecked" },
    ],
  },
  {
    group: "2018 International Building Code",
    tally: "1 uncertain · 1 pass · 2 unchecked",
    rows: [
      { id: "i1", book: "IBC-2018", section: "705.5", title: "Fire-resistance ratings", text: "Escalated. A reviewer recorded that two adopted authorities conflict for the west wall. Not a correction; no action asked of the applicant.", atom: "IBC-2018/705.5", confidence: "reviewer", status: "Uncertain", licensed: true },
      { id: "i2", book: "IBC-2018", section: "1001.1", title: "General (means of egress)", text: "Egress provisions apply to the proposed occupancy. Checked against the declared scope.", atom: "IBC-2018/1001.1", confidence: "high", status: "Pass", licensed: true },
      { id: "i3", book: "IBC-2018", section: "1604.1", title: "General design requirements", text: "No automated check is built for this section. Listed so the gap is visible, not hidden.", atom: "IBC-2018/1604.1", confidence: "not earned", status: "Unchecked", licensed: true },
      { id: "i4", book: "IBC-2018", section: "1203.1", title: "Ventilation, general", text: "Could not be retrieved on this run. Listed with its reason; not an approval.", atom: "IBC-2018/1203.1", confidence: "not earned", status: "Unchecked", licensed: true },
    ],
  },
];

export function buildPlanReviewPreviewPage(): string {
  const data = JSON.stringify({ rows: ROWS, iccSection: ICC_SECTION, iccBook: ICC_BOOK }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan review preview</title>
<style>
:root{
  --sc-canvas:#EEF1F4;--sc-surface:#FFFFFF;--sc-surface-2:#F6F8FA;--sc-surface-3:#E9EEF2;
  --sc-line-faint:#E4E9EE;--sc-line:#D2DAE1;--sc-line-strong:#AEBAC5;
  --sc-ink:#101820;--sc-ink-2:#46586A;--sc-ink-3:#576672;
  --sc-accent:#0B5940;--sc-accent-hi:#08432F;--sc-accent-wash:#E3F0EA;--sc-on-accent:#FFFFFF;
  --sc-ok:#2E7750;--sc-ok-wash:#E3F0E8;--sc-info:#2B5FC7;--sc-info-wash:#E5ECFB;
  --sc-warn:#9A5B08;--sc-warn-wash:#FBEEDA;--sc-crit:#AF2A22;--sc-crit-wash:#FBE6E4;
  --sc-restricted:#5347B5;--sc-restricted-wash:#EBE9F8;--sc-quiet:#576672;--sc-quiet-wash:#E9EEF2;
  --sc-atom:#177F78;--sc-e1:0 1px 2px rgba(16,24,32,.07);
  --ui:"Inter",ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --data:"IBM Plex Mono",ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--sc-canvas);color:var(--sc-ink);font:14px/20px var(--ui);-webkit-font-smoothing:antialiased}
button{font:inherit;cursor:pointer}
.icc{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#0B5940;color:#fff}
.logo{height:33px;padding:0 12px;display:inline-flex;align-items:center;border:1px dashed rgba(255,255,255,.7);border-radius:4px;font:500 11px/1 var(--data);letter-spacing:.06em}
.icc b{font:620 15px/22px var(--ui)}
.icc span.s{margin-left:auto;font-size:12.5px;opacity:.85}
header{height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--sc-surface);border-bottom:1px solid var(--sc-line)}
.brand{font:620 15px/22px var(--ui);letter-spacing:-.008em}
.vr{width:1px;height:18px;background:var(--sc-line)}
.mono{font-family:var(--data)}
.tag{font:500 11px/16px var(--data);letter-spacing:.06em;border:1px solid;border-radius:4px;padding:0 6px}
nav{display:flex;gap:18px;margin-left:12px}
nav button{border:0;background:none;padding:2px 0;color:var(--sc-ink-2);font:400 14px/20px var(--ui)}
nav button[aria-selected=true]{color:var(--sc-ink);font-weight:620;box-shadow:inset 0 -2px 0 var(--sc-accent)}
main{padding:16px 20px;display:flex;flex-direction:column;gap:14px}
.crumb{font:400 12px/16px var(--data);color:var(--sc-ink-3)}
.title{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h1{font:650 24px/30px var(--ui);letter-spacing:-.022em;margin:0}
.pill{font:500 12px/16px var(--ui);border:1px solid;border-radius:999px;padding:1px 9px;white-space:nowrap}
.p-Fail{color:var(--sc-crit);background:var(--sc-crit-wash)}.p-Uncertain{color:var(--sc-warn);background:var(--sc-warn-wash)}
.p-Unchecked{color:var(--sc-quiet);background:var(--sc-quiet-wash)}.p-Pass{color:var(--sc-ok);background:var(--sc-ok-wash)}
.p-info{color:var(--sc-info);background:var(--sc-info-wash)}
.edition{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--sc-ok);background:var(--sc-ok-wash);border-radius:6px;font-size:13px}
.stages{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--sc-line);padding-bottom:10px}
.stage{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:13px;color:var(--sc-ink-2)}
.stage i{width:7px;height:7px;border-radius:50%;background:var(--sc-line-strong)}
.stage.done i{background:var(--sc-ok)}.stage.on{background:var(--sc-accent-wash);color:var(--sc-ink);font-weight:620}.stage.on i{background:var(--sc-accent)}
.dash{width:18px;height:1px;background:var(--sc-line)}
.filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--sc-ink-3)}
.chipf{font:500 12px/16px var(--ui);padding:3px 10px;border-radius:999px;border:1px solid var(--sc-line);color:var(--sc-ink-2);background:transparent}
.chipf.on{border-color:var(--sc-accent);color:var(--sc-accent);background:var(--sc-accent-wash)}
.card{border:1px solid var(--sc-line);border-radius:6px;background:var(--sc-surface);overflow:hidden;box-shadow:var(--sc-e1)}
.group{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--sc-surface-2);border-top:1px solid var(--sc-line-faint);border-bottom:1px solid var(--sc-line-faint)}
.group b{font:650 13px/18px var(--ui)}
.row{display:grid;grid-template-columns:3px minmax(0,1fr) auto;gap:12px;align-items:start;padding:10px 12px;border-bottom:1px solid var(--sc-line-faint);cursor:pointer}
.row:hover{filter:brightness(.985)}
.row .bar{align-self:stretch;border-radius:999px}
.r-Fail{background:var(--sc-crit-wash)}.r-Fail .bar{background:var(--sc-crit)}
.r-Uncertain{background:var(--sc-warn-wash)}.r-Uncertain .bar{background:var(--sc-warn)}
.r-Unchecked{background:repeating-linear-gradient(-45deg,var(--sc-quiet-wash),var(--sc-quiet-wash) 6px,var(--sc-surface) 6px,var(--sc-surface) 12px)}.r-Unchecked .bar{background:var(--sc-quiet)}
.r-Pass .bar{background:var(--sc-ok)}
.body{min-width:0;display:flex;flex-direction:column;gap:4px}
.sec{display:inline-flex;flex-direction:column;gap:2px;align-self:flex-start;border:1px solid var(--sc-line);border-radius:4px;padding:3px 8px;background:var(--sc-surface)}
.sec small{font:400 12px/15px var(--data);color:var(--sc-ink-3)}.sec span{font:500 13px/17px var(--data)}
.rt{font:600 14px/20px var(--ui)}
.rx{font-size:13px;line-height:19px;color:var(--sc-ink-2);max-width:78ch}
.meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font:400 12px/16px var(--data);color:var(--sc-ink-3)}
.withheld{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font:400 12px/16px var(--data);color:var(--sc-restricted);background:var(--sc-restricted-wash);border-radius:4px;padding:2px 8px}
.icclink{display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:0;color:var(--sc-accent);font:500 12px/16px var(--ui);text-decoration:underline;text-underline-offset:2px}
.icclink.book{color:var(--sc-ink-2)}
.split{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px}
@media (max-width:760px){.split{grid-template-columns:1fr}}
.kv{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:12px;border-top:1px solid var(--sc-line-faint)}
.kv .k{font:500 11px/16px var(--data);letter-spacing:.06em;color:var(--sc-ink-3)}
.ph{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 12px}
.ph b{font:620 14px/20px var(--ui)}.ph small{font:400 12px/16px var(--data);color:var(--sc-ink-3)}
.warn{color:var(--sc-warn);font-size:12.5px;margin-top:4px}
.btns{display:flex;gap:8px;padding:12px;border-top:1px solid var(--sc-line-faint);flex-wrap:wrap}
.btn{border-radius:4px;padding:6px 12px;font-size:13px;border:1px solid var(--sc-line);background:var(--sc-surface);color:var(--sc-ink)}
.btn.pri{background:var(--sc-accent);border-color:var(--sc-accent);color:#fff}.btn.dan{color:var(--sc-crit);border-color:var(--sc-crit)}
.opt{margin:6px 12px;border:1px solid var(--sc-line);border-radius:6px;padding:8px 10px;font-size:13px}.opt i{font-style:normal;color:var(--sc-ink-3);font-size:12px;margin-left:6px}
pre{margin:0;padding:10px 12px;font:12px/1.55 var(--data);background:var(--sc-surface-2);overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{font:500 11px/16px var(--data);letter-spacing:.05em;color:var(--sc-ink-3);text-align:left;padding:8px 12px}td{padding:8px 12px;border-top:1px solid var(--sc-line-faint)}
.letter{padding:16px 20px}.letter h2{font:650 18px/24px var(--ui);margin:0 0 10px;padding-bottom:10px;border-bottom:2px solid var(--sc-ink)}
.letter h3{font:500 12px/16px var(--data);letter-spacing:.08em;color:var(--sc-ink-2);margin:16px 0 6px}
.foot{margin:0 20px 16px;padding:8px 10px;border:1px solid #e8c77a;background:#FFF6DF;border-radius:6px;font-size:12px;color:#5c4400}
.foot b{font:600 11px/16px var(--data);letter-spacing:.06em;margin-right:6px}
.toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:var(--sc-ink);color:#fff;padding:8px 12px;border-radius:6px;font-size:12.5px;display:none;max-width:90%}
.back{border:0;background:none;color:var(--sc-accent);padding:0;font-size:13px}
</style>
</head>
<body>
<div class="icc"><span class="logo" title="Licensed ICC logo art to be supplied by ICC">ICC LOGO</span><b>International Code Council</b><span class="s">Plan review in Claude · concept</span></div>
<header>
  <span class="brand">Plan Review</span><span class="vr"></span>
  <span class="mono" style="font-size:13px;color:var(--sc-ink-2)">bastrop_tx</span>
  <span class="tag" style="color:var(--sc-restricted);background:var(--sc-restricted-wash)">FIXTURE</span>
  <nav role="tablist">
    <button role="tab" data-v="matrix" aria-selected="true">Matrix</button>
    <button role="tab" data-v="finding" aria-selected="false">Finding</button>
    <button role="tab" data-v="letter" aria-selected="false">Letter</button>
    <button role="tab" data-v="code" aria-selected="false">Code</button>
  </nav>
</header>
<main id="view"></main>
<div class="foot"><b>PLACEHOLDER</b>An illustrative review on a fixture engagement, not a review of any real submission, and no finding here is a determination. A concept prepared for the International Code Council; the ICC name identifies the audience and implies no ICC approval or endorsement.</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var D=${data};
  var cur='matrix', sel='b1', rpc=1, pendingLinks={};
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function post(m){try{parent.postMessage(m,'*');}catch(e){}}
  function fit(){post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:document.documentElement.scrollHeight}});}
  function toast(t){var el=document.getElementById('toast');el.textContent=t;el.style.display='block';setTimeout(function(){el.style.display='none';},3500);}
  function openLink(url){
    var id=rpc++;
    pendingLinks[id]=url;
    post({jsonrpc:'2.0',id:id,method:'ui/open-link',params:{url:url}});
    setTimeout(function(){
      if(pendingLinks[id]){delete pendingLinks[id];var w=null;try{w=window.open(url,'_blank','noopener');}catch(e){}if(!w)toast('Open on ICC Digital Codes: '+url);}
    },1500);
  }
  function iccLink(r){
    if(!r.licensed) return '';
    var deep=D.iccSection[r.section];
    return deep
      ? '<button class="icclink" data-url="'+esc(deep)+'">View this section on ICC Digital Codes ↗</button>'
      : '<button class="icclink book" data-url="'+esc(D.iccBook)+'">Open the 2018 IBC on ICC Digital Codes ↗</button>';
  }
  var LOCK='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  function rowHtml(r){
    return '<div class="row r-'+r.status+'" data-row="'+r.id+'"><span class="bar"></span><div class="body">'
      +'<span class="sec"><small>'+esc(r.book)+'</small><span>'+esc(r.section)+'</span></span>'
      +'<span class="rt">'+esc(r.title)+'</span>'
      +(r.licensed?'<span class="withheld">'+LOCK+' Body withheld — licensed corpus, cited not quoted</span>':'')
      +'<span class="rx">'+esc(r.text)+'</span>'
      +'<span class="meta"><span>atom '+esc(r.atom)+'</span><span>confidence: '+esc(r.confidence)+'</span>'+iccLink(r)+'</span>'
      +'</div><span class="pill p-'+r.status+'">'+r.status+'</span></div>';
  }
  function head(stage){
    var st=['Intake','Applicability','Findings','Letter'],i=st.indexOf(stage);
    return '<div><div class="crumb">Work / Plan review / PR-2026-0418</div><div class="title"><h1>908 PINE ST</h1><span class="pill p-info">In review</span><span class="mono" style="font-size:13px;color:var(--sc-ink-3)">48021:34137 · residential-addition · cycle 1</span></div></div>'
      +'<div class="edition"><b style="font-weight:500">Edition declared</b><span class="mono" style="color:var(--sc-ink-2)">bastrop_tx-bdc-2026-adopted · IBC-2018</span><span style="color:var(--sc-ink-3);font-size:12px">Declared at intake, not derived from the jurisdiction.</span></div>'
      +'<div class="stages">'+st.map(function(s,k){return (k?'<span class="dash"></span>':'')+'<span class="stage'+(k<i?' done':'')+(k===i?' on':'')+'"><i></i>'+s+'</span>';}).join('')+'</div>';
  }
  function findRow(id){for(var g=0;g<D.rows.length;g++)for(var k=0;k<D.rows[g].rows.length;k++)if(D.rows[g].rows[k].id===id)return D.rows[g].rows[k];return null;}
  var V={
    matrix:function(){
      return head('Findings')
        +'<div class="filters"><span class="chipf on">All</span><span class="chipf">Unresolved only</span><span>7 shown · 13 rules in scope</span><span style="flex:1"></span><span class="mono">atom-chain resolved · bodyVerbatim=false</span></div>'
        +'<div class="card">'+D.rows.map(function(g){return '<div class="group"><b>'+esc(g.group)+'</b><span class="mono" style="font-size:12px;color:var(--sc-ink-3)">'+esc(g.tally)+'</span></div>'+g.rows.map(rowHtml).join('');}).join('')+'</div>';
    },
    finding:function(){
      var r=findRow(sel)||findRow('b1');
      var local=r.id==='b1';
      var right=local
        ? '<div class="card"><div class="ph"><b>A-101</b><small>site plan · pinned at the front setback</small></div>'+SHEET+'</div>'
        : '<div class="card"><div class="ph"><b>Where the text lives</b><small>ICC Digital Codes</small></div><div class="kv"><div class="k">BODY</div><div><span class="withheld">'+LOCK+' Withheld — licensed corpus</span><div class="rx" style="margin-top:6px">A licensed reviewer reads the section on ICC\\'s own site. Claude gets the citation and the reasoning, never the book.</div><div style="margin-top:8px">'+iccLink(r)+'</div></div></div></div>';
      var how=local
        ? '<div class="kv"><div class="k">RULE</div><div>Minimum front setback in SF-1 is 25′-0″.<div class="meta" style="margin-top:2px">City of Bastrop Building Block B3 · Section 14-02-003 · edition declared at intake</div></div></div>'
          +'<div class="kv"><div class="k">INPUT</div><div>Proposed front setback 22′-0″.<div class="meta" style="margin-top:2px">Typed into the intake form on 11 Sep. No sheet, no location, no source.</div><div class="warn">Lowest provenance on the ladder. Capturing the value from the dimension string on A-101 would move it to the top rung.</div></div></div>'
          +'<div class="kv"><div class="k">COMPARISON</div><div>22′-0″ is less than 25′-0″, so the rule is not met.<div class="meta" style="margin-top:2px">A numeric comparison, stated so a reviewer can check it by hand.</div></div></div>'
        : '<div class="kv"><div class="k">CITATION</div><div>2018 International Building Code Section '+esc(r.section)+' (IBC-2018)<div class="meta" style="margin-top:2px">did:hauska:code-section:icc-model-code/2018-international-building-code-6th-printing/'+esc(r.section.replace('.','-'))+'</div></div></div>'
          +'<div class="kv"><div class="k">FINDING</div><div>'+esc(r.text)+'</div></div>'
          +'<div class="kv"><div class="k">CONFIDENCE</div><div class="mono" style="font-size:12.5px">{ "state": "'+r.status.toLowerCase()+'", "confidence": "'+esc(r.confidence)+'", "bodyVerbatim": false }</div></div>';
      return '<div><button class="back" data-v="matrix">← Matrix</button></div>'
        +'<div class="title"><h1>'+esc(r.title)+'</h1><span class="pill p-'+r.status+'">'+r.status+'</span><span class="mono" style="font-size:13px;color:var(--sc-ink-3)">'+esc(r.book)+' '+esc(r.section)+' · PR-2026-0418</span></div>'
        +'<div class="split"><div><div class="card"><div class="ph"><b>How this was reached</b><small>each link breakable</small></div>'+how
        +'<div class="btns"><button class="btn pri" data-v="letter">Accept into the letter</button><button class="btn">Edit the comment</button><button class="btn dan">Dismiss</button></div></div>'
        +'<div class="card" style="margin-top:14px"><div class="ph"><b>If you dismiss this</b><small>the reason is the product</small></div><div class="opt">The rule does not apply here<i>applicability</i></div><div class="opt">The rule is right, the input is wrong<i>input</i></div><div class="opt">Both are right, the conclusion is not<i>adjudication</i></div><div class="opt" style="margin-bottom:12px">Correct, but I am not citing it<i>judgement</i></div></div></div>'
        +'<div>'+right+'</div></div>';
    },
    letter:function(){
      return head('Letter')
        +'<div class="split"><div class="card letter"><h2>Correction notice · PR-2026-0418 · cycle 1</h2>'
        +'<div class="rx">One item must be corrected before this application can be approved. One further item is escalated to a reviewer and is not a correction. Rules that could not be evaluated are listed at the end; none of them is an approval.</div>'
        +'<h3>CORRECTIONS REQUIRED — 1</h3><div class="rt">1. Front setback</div><div class="rx">The proposed front setback of 22′-0″ is less than the 25′-0″ minimum for SF-1. Revise the site plan or apply for a variance.</div><div class="meta">City of Bastrop Building Block B3 Section 14-02-003 · Sheet A-101 · accepted by M. Leavis</div>'
        +'<h3>ESCALATED, NOT A CORRECTION — 1</h3><div class="rt">2. Fire-resistance ratings</div><div class="rx">A reviewer recorded that two adopted authorities conflict for the west wall. No action is required from you on this item. The text of the cited section is not reproduced here.</div><div class="meta">2018 International Building Code Section 705.5 (IBC-2018) · '+iccLink(findRow('i1'))+'</div>'
        +'<h3>NOT EVALUATED — 10</h3><div class="rx">Each is named with its reason in the attached list: not in our corpus, confirmed not to apply, behind a licence we do not hold, not retrieved on this run, or no automated check built. <b>None of this is an approval.</b></div></div>'
        +'<div><div class="card"><div class="ph"><b>Resubmittal manifest</b><small>machine-readable, attached</small></div><pre>{\\n  "engagement": "PR-2026-0418",\\n  "cycle": 1,\\n  "corrections": [\\n    { "finding": 1, "sheet": "A-101",\\n      "bookId": "BASTROP-UDC",\\n      "sectionNumber": "14-02-003" }\\n  ],\\n  "escalated": [\\n    { "finding": 2, "bookId": "IBC2018P6",\\n      "sectionNumber": "705.5",\\n      "bodyVerbatim": false }\\n  ]\\n}</pre></div></div></div>';
    },
    code:function(){
      var r=findRow('i2');
      return '<div class="title"><h1>Code library</h1><span class="mono" style="font-size:13px;color:var(--sc-ink-3)">how the licensed code is treated</span></div>'
        +'<div class="split"><div class="card"><div class="ph"><b>IBC-2018 · 1001.1</b><small>'+esc(r.title)+'</small></div>'
        +'<div class="kv"><div class="k">CITATION</div><div>2018 International Building Code Section 1001.1 (IBC-2018)</div></div>'
        +'<div class="kv"><div class="k">ATOM ID</div><div class="mono" style="font-size:12px;word-break:break-all">did:hauska:code-section:icc-model-code/2018-international-building-code-6th-printing/1001-1</div></div>'
        +'<div class="kv"><div class="k">BODY POLICY</div><div><span class="withheld">'+LOCK+' Licensed model code. Citation and deep link only, body is not reproduced.</span></div></div>'
        +'<div class="kv"><div class="k">READ IT</div><div>'+iccLink(r)+'<div class="rx" style="margin-top:4px">Opens the section on ICC\\'s own site.</div></div></div>'
        +'<div class="kv"><div class="k">TO CLAUDE</div><div><pre style="padding:8px;background:var(--sc-surface-2)">get_atom …/1001-1\\n  caller: anonymous → refused\\n  accessPolicy: platform-internal\\n  returned: citation + deep link</pre></div></div></div>'
        +'<div class="card"><div class="ph"><b>Every reference is metered</b><small>the ICC usage ledger</small></div><table><thead><tr><th>SOURCE</th><th>BOOK</th><th>SECTION</th><th style="text-align:right">RATE</th></tr></thead><tbody>'
        +[['MCP (this card)','IBC2018P6','1001.1'],['Plan review UI','IBC2018P6','1001.1'],['Plan review UI','IBC2018P6','705.5'],['MCP','IBC2018P6','705.5']].map(function(x){return '<tr><td>'+x[0]+'</td><td class="mono">'+x[1]+'</td><td class="mono">'+x[2]+'</td><td class="mono" style="text-align:right">$0.01</td></tr>';}).join('')
        +'</tbody></table><div class="rx" style="padding:10px 12px;border-top:1px solid var(--sc-line-faint)">Illustrative rows. <b>$0.01 is a proof-of-concept fixture, not a quoted price.</b> The live ledger is on the ICC portal\\'s activity page.</div></div></div>';
    }
  };
  var SHEET='<svg viewBox="0 0 560 470" role="img" aria-label="Site plan A-101, placeholder" style="display:block;width:100%;height:auto">'
   +'<rect x="100" y="20" width="330" height="370" fill="none" stroke="#101820" stroke-width="2.5"/>'
   +'<rect x="125" y="105" width="245" height="200" fill="#E3F0EA" stroke="#0B5940" stroke-width="2"/>'
   +'<text x="247" y="200" text-anchor="middle" font-size="13" fill="#0B5940" font-weight="600">PROPOSED RESIDENCE</text>'
   +'<line x1="247" y1="20" x2="247" y2="105" stroke="#576672" stroke-dasharray="4 4"/><line x1="247" y1="305" x2="247" y2="390" stroke="#AF2A22" stroke-dasharray="4 4"/>'
   +'<text x="290" y="55" font-size="11" font-family="monospace">20′-0″ REAR</text><text x="290" y="355" font-size="11" font-family="monospace" fill="#AF2A22">22′-0″ FRONT</text>'
   +'<circle cx="247" cy="350" r="11" fill="#AF2A22"/><text x="247" y="354" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">1</text>'
   +'<rect x="70" y="410" width="390" height="40" fill="#E9EEF2"/><text x="265" y="435" text-anchor="middle" font-size="13" letter-spacing="3" fill="#576672">PINE STREET</text></svg>';
  function show(v){
    cur=v;
    document.getElementById('view').innerHTML=V[v]();
    var tabs=document.querySelectorAll('nav button');
    for(var i=0;i<tabs.length;i++)tabs[i].setAttribute('aria-selected',tabs[i].getAttribute('data-v')===v?'true':'false');
    setTimeout(fit,0);
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('[data-url]');
    if(a){e.preventDefault();e.stopPropagation();openLink(a.getAttribute('data-url'));return;}
    var r=e.target.closest('[data-row]');
    if(r){sel=r.getAttribute('data-row');show('finding');return;}
    var t=e.target.closest('[data-v]');
    if(t){show(t.getAttribute('data-v'));}
  });
  window.addEventListener('message',function(ev){
    var d=ev.data;if(!d||typeof d!=='object')return;
    if(d.id===0&&d.result){post({jsonrpc:'2.0',method:'ui/notifications/initialized'});return;}
    if(d.id!=null&&pendingLinks[d.id]){
      var url=pendingLinks[d.id];delete pendingLinks[d.id];
      if(d.error||(d.result&&d.result.isError)){var w=null;try{w=window.open(url,'_blank','noopener');}catch(x){}if(!w)toast('Open on ICC Digital Codes: '+url);}
    }
  });
  post({jsonrpc:'2.0',id:0,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'PlanReviewPreview',version:'2'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}}});
  show('matrix');
  window.addEventListener('resize',fit);
})();
</script>
</body>
</html>`;
}
