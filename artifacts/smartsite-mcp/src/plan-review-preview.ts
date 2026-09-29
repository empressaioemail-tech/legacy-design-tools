/**
 * ICC plan review preview (demo only).
 *
 * A fixture plan review rendered as an MCP App, to show what plan review would
 * look like inside the connector. Nothing here reads a real submission: the
 * engagement, sheet and findings are the SmartCity design fixture
 * (PR-2026-0418, 908 PINE ST), and the card says so on every view.
 *
 * Registered only for the emails in PLAN_REVIEW_PREVIEW_EMAILS. With the
 * variable unset, neither the tool nor its resource exists, so no customer
 * session ever lists it. The HTML is self-contained (no card bundle, no
 * external origins), so it cannot disturb the Smart Site board.
 */
import { getAuthContext } from "./request-context.js";

export const PLAN_REVIEW_PREVIEW_TOOL = "plan_review_preview";
export const PLAN_REVIEW_PREVIEW_URI = "ui://smartsite/plan-review-preview-v1.html";
const APP_MIME = "text/html;profile=mcp-app";

export function planReviewPreviewAllowed(
  email: string | null | undefined,
  allowList: string | undefined = process.env.PLAN_REVIEW_PREVIEW_EMAILS,
): boolean {
  if (!email || !allowList) return false;
  const want = email.trim().toLowerCase();
  return allowList
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(want);
}

const SUMMARY_TEXT = [
  "ILLUSTRATIVE PREVIEW - a fixture plan review, not a review of any real submission.",
  "Engagement PR-2026-0418, 908 PINE ST, Bastrop TX, single-family, cycle 1, edition declared at intake.",
  "13 findings: 12 rules in scope plus 1 added by a reviewer. Fail 2, Uncertain 1, Unchecked 9, Pass 1.",
  "1 Front setback - Fail, live check: proposed 22'-0\" is below the 25'-0\" SF-1 minimum (City of Bastrop Building Block B3 Section 14-02-003).",
  "2 Fire separation distance - Uncertain, escalated to a reviewer: two adopted authorities conflict for the west wall (2018 International Building Code Section 705.5; text not reproduced).",
  "3 and 4 Side and rear setbacks - Unchecked: section not in the corpus, so no citation can be built.",
  "6 Driveway width - Fail by a reviewer, held back: no citation yet, so it cannot be issued.",
  "Correction notice (draft): 1 correction, 1 escalated, 10 not evaluated, 1 held back. None of this is an approval.",
  "How we treat the code: each finding carries a canonical citation, an atom id and a confidence object, and no ICC body text; ICC text is refused to Claude (accessPolicy platform-internal) and replaced by a deep link to codes.iccsafe.org; every reference is metered by source, book and section ($0.01 is a proof-of-concept fixture, not a quoted price).",
  "The card shows the review console, how finding 1 was reached, the draft correction notice, and how the code is treated. Present it as a preview of plan review in Claude; do not describe it as a real review.",
].join("\n");

export function buildPlanReviewPreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan review preview</title>
<style>
:root{--ink:#16202a;--mut:#5b6773;--line:#dde3e8;--bg:#f3f5f7;--card:#fff;--teal:#0B5940;--teal-bg:#e7f1ed;--red:#b42318;--red-bg:#fdecea;--vio:#5b3fb0;--vio-bg:#efeafb;--amb:#9a6700;--amb-bg:#fff4d6;--gry-bg:#eef1f4;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.icc{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;background:#0B5940;color:#fff}
.logo-slot{display:inline-flex;align-items:center;justify-content:center;height:33px;padding:0 12px;border:1px dashed rgba(255,255,255,.7);border-radius:4px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.9}
.icc-name{font-weight:600;font-size:15px;letter-spacing:.01em}
.icc-sub{font-size:12.5px;opacity:.85;margin-left:auto}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;background:var(--card);border-bottom:1px solid var(--line)}
.brand{font-weight:600}
.city{color:var(--mut);font-family:var(--mono);font-size:12px}
.tag{font-family:var(--mono);font-size:11px;letter-spacing:.06em;padding:1px 6px;border-radius:4px;border:1px solid}
.tag.fx{color:var(--vio);border-color:var(--vio);background:var(--vio-bg)}
.tabs{display:flex;gap:4px;margin-left:auto}
.tabs button{border:1px solid var(--line);background:var(--card);border-radius:16px;padding:4px 12px;font-size:13px;cursor:pointer;color:var(--ink)}
.tabs button[aria-selected=true]{border-color:var(--teal);background:var(--teal-bg);color:var(--teal);font-weight:600}
.head{padding:12px 14px 4px}
.head h1{margin:0;font-size:20px;display:inline}
.head .meta{font-family:var(--mono);font-size:12px;color:var(--mut);margin-left:8px}
.steps{display:flex;gap:6px;align-items:center;padding:6px 14px 10px;flex-wrap:wrap;font-size:12px;color:var(--mut)}
.steps span{border:1px solid var(--line);border-radius:14px;padding:2px 10px;background:var(--card)}
.steps span.on{border-color:var(--teal);color:var(--teal);background:var(--teal-bg);font-weight:600}
.wrap{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:12px;padding:0 14px 14px}
@media (max-width:720px){.wrap{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.ph{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.ph b{font-size:14px}
.ph .m{font-family:var(--mono);font-size:11px;color:var(--mut)}
.sheets{font-family:var(--mono);font-size:12px;color:var(--mut)}
.sheets u{color:var(--ink);text-decoration-color:var(--teal);text-decoration-thickness:2px}
svg{display:block;width:100%;height:auto}
.chips{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap}
.chip{font-size:12px;border-radius:12px;padding:2px 9px;background:var(--gry-bg)}
.f{display:flex;gap:10px;padding:10px 12px;border-top:1px solid var(--line);cursor:pointer}
.f:hover{background:#f7fafb}
.f.sel{background:var(--teal-bg);box-shadow:inset 3px 0 0 var(--teal)}
.n{flex:0 0 22px;height:22px;border-radius:50%;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;font-weight:600}
.n.red{background:var(--red)}.n.vio{background:var(--vio)}.n.gry{background:#56616c}
.ft{font-weight:600}
.b{font-family:var(--mono);font-size:11px;padding:1px 6px;border-radius:4px;margin-left:4px;white-space:nowrap}
.b.fail{color:var(--red);background:var(--red-bg)}.b.unc{color:var(--vio);background:var(--vio-bg)}.b.unch{color:#3d4852;background:var(--gry-bg)}.b.live{color:#1a7f37;background:#e6f4ea}.b.rev{color:#3d4852;background:var(--gry-bg)}.b.amb{color:var(--amb);background:var(--amb-bg)}
.cite{font-family:var(--mono);font-size:12px;color:#3d4852;margin-top:2px}
.why{font-size:12.5px;color:var(--mut);margin-top:2px}
.row{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:12px;border-top:1px solid var(--line)}
.row .k{font-family:var(--mono);font-size:12px;color:var(--mut);letter-spacing:.05em}
.warn{color:var(--amb);font-size:12.5px;margin-top:4px}
.btns{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);flex-wrap:wrap}
.btn{border-radius:6px;padding:7px 12px;font-size:13px;border:1px solid var(--line);background:var(--card);cursor:pointer}
.btn.pri{background:var(--teal);border-color:var(--teal);color:#fff}
.btn.dan{color:var(--red);border-color:var(--red)}
.opt{margin:6px 12px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:13px}
.opt i{color:var(--mut);font-style:normal;font-size:12px;margin-left:6px}
.letter{padding:14px 18px}
.letter h2{margin:0 0 8px;font-size:18px;border-bottom:2px solid var(--ink);padding-bottom:8px}
.letter h3{font-family:var(--mono);font-size:12px;letter-spacing:.08em;color:#3d4852;margin:16px 0 6px}
.item{display:grid;grid-template-columns:24px 1fr;gap:6px;margin-bottom:10px}
.tally div{display:grid;grid-template-columns:120px 1fr;padding:6px 12px;border-top:1px solid var(--line);font-size:13px}
pre{margin:0;padding:10px 12px;font:12px/1.5 var(--mono);background:#f6f8fa;overflow:auto}
.foot{margin:0 14px 14px;padding:8px 10px;border:1px solid #e8c77a;background:var(--amb-bg);border-radius:6px;font-size:12px;color:#5c4400}
.foot b{font-family:var(--mono);font-size:11px;letter-spacing:.06em;margin-right:6px}
.inline .wrap{grid-template-columns:1fr}
.inline .hide-inline{display:none}
.more{display:none;padding:0 14px 12px}
.inline .more{display:block}
</style>
</head>
<body class="inline">
<div class="icc">
  <span class="logo-slot" title="Licensed ICC logo art to be supplied by ICC">ICC logo</span>
  <span class="icc-name">International Code Council</span>
  <span class="icc-sub">Plan review in Claude &middot; concept</span>
</div>
<div class="top">
  <span class="brand">Plan Review</span>
  <span class="city">Bastrop, TX</span>
  <span class="tag fx">FIXTURE</span>
  <span class="tag fx" style="color:var(--teal);border-color:var(--teal);background:var(--teal-bg)">PREVIEW IN CLAUDE</span>
  <div class="tabs" role="tablist">
    <button role="tab" data-v="console" aria-selected="true">Console</button>
    <button role="tab" data-v="finding" aria-selected="false">Finding 1</button>
    <button role="tab" data-v="letter" aria-selected="false">Correction notice</button>
    <button role="tab" data-v="codes" aria-selected="false">How we treat the code</button>
  </div>
</div>
<div id="view"></div>
<div class="more"><button class="btn pri" id="expand">Open the full review</button></div>
<div class="foot"><b>PLACEHOLDER</b>An illustrative review on a fixture engagement. The plan sheet is a drawing made for this design, not a real submitted drawing, and no finding here is a determination. A concept prepared for the International Code Council; the ICC name is used to identify the audience and does not imply ICC approval or endorsement.</div>
<script>
(function(){
  var SHEET='<svg viewBox="0 0 560 470" role="img" aria-label="Site plan A-101, placeholder">'
   +'<rect x="100" y="20" width="330" height="370" fill="none" stroke="#16202a" stroke-width="2.5"/>'
   +'<rect x="125" y="105" width="245" height="200" fill="#e7f1ed" stroke="#0B5940" stroke-width="2"/>'
   +'<text x="247" y="200" text-anchor="middle" font-size="13" fill="#0B5940" font-weight="600">PROPOSED RESIDENCE</text>'
   +'<text x="247" y="220" text-anchor="middle" font-size="11" fill="#5b6773" font-family="monospace">60\\u2032 x 48\\u2032 \\u00b7 2,880 SF</text>'
   +'<line x1="247" y1="20" x2="247" y2="105" stroke="#56616c" stroke-dasharray="4 4"/>'
   +'<line x1="247" y1="305" x2="247" y2="390" stroke="#b42318" stroke-dasharray="4 4"/>'
   +'<line x1="100" y1="205" x2="125" y2="205" stroke="#56616c" stroke-dasharray="4 4"/>'
   +'<line x1="370" y1="205" x2="430" y2="205" stroke="#56616c" stroke-dasharray="4 4"/>'
   +'<text x="290" y="55" font-size="11" font-family="monospace" fill="#16202a">20\\u2032-0\\u2033 REAR</text>'
   +'<text x="290" y="355" font-size="11" font-family="monospace" fill="#b42318">22\\u2032-0\\u2033 FRONT</text>'
   +'<text x="40" y="200" font-size="11" font-family="monospace" fill="#16202a">6\\u2032-0\\u2033</text><text x="40" y="214" font-size="10" font-family="monospace" fill="#5b6773">SIDE W</text>'
   +'<text x="440" y="200" font-size="11" font-family="monospace" fill="#16202a">14\\u2032-0\\u2033</text><text x="440" y="214" font-size="10" font-family="monospace" fill="#5b6773">SIDE E</text>'
   +'<circle cx="247" cy="350" r="11" fill="#b42318"/><text x="247" y="354" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">1</text>'
   +'<circle cx="125" cy="270" r="11" fill="#5b3fb0"/><text x="125" y="274" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">2</text>'
   +'<circle cx="80" cy="245" r="11" fill="#56616c"/><text x="80" y="249" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">3</text>'
   +'<circle cx="247" cy="62" r="11" fill="#56616c"/><text x="247" y="66" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">4</text>'
   +'<rect x="70" y="410" width="390" height="40" fill="#eef1f4"/><text x="265" y="435" text-anchor="middle" font-size="13" letter-spacing="3" fill="#5b6773">PINE STREET</text>'
   +'<path d="M500 60 l10 34 l-10 -8 l-10 8 z" fill="#3d4852"/><text x="500" y="112" text-anchor="middle" font-size="11" fill="#3d4852">N</text>'
   +'</svg>';
  var F=[
   {n:1,c:'red',t:'Front setback',b:[['fail','Fail'],['live','LIVE CHECK']],cite:'City of Bastrop Building Block B3 Section 14-02-003 (bastrop_tx-bdc-2026-adopted)',why:'Proposed 22\\u2032-0\\u2033 is below the 25\\u2032-0\\u2033 minimum for SF-1.'},
   {n:2,c:'vio',t:'Fire separation distance',b:[['unc','Uncertain'],['rev','REVIEWER']],cite:'2018 International Building Code Section 705.5 (IBC-2018)',why:'M. Leavis recorded a conflict between two adopted authorities for the west wall, 12 Sep.'},
   {n:3,c:'gry',t:'Side setback, west',b:[['unch','Unchecked'],['amb','NO ADJUDICATOR']],cite:'No citation. The section is not in our corpus, so none can be built.',why:'Only the front setback has an adjudicator. This rule is drawn, not built.'},
   {n:4,c:'gry',t:'Rear setback',b:[['unch','Unchecked'],['amb','NO ADJUDICATOR']],cite:'No citation. The section is not in our corpus, so none can be built.',why:'Only the front setback has an adjudicator. This rule is drawn, not built.'},
   {n:5,c:'gry',t:'Permitted use',b:[['unch','Unchecked']],cite:'City of Bastrop Building Block B3 Section 14-02-008 (bastrop_tx-bdc-2026-adopted)',why:'Not a numeric comparison, so there is nothing to adjudicate. Cited, not evaluated.'},
   {n:6,c:'red',t:'Driveway width',b:[['fail','Fail'],['rev','REVIEWER'],['amb','CITATION OWED']],cite:'No citation. The section is not in our corpus, so none can be built.',why:'Added by M. Leavis from C-101. Cannot enter the letter until a section is supplied.'}
  ];
  function badges(b){return b.map(function(x){return '<span class="b '+x[0]+'">'+x[1]+'</span>';}).join('');}
  function finding(f,sel){return '<div class="f'+(sel?' sel':'')+'" data-go="finding"><div class="n '+f.c+'">'+f.n+'</div><div><span class="ft">'+f.t+'</span>'+badges(f.b)+'<div class="cite">'+f.cite+'</div><div class="why">'+f.why+'</div></div></div>';}
  var HEAD='<div class="head"><h1>PR-2026-0418</h1><span class="meta">908 PINE ST \\u00b7 single-family \\u00b7 cycle 1 \\u00b7 edition declared</span></div>';
  function steps(on){return '<div class="steps">'+['Intake','Applicability','Findings','Letter'].map(function(s){return '<span class="'+(s===on?'on':'')+'">'+(s===on?'':'\\u2713 ')+s+'</span>';}).join('\\u2192')+'</div>';}
  var V={
   console:function(inline){
     var list=(inline?F.slice(0,3):F).map(function(f,i){return finding(f,i===0);}).join('');
     return HEAD+steps('Findings')+'<div class="wrap">'
      +'<div class="panel hide-inline"><div class="ph sheets"><u>A-101</u>&nbsp; A-102 &nbsp;A-201 &nbsp;S-101 &nbsp;C-101 &nbsp;E-101 <span class="m" style="margin-left:auto">6 sheets \\u00b7 cycle 1</span></div>'+SHEET+'</div>'
      +'<div class="panel"><div class="ph"><b>Findings</b><span class="m">13 \\u00b7 12 rules in scope plus 1 added by a reviewer</span></div>'
      +'<div class="chips"><span class="chip">All 13</span><span class="chip">Fail 2</span><span class="chip">Uncertain 1</span><span class="chip">Unchecked 9</span><span class="chip">Pass 1</span></div>'
      +list+'<div class="why" style="padding:10px 12px;border-top:1px solid var(--line)">'+(inline?'Showing 3 of 13. Open the full review for the plan sheet, the reasoning and the correction notice.':'Showing 6 of 13. The other seven are Unchecked with no place on a sheet.')+'</div></div></div>';
   },
   finding:function(){
     return '<div class="head"><h1>Finding 1 \\u2014 Front setback</h1><span class="meta">PR-2026-0418 \\u00b7 the one rule with a live adjudicator \\u00b7 pinned to A-101</span> <span class="b fail">Fail</span></div>'+steps('Findings')
      +'<div class="wrap"><div><div class="panel"><div class="ph"><b>How this was reached</b><span class="m">three links, each one breakable</span></div>'
      +'<div class="row"><div class="k">RULE</div><div>Minimum front setback in SF-1 is 25\\u2032-0\\u2033.<div class="cite">City of Bastrop Building Block B3 Section 14-02-003 \\u00b7 edition declared at intake, not derived from the jurisdiction</div></div></div>'
      +'<div class="row"><div class="k">INPUT</div><div>Proposed front setback 22\\u2032-0\\u2033.<div class="cite">Typed into the intake form on 11 Sep. No sheet, no location, no source.</div><div class="warn">Lowest provenance on the ladder. Capturing the same value from the dimension string on A-101 would move it to the top rung.</div></div></div>'
      +'<div class="row"><div class="k">COMPARISON</div><div>22\\u2032-0\\u2033 is less than 25\\u2032-0\\u2033, so the rule is not met.<div class="cite">A numeric comparison, stated so a reviewer can check it by hand.</div></div></div>'
      +'<div class="btns"><button class="btn pri" data-go="letter">Accept into the letter</button><button class="btn">Edit the comment</button><button class="btn dan">Dismiss</button></div></div>'
      +'<div class="panel" style="margin-top:12px"><div class="ph"><b>If you dismiss this</b><span class="m">the reason is the product, not a formality</span></div>'
      +'<div class="opt">The rule does not apply here<i>applicability</i></div><div class="opt">The rule is right, the input is wrong<i>input</i></div><div class="opt">Both are right, the conclusion is not<i>adjudication</i></div><div class="opt" style="margin-bottom:12px">Correct, but I am not citing it<i>judgement</i></div></div></div>'
      +'<div class="panel"><div class="ph"><b>A-101</b><span class="m">pinned at the front setback</span></div>'+SHEET+'</div></div>';
   },
   letter:function(){
     return '<div class="head"><h1>Correction notice</h1><span class="meta">PR-2026-0418 \\u00b7 cycle 1 \\u00b7 draft, not issued</span></div>'+steps('Letter')
      +'<div class="wrap"><div class="panel letter"><h2>Correction notice <span class="meta">PR-2026-0418 \\u00b7 cycle 1 \\u00b7 908 PINE ST</span></h2>'
      +'<p>One item must be corrected before this application can be approved. One further item is escalated to a reviewer and is not a correction. Ten rules in scope could not be evaluated and are listed at the end; none of them is an approval.</p>'
      +'<h3>CORRECTIONS REQUIRED \\u2014 1</h3><div class="item"><b>1.</b><div><b>Front setback</b><div>The proposed front setback of 22\\u2032-0\\u2033 is less than the 25\\u2032-0\\u2033 minimum for the SF-1 district. Revise the site plan or apply for a variance.</div><div class="cite">City of Bastrop Building Block B3 Section 14-02-003 \\u00b7 Sheet A-101 \\u00b7 Automated check, accepted by M. Leavis</div></div></div>'
      +'<h3>ESCALATED, NOT A CORRECTION \\u2014 1</h3><div class="item"><b>2.</b><div><b>Fire separation distance</b><div>A reviewer has recorded that two adopted authorities conflict for the west wall. No action is required from you on this item. The text of the cited section is not reproduced here.</div><div class="cite">2018 International Building Code Section 705.5 (IBC-2018) \\u00b7 Sheet A-101 \\u00b7 reviewer override, 12 Sep</div></div></div>'
      +'<h3>NOT EVALUATED \\u2014 10</h3><p>Five sections are not in our corpus, two were confirmed not to apply here, one is behind a licence we do not hold, one could not be retrieved on this run, and one has no automated check built. <b>None of this is an approval.</b></p></div>'
      +'<div><div class="panel tally"><div class="ph"><b>What goes in</b><span class="m">13 findings</span></div><div><b style="color:var(--red)">1 accepted</b><span>printed as a correction</span></div><div><b style="color:var(--vio)">1 escalated</b><span>own heading, no action asked</span></div><div><b>10 not evaluated</b><span>summarised by reason</span></div><div><b style="color:var(--amb)">1 held back</b><span>reviewer finding with no citation yet</span></div><div style="display:block"><span class="cite">1 + 1 + 10 + 1 = 13</span></div></div>'
      +'<div class="panel" style="margin-top:12px"><div class="ph"><b>Resubmittal manifest</b><span class="m">machine-readable, attached</span></div><pre>{\\n  "engagement": "PR-2026-0418",\\n  "cycle": 1,\\n  "corrections": [\\n    { "finding": 1, "sheet": "A-101",\\n      "bookId": "BASTROP-UDC",\\n      "sectionNumber": "14-02-003" }\\n  ]\\n}</pre></div></div></div>';
   }
  };
  V.codes=function(){
    var did='did:hauska:code-section:icc-model-code/2018-international-building-code-6th-printing/705-5';
    return '<div class="head"><h1>How we treat the code</h1><span class="meta">finding 2 \\u00b7 IBC-2018 Section 705.5 \\u00b7 cited, never republished</span></div>'
     +'<div class="steps"><span class="on">1 Cite</span>\\u2192<span class="on">2 Withhold the text</span>\\u2192<span class="on">3 Meter every reference</span></div>'
     +'<div class="wrap"><div>'
     +'<div class="panel"><div class="ph"><b>1. The formal reference</b><span class="m">what the finding carries</span></div>'
     +'<div class="row"><div class="k">CITATION</div><div>2018 International Building Code, Section 705.5 (IBC-2018)<div class="cite">edition declared at intake \\u00b7 sheet A-101 \\u00b7 finding 2</div></div></div>'
     +'<div class="row"><div class="k">ATOM ID</div><div><span class="cite" style="word-break:break-all">'+did+'</span></div></div>'
     +'<div class="row"><div class="k">CONFIDENCE</div><div><pre style="background:none;padding:0">{ "state": "uncertain",\\n  "basis": "two adopted authorities conflict",\\n  "source": "reviewer override, 12 Sep",\\n  "adjudicator": "reviewer" }</pre></div></div>'
     +'<div class="row"><div class="k">BODY TEXT</div><div><b>None.</b><div class="why">Not stored with the review, not sent to Claude, not printed on the letter. A paraphrase in our words may sit beside the citation; ICC\\u2019s text never does.</div></div></div></div>'
     +'<div class="panel" style="margin-top:12px"><div class="ph"><b>2. What Claude is allowed to read</b><span class="m">our layer sits in between</span></div>'
     +'<pre>get_atom '+did.replace('did:hauska:code-section:','\\u2026')+'\\n  caller: anonymous\\n\\u2192 refused\\n  accessPolicy: platform-internal\\n  returned instead: citation + deep link\\n  codes.iccsafe.org/content/IBC2018#IBC2018P6_Ch07_Sec705.5</pre>'
     +'<div class="why" style="padding:0 12px 12px">A licensed reviewer follows the link to read the section on ICC\\u2019s own site. The model gets the reference and the reasoning, never the book.</div></div>'
     +'</div><div>'
     +'<div class="panel"><div class="ph"><b>3. Every reference is metered</b><span class="m">the usage ledger, per book and section</span></div>'
     +'<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr style="text-align:left;color:var(--mut);font-family:var(--mono);font-size:11px"><th style="padding:8px 12px">SOURCE</th><th>BOOK</th><th>SECTION</th><th style="text-align:right;padding-right:12px">RATE</th></tr></thead><tbody>'
     +[['MCP (this card)','IBC-2018','705.5'],['Plan review UI','IBC-2018','705.5'],['Plan review UI','IBC-2018','1001.1'],['MCP','IBC-2018','1001.1']].map(function(r){return '<tr style="border-top:1px solid var(--line)"><td style="padding:8px 12px">'+r[0]+'</td><td class="cite">'+r[1]+'</td><td class="cite">'+r[2]+'</td><td class="cite" style="text-align:right;padding-right:12px">$0.01</td></tr>';}).join('')
     +'</tbody></table><div class="why" style="padding:10px 12px;border-top:1px solid var(--line)">Illustrative rows. <b>$0.01 is a proof-of-concept fixture, not a quoted price.</b> The live ledger is in the ICC portal\\u2019s activity page.</div></div>'
     +'<div class="panel" style="margin-top:12px"><div class="ph"><b>What the review admits it does not know</b></div>'
     +'<div class="row"><div class="k">UNCERTAIN</div><div>1 \\u00b7 escalated to a reviewer, not guessed</div></div>'
     +'<div class="row"><div class="k">UNCHECKED</div><div>9 \\u00b7 each with its reason: not in corpus, not licensed, no check built</div></div>'
     +'<div class="row"><div class="k">REVIEWER</div><div>Every finding can be accepted, edited or dismissed with a reason. The human stays in the loop.</div></div></div>'
     +'</div></div>';
  };
  var mode='inline', cur='console', rpc=1;
  function post(m){try{parent.postMessage(m,'*');}catch(e){}}
  function fit(){post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:document.documentElement.scrollHeight}});}
  function show(v){
    cur=v;
    document.body.className=mode==='inline'?'inline':'';
    document.getElementById('view').innerHTML=V[v](mode==='inline');
    var tabs=document.querySelectorAll('.tabs button');
    for(var i=0;i<tabs.length;i++){tabs[i].setAttribute('aria-selected',tabs[i].getAttribute('data-v')===v?'true':'false');}
    setTimeout(fit,0);
  }
  function wantFull(v){
    post({jsonrpc:'2.0',id:rpc++,method:'ui/request-display-mode',params:{mode:'fullscreen'}});
    mode='fullscreen';
    show(v||cur);
  }
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-v],[data-go],#expand');
    if(!t) return;
    if(t.id==='expand'){wantFull('console');return;}
    var v=t.getAttribute('data-v')||t.getAttribute('data-go');
    if(mode==='inline'&&v!=='console'){wantFull(v);return;}
    show(v);
  });
  window.addEventListener('message',function(ev){
    var d=ev.data; if(!d||typeof d!=='object') return;
    if(d.id===0&&d.result){post({jsonrpc:'2.0',method:'ui/notifications/initialized'});}
    if(d.method==='ui/notifications/host-context-changed'&&d.params&&d.params.displayMode){
      mode=d.params.displayMode==='fullscreen'?'fullscreen':'inline'; show(cur);
    }
  });
  post({jsonrpc:'2.0',id:0,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'PlanReviewPreview',version:'1'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}}});
  show('console');
  window.addEventListener('resize',fit);
})();
</script>
</body>
</html>`;
}

type ResourceHandler = (uri: { href: string }) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }>;
}>;

type PreviewServer = {
  registerResource?: (name: string, uri: string, config: Record<string, unknown>, handler: ResourceHandler) => void;
  registerTool: (
    name: string,
    config: Record<string, unknown>,
    handler: () => Promise<{
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>,
  ) => void;
};

/** Registers the preview tool and its card only for allow-listed operators. */
export function registerPlanReviewPreview(server: PreviewServer): boolean {
  if (!planReviewPreviewAllowed(getAuthContext()?.email)) return false;
  if (typeof server.registerResource === "function") {
    server.registerResource("Plan review preview", PLAN_REVIEW_PREVIEW_URI, { mimeType: APP_MIME }, async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: APP_MIME,
          text: buildPlanReviewPreviewHtml(),
          _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }));
  }
  server.registerTool(
    PLAN_REVIEW_PREVIEW_TOOL,
    {
      title: "Plan review preview (demo)",
      description:
        "DEMO ONLY. Opens an illustrative ICC-style plan review in the card: the review console (plan sheet with pinned findings), how a finding was reached (rule, input, comparison), and the draft correction notice. Use when the user asks for an ICC review, a plan review, a code review of a plan set, or a plan review preview. The data is a fixed fixture (PR-2026-0418, 908 PINE ST, Bastrop TX); it reviews no real submission, and must be presented as a preview of plan review in Claude, never as a real review or a determination.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PLAN_REVIEW_PREVIEW_URI } },
    },
    async () => ({
      content: [{ type: "text" as const, text: SUMMARY_TEXT }],
      structuredContent: {
        fixture: true,
        engagement: "PR-2026-0418",
        address: "908 PINE ST, Bastrop TX",
        counts: { total: 13, fail: 2, uncertain: 1, unchecked: 9, pass: 1 },
      },
    }),
  );
  return true;
}
