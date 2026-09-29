/**
 * Plan precheck view for the Smart Site card (ICC preview, operator-only).
 * Content follows the SmartCity design canvas artboards PrecheckStart and
 * PrecheckFindings; the layout is the card's own (well, btn, af-acts, the
 * ss- theme tokens), inline and in the fullscreen deep view.
 */
import { escapeHtml } from "./panel-lib.js";

export type PrecheckStatus = "suggestion" | "not-read" | "city-reviews" | "no-issue";

export type PrecheckFinding = {
  n: number;
  title: string;
  status: PrecheckStatus;
  /** the reading on the sheet, e.g. 22'-0" */
  reading?: string;
  /** the rule's figure, e.g. 25'-0" minimum */
  rule?: string;
  sheet?: string;
  note: string;
  citation?: string;
};

export type PrecheckData = {
  address: string;
  city: string;
  parcelNodeId: string;
  project: string;
  precheckId: string;
  version: string;
  when: string;
  lot: { label: string; value: string; source: string }[];
  sheets: string[];
  findings: PrecheckFinding[];
};

const STATUS_WORD: Record<PrecheckStatus, string> = {
  suggestion: "Suggestion",
  "not-read": "Could not read",
  "city-reviews": "City reviews",
  "no-issue": "No issue",
};

function pill(status: PrecheckStatus): string {
  return `<span class="pc-pill" data-pc="${status}">${STATUS_WORD[status]}</span>`;
}

function count(p: PrecheckData, s: PrecheckStatus): number {
  return p.findings.filter((f) => f.status === s).length;
}

function tilesHtml(p: PrecheckData): string {
  const suggested = count(p, "suggestion") + count(p, "not-read");
  const tiles: [string, number, string, string][] = [
    ["Suggested", suggested, "yours to fix or leave open", "suggestion"],
    ["City reviews", count(p, "city-reviews"), "not checked here", "city-reviews"],
    ["No issue", count(p, "no-issue"), "against the rule named", "no-issue"],
    ["Checks", p.findings.length, `${suggested} + ${count(p, "city-reviews")} + ${count(p, "no-issue")}`, "all"],
  ];
  return (
    `<div class="pc-tiles">` +
    tiles
      .map(
        ([k, v, sub, s]) =>
          `<div class="pc-tile" data-pc="${s}"><div class="pc-tk">${escapeHtml(k)}</div><div class="pc-tv">${v}</div><div class="pc-ts">${escapeHtml(sub)}</div></div>`,
      )
      .join("") +
    `</div>`
  );
}

function headHtml(p: PrecheckData): string {
  return (
    `<div class="pc-head"><div class="pc-addr">${escapeHtml(p.address)}</div>` +
    `<div class="pc-meta">${escapeHtml(p.city)} · ${escapeHtml(p.project)} · ${escapeHtml(p.precheckId)} · ${escapeHtml(p.version)}` +
    ` <span class="pc-fixture">FIXTURE</span></div></div>`
  );
}

function lotHtml(p: PrecheckData): string {
  return (
    `<div class="pc-lot">` +
    p.lot
      .map(
        (l) =>
          `<div class="pc-fact"><div class="pc-fk">${escapeHtml(l.label)}</div><div class="pc-fv">${escapeHtml(l.value)}</div><div class="pc-src">${escapeHtml(l.source)}</div></div>`,
      )
      .join("") +
    `</div>`
  );
}

const AI_NOTE =
  "AI reading: every number was read from the drawings by software and has not been checked by a person. It is a self-check before you apply, not a plan review, a permit or an approval.";

function findingRow(f: PrecheckFinding, open: boolean): string {
  const figures =
    f.reading || f.rule
      ? `<div class="pc-fig">${f.reading ? `<span>read <b>${escapeHtml(f.reading)}</b></span>` : ""}${f.rule ? `<span>rule <b>${escapeHtml(f.rule)}</b></span>` : ""}${f.sheet ? `<span class="pc-sheet">${escapeHtml(f.sheet)}</span>` : ""}</div>`
      : f.sheet
        ? `<div class="pc-fig"><span class="pc-sheet">${escapeHtml(f.sheet)}</span></div>`
        : "";
  return (
    `<details class="pc-row" data-pc="${f.status}"${open ? " open" : ""}>` +
    `<summary><span class="pc-n" data-pc="${f.status}">${f.n}</span><span class="pc-rt">${escapeHtml(f.title)}</span>${pill(f.status)}</summary>` +
    `<div class="pc-body"><div class="pc-note">${escapeHtml(f.note)}</div>${figures}` +
    (f.citation ? `<div class="pc-cite">${escapeHtml(f.citation)}</div>` : "") +
    `</div></details>`
  );
}

function group(p: PrecheckData, title: string, sub: string, statuses: PrecheckStatus[], openFirst: boolean): string {
  const rows = p.findings.filter((f) => statuses.includes(f.status));
  if (!rows.length) return "";
  return (
    `<div class="pc-group"><div class="req">${escapeHtml(title)} <span class="pc-gs">${rows.length} · ${escapeHtml(sub)}</span></div>` +
    rows.map((f, i) => findingRow(f, openFirst && i === 0)).join("") +
    `</div>`
  );
}

/** Inline: lot, tiles and the suggestions; the rest one click away. */
export function precheckInlineHtml(p: PrecheckData): string {
  const suggestions = p.findings.filter((f) => f.status === "suggestion" || f.status === "not-read");
  const others = p.findings.length - suggestions.length;
  return (
    headHtml(p) +
    `<div class="well">` +
    lotHtml(p) +
    tilesHtml(p) +
    `<div class="req">Suggested before you submit</div>` +
    suggestions.map((f, i) => findingRow(f, i === 0)).join("") +
    `<div class="pc-more">${others} more: ${count(p, "city-reviews")} the city reviews, ${count(p, "no-issue")} with no issue found.</div>` +
    `<div class="pc-ai">${escapeHtml(AI_NOTE)}</div>` +
    `</div>` +
    `<div class="af-acts"><button type="button" class="btn primary" data-act="precheck-open" onclick="window.__ss&&window.__ss.expand(this)">Open findings</button>` +
    `<button type="button" class="btn" disabled title="Preview only">Upload a revised set</button></div>`
  );
}

function sheetSvg(p: PrecheckData): string {
  const pin = (x: number, y: number, n: number, s: PrecheckStatus) =>
    `<g class="pc-pin" data-pc="${s}"><circle cx="${x}" cy="${y}" r="11"/><text x="${x}" y="${y + 4}" text-anchor="middle">${n}</text></g>`;
  const st = (n: number) => p.findings.find((f) => f.n === n)?.status ?? "no-issue";
  return (
    `<svg class="pc-svg" viewBox="0 0 440 460" role="img" aria-label="Site plan A-101 with the numbered checks">` +
    `<rect x="70" y="20" width="300" height="360" class="pc-lotline"/>` +
    `<rect x="120" y="120" width="200" height="170" class="pc-house"/>` +
    `<text x="220" y="200" text-anchor="middle" class="pc-hl">PROPOSED RESIDENCE</text>` +
    `<text x="220" y="218" text-anchor="middle" class="pc-dim">60′ × 48′ · 2,880 SF</text>` +
    `<line x1="220" y1="20" x2="220" y2="120" class="pc-dash"/><line x1="220" y1="290" x2="220" y2="380" class="pc-dash pc-dash-hot"/>` +
    `<line x1="70" y1="205" x2="120" y2="205" class="pc-dash"/><line x1="320" y1="205" x2="370" y2="205" class="pc-dash"/>` +
    `<text x="240" y="62" class="pc-dim">20′-0″ REAR</text><text x="240" y="352" class="pc-dim pc-hot">22′-0″ FRONT</text>` +
    `<text x="12" y="200" class="pc-dim">6′-0″</text><text x="12" y="214" class="pc-dim">SIDE W</text>` +
    `<text x="378" y="200" class="pc-dim">14′-0″</text><text x="378" y="214" class="pc-dim">SIDE E</text>` +
    pin(220, 340, 1, st(1)) + pin(120, 205, 2, st(2)) + pin(320, 205, 3, st(3)) + pin(220, 70, 4, st(4)) + pin(138, 138, 6, st(6)) +
    `<rect x="40" y="400" width="360" height="36" class="pc-street"/><text x="220" y="423" text-anchor="middle" class="pc-dim" letter-spacing="3">PINE STREET</text>` +
    `</svg>`
  );
}

/** Fullscreen: the sheet with its pins beside every finding, grouped as the design groups them. */
export function precheckDeepHtml(p: PrecheckData): string {
  return (
    headHtml(p) +
    `<div class="well">` +
    tilesHtml(p) +
    `<div class="pc-ai">${escapeHtml(AI_NOTE)}</div>` +
    `<div class="pc-split"><div class="pc-sheetcol"><div class="req">${p.sheets.map((s, i) => (i === 0 ? `<b>${escapeHtml(s)}</b>` : escapeHtml(s))).join(" · ")}</div>${sheetSvg(p)}<div class="pc-cap">A-101 site plan · pins are the numbered checks</div></div>` +
    `<div class="pc-listcol">` +
    group(p, "Suggested before you submit", "you can fix these, or submit anyway", ["suggestion", "not-read"], true) +
    group(p, "The city reviews these", "not checked here, each with its reason", ["city-reviews"], false) +
    group(p, "No issue found", "checked against the rule named", ["no-issue"], false) +
    `</div></div></div>` +
    `<div class="af-acts"><button type="button" class="btn" data-act="precheck-back" onclick="window.__ss&&window.__ss.collapse(this)">Back</button>` +
    `<button type="button" class="btn" disabled title="Preview only">Download findings</button>` +
    `<button type="button" class="btn primary" disabled title="Preview only">Continue to submit</button></div>`
  );
}

export const PRECHECK_CARD_TITLE = "Plan precheck";
