/**
 * P-466. Prints `inlineCard` already on the model. Does not compose the
 * answer, the facts, or a figure. Layout follows the v2 handback.
 */
import {
  type InlineCard,
  type OverlayRow,
  type PanelAnchor,
  type PanelAnchorRead,
  type PanelModel,
  type PanelParcel,
  type RingPt,
  escapeHtml,
  floodOverlayOf,
  groundLayerHtml,
  groundPlan,
  mapboxAttributionHtml,
  ringSvg,
  LOADING_PANEL_TITLE,
} from "./panel-lib.js";

const ENVELOPE_AREA_UNSTATED = "Modelled from the setback table on record. The area is not stated.";

const LOGO =
  `<div class="ss-brand" data-wordmark="1">` +
  `<svg class="ss-mark" width="16" height="16" viewBox="0 0 76 76" fill="none" aria-hidden="true">` +
  `<circle cx="38" cy="38" r="26" stroke="currentColor" stroke-width="6"></circle>` +
  `<line x1="38" y1="2" x2="38" y2="16" stroke="currentColor" stroke-width="6"></line>` +
  `<line x1="38" y1="60" x2="38" y2="74" stroke="currentColor" stroke-width="6"></line>` +
  `<line x1="2" y1="38" x2="16" y2="38" stroke="currentColor" stroke-width="6"></line>` +
  `<line x1="60" y1="38" x2="74" y2="38" stroke="currentColor" stroke-width="6"></line>` +
  `<circle cx="38" cy="38" r="7" fill="#E8963B" stroke="none"></circle>` +
  `</svg>` +
  `<span class="ss-smart">SMART</span> <span class="ss-site">SITE</span>` +
  `</div>`;

export function markerHtml(state: string): string {
  const s = state === "not-read" || state === "unread" ? "unread" : state === "absent-verified" || state === "absent" ? "absent" : state;
  return `<span class="ss-marker" data-marker="${escapeHtml(s)}" aria-hidden="true"></span>`;
}

function envelopeOf(overlays: OverlayRow[]): OverlayRow | null {
  for (const o of overlays) {
    if (o.id === "envelope" && o.geom && o.geom.length >= 3) return o;
    if (o.draw === "inset-fill" && o.state === "present" && o.geom && o.geom.length >= 3) return o;
  }
  return null;
}

function envelopeNamed(overlays: OverlayRow[]): OverlayRow | null {
  for (const o of overlays) if (o.id === "envelope") return o;
  return null;
}

function aerialHtml(
  ring: RingPt[],
  anchor: PanelAnchor | null | undefined,
  anchorRead: PanelAnchorRead | null | undefined,
  overlays: OverlayRow[],
  thumb: boolean,
): { html: string; credited: boolean } {
  const drawn = envelopeOf(overlays);
  const geom = drawn?.geom && drawn.geom.length >= 3 ? drawn.geom : null;
  const flood = floodOverlayOf(overlays);
  const svg = ringSvg(ring, [], {
    quiet: true,
    envelope: geom,
    flood,
    paintFlood: !!flood,
  });
  if (!svg) {
    return {
      html:
        `<div class="af-aerial af-aerial-none" data-aerial="absent">` +
        LOGO +
        `<p class="af-outline">Parcel outline not on this read</p>` +
        `</div>`,
      credited: false,
    };
  }
  const outcome = groundPlan(ring, anchor ?? null, anchorRead ?? null);
  const layer = outcome.plan ? groundLayerHtml(outcome.plan) : "";
  const cls = thumb ? "gwrap af-aerial af-thumb" : "gwrap af-aerial";
  const chip = `<div class="ss-chip">${LOGO}</div>`;
  const gis = `<div class="ss-gis">GIS-approximate</div>`;
  const undrawn = !geom && envelopeNamed(overlays) ? `<div class="ss-mapnote" data-envelope="undrawn">No envelope drawn</div>` : "";
  const credit = layer ? "" : `<p class="af-credit" data-aerial="absent">No aerial on this result</p>`;
  const env = geom
    ? `<p class="af-credit" data-envelope="modelled">${escapeHtml(drawn?.basisDisplayText || ENVELOPE_AREA_UNSTATED)}</p>`
    : "";
  return {
    html:
      `<div class="${cls}" data-ground="${layer ? "on" : "off"}">${layer}${svg}${chip}${gis}${undrawn}</div>${credit}${env}`,
    credited: !!layer,
  };
}

function factsHtml(card: InlineCard): string {
  const facts = card.facts.slice(0, 4);
  if (!facts.length) return "";
  const tiles = facts
    .map((f, i) => {
      const detail = f.detail ? escapeHtml(f.detail) : "Source is not on this result.";
      return (
        `<button type="button" class="ss-tile" data-act="tile" data-i="${i}" data-state="${escapeHtml(f.state)}" onclick="window.__ss&&window.__ss.tile(this)">` +
        `<span class="ss-tile-k">${escapeHtml(f.label)}</span>` +
        `<span class="ss-tile-v">${markerHtml(f.state)}<span class="af-v">${escapeHtml(f.value)}</span></span>` +
        `<span class="ss-tile-detail" hidden>${detail}</span>` +
        `</button>`
      );
    })
    .join("");
  return `<div class="ss-tiles" data-tiles="${facts.length}">${tiles}</div><div class="ss-source" data-source-open="0" hidden></div>`;
}

function actionButtons(card: InlineCard, single: boolean): string {
  if (!single) return "";
  const expand = `<button type="button" class="btn primary" data-act="expand" onclick="window.__ss&&window.__ss.expand(this)">Expand map</button>`;
  const share = card.shareUrl
    ? `<button type="button" class="btn" data-act="share" data-url="${escapeHtml(card.shareUrl)}" onclick="window.__ss&&window.__ss.share(this)">Share</button>`
    : `<button type="button" class="btn" data-act="share" disabled data-state="absent">Share</button>`;
  const note = !card.shareUrl ? `<p class="af-note" data-state="absent">Card page link is not on this result.</p>` : "";
  return `<div class="af-acts">${expand}${share}</div>${note}`;
}

export function answerFirstSingleHtml(model: PanelModel): string {
  const card = model.inlineCard;
  if (!card) return "";
  const aerial = aerialHtml(model.ring ?? [], model.anchor, model.anchorRead, model.overlays, false);
  const address = card.title ? `<p class="ss-address">${escapeHtml(card.title)}</p>` : "";
  return (
    `<div class="af" data-inline="1" data-layout="single">` +
    aerial.html +
    `<div class="ss-body">` +
    address +
    `<p class="af-answer" data-answer="1">${escapeHtml(card.answer)}</p>` +
    factsHtml(card) +
    `</div>` +
    actionButtons(card, true) +
    `</div>`
  );
}

export function answerFirstCarouselHtml(model: PanelModel): string {
  const card = model.inlineCard;
  if (!card) return "";
  let anyCredit = false;
  const slides = card.items
    .map((item) => {
      const parcel = parcelById(model, item.parcelNodeId);
      const aerial = parcel
        ? aerialHtml(parcel.ring, parcel.anchor, parcel.anchorRead, [], true)
        : {
            html:
              `<div class="af-aerial af-aerial-none" data-aerial="absent"><p class="af-outline">Parcel outline not on this read</p></div>`,
            credited: false,
          };
      if (aerial.credited) anyCredit = true;
      const open = item.actionUrl
        ? `<button type="button" class="btn primary" data-act="open" data-url="${escapeHtml(item.actionUrl)}"${item.parcelNodeId ? ` data-node="${escapeHtml(item.parcelNodeId)}"` : ""} onclick="window.__ss&&window.__ss.open(this)">Open</button>`
        : item.parcelNodeId
          ? `<button type="button" class="btn primary" data-act="open" data-node="${escapeHtml(item.parcelNodeId)}" onclick="window.__ss&&window.__ss.open(this)">Open</button>`
          : `<button type="button" class="btn" data-act="open" disabled data-state="absent">Open</button>`;
      return (
        `<article class="af-slide" data-inline-item="1">` +
        aerial.html +
        `<p class="af-answer">${escapeHtml(item.answer)}</p>` +
        `<div class="af-acts">${open}</div>` +
        `</article>`
      );
    })
    .join("");
  const more =
    card.moreCount > 0
      ? `<p class="af-note" data-more="${card.moreCount}">${card.moreCount} more on the card page.</p>`
      : "";
  const credit = anyCredit
    ? `<div class="ss-row-credit" data-mapbox-row="1">${mapboxAttributionHtml()}</div>`
    : "";
  return (
    `<div class="af" data-inline="1" data-layout="carousel" data-items="${card.items.length}">` +
    `<p class="af-answer" data-answer="1">${escapeHtml(card.answer)}</p>` +
    `<div class="af-carousel">${slides}</div>` +
    credit +
    more +
    `</div>`
  );
}

function parcelById(model: PanelModel, id: string): PanelParcel | null {
  if (!id || !model.parcels) return null;
  return model.parcels.find((p) => p.parcelNodeId === id) ?? null;
}

export function loadingSkeletonHtml(): string {
  return (
    `<div class="af-skel" data-loading="1" aria-busy="true">` +
    `<span class="ss-clip">${LOADING_PANEL_TITLE}</span>` +
    `<div class="ss-skel-map">${LOGO}</div>` +
    `<div class="ss-body">` +
    `<div class="sk sk-short"></div>` +
    `<div class="sk"></div>` +
    `<div class="sk sk-short"></div>` +
    `<div class="ss-tiles">` +
    `<div class="sk sk-tile"></div><div class="sk sk-tile"></div>` +
    `<div class="sk sk-tile"></div><div class="sk sk-tile"></div>` +
    `</div></div>` +
    `<div class="af-acts"><div class="sk sk-btn"></div><div class="sk sk-btn"></div></div>` +
    `</div>`
  );
}
