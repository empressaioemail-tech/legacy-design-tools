/**
 * P-448. Renders `inlineCard` already on the model. Does not compose the
 * answer, the facts, or a figure.
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
  groundLayerHtml,
  groundPlan,
  ringSvg,
} from "./panel-lib.js";

function aerialHtml(
  ring: RingPt[],
  anchor: PanelAnchor | null | undefined,
  anchorRead: PanelAnchorRead | null | undefined,
  envelope: RingPt[] | null,
  thumb: boolean,
): string {
  const svg = ringSvg(ring, [], { quiet: true, envelope });
  if (!svg) {
    return `<div class="af-aerial af-aerial-none" data-aerial="absent">No aerial on this result</div>`;
  }
  const outcome = groundPlan(ring, anchor ?? null, anchorRead ?? null);
  const layer = outcome.plan ? groundLayerHtml(outcome.plan) : "";
  const cls = thumb ? "gwrap af-aerial af-thumb" : "gwrap af-aerial";
  const credit = layer
    ? `<p class="af-credit">Aerial: Esri World Imagery. Capture date not stated.</p>`
    : `<p class="af-credit" data-aerial="absent">No aerial on this result</p>`;
  const env = envelope && envelope.length >= 3
    ? `<p class="af-credit" data-envelope="modelled">Modelled from setbacks. Area not shown.</p>`
    : "";
  return `<div class="${cls}" data-ground="${layer ? "on" : "off"}">${layer}${svg}</div>${credit}${env}`;
}

function envelopeOf(overlays: OverlayRow[]): RingPt[] | null {
  for (const o of overlays) {
    if (o.draw === "inset-fill" && o.state === "present" && o.geom && o.geom.length >= 3) return o.geom;
  }
  return null;
}

function parcelById(model: PanelModel, id: string): PanelParcel | null {
  if (!id || !model.parcels) return null;
  return model.parcels.find((p) => p.parcelNodeId === id) ?? null;
}

function factsHtml(card: InlineCard): string {
  if (!card.facts.length) return "";
  const rows = card.facts
    .map(
      (f) =>
        `<li data-state="${escapeHtml(f.state)}"><span class="af-k">${escapeHtml(f.label)}</span> <span class="af-v">${escapeHtml(f.value)}</span></li>`,
    )
    .join("");
  return `<ul class="af-facts">${rows}</ul>`;
}

function actionButtons(card: InlineCard, single: boolean): string {
  if (!single) return "";
  const expand = card.expandUrl
    ? `<button type="button" class="btn primary" data-act="expand" data-url="${escapeHtml(card.expandUrl)}" onclick="window.__ss&&window.__ss.expand(this)">Expand map</button>`
    : `<button type="button" class="btn primary" data-act="expand" disabled data-state="absent">Expand map</button>`;
  const share = card.shareUrl
    ? `<button type="button" class="btn" data-act="share" data-url="${escapeHtml(card.shareUrl)}" onclick="window.__ss&&window.__ss.share(this)">Share</button>`
    : `<button type="button" class="btn" data-act="share" disabled data-state="absent">Share</button>`;
  const note =
    !card.expandUrl || !card.shareUrl
      ? `<p class="af-note" data-state="absent">Card page link is not on this result.</p>`
      : "";
  return `<div class="af-acts">${expand}${share}</div>${note}`;
}

export function answerFirstSingleHtml(model: PanelModel): string {
  const card = model.inlineCard;
  if (!card) return "";
  const aerial = aerialHtml(
    model.ring ?? [],
    model.anchor,
    model.anchorRead,
    envelopeOf(model.overlays),
    false,
  );
  return (
    `<div class="af" data-inline="1" data-layout="single">` +
    `<p class="af-answer" data-answer="1">${escapeHtml(card.answer)}</p>` +
    factsHtml(card) +
    aerial +
    actionButtons(card, true) +
    `</div>`
  );
}

export function answerFirstCarouselHtml(model: PanelModel): string {
  const card = model.inlineCard;
  if (!card) return "";
  const slides = card.items
    .map((item) => {
      const parcel = parcelById(model, item.parcelNodeId);
      const aerial = parcel
        ? aerialHtml(parcel.ring, parcel.anchor, parcel.anchorRead, null, true)
        : `<div class="af-aerial af-aerial-none" data-aerial="absent">No aerial on this result</div>`;
      const open = item.actionUrl
        ? `<button type="button" class="btn primary" data-act="open" data-url="${escapeHtml(item.actionUrl)}"${item.parcelNodeId ? ` data-node="${escapeHtml(item.parcelNodeId)}"` : ""} onclick="window.__ss&&window.__ss.open(this)">Open</button>`
        : item.parcelNodeId
          ? `<button type="button" class="btn primary" data-act="open" data-node="${escapeHtml(item.parcelNodeId)}" onclick="window.__ss&&window.__ss.open(this)">Open</button>`
          : `<button type="button" class="btn" data-act="open" disabled data-state="absent">Open</button>`;
      return (
        `<article class="af-slide" data-inline-item="1">` +
        aerial +
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
  return (
    `<div class="af" data-inline="1" data-layout="carousel" data-items="${card.items.length}">` +
    `<p class="af-answer" data-answer="1">${escapeHtml(card.answer)}</p>` +
    `<div class="af-carousel">${slides}</div>` +
    more +
    `</div>`
  );
}
