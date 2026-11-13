import { SMARTSITE_VOICE_LINE } from "./voice.js";
/**
 * P-437. Tells the model which MCP App card (if any) matches the inline widget,
 * so it never claims a board when only a single-parcel panel is on screen.
 */

export type CardView =
  | "single-parcel"
  | "parcel-set"
  | "screen-board"
  | "screen-list"
  | "note"
  | "none";

export const CARD_CONTRACT_TEXT_ONLY_NOTE =
  "On hosts that do not render MCP Apps (for example Claude in Chrome on third-party sites), no inline card is shown — use the text and JSON in this result only.";

const SENTENCES: Record<CardView, string> = {
  "single-parcel":
    "Card contract: the inline Smart Site panel shows one parcel (map and report rails). Do not describe a screening board.",
  "parcel-set":
    "Card contract: the inline Smart Site panel shows the parcels you asked about side by side as a grid with a map. Do not describe a single-parcel-only view or an empty board.",
  "screen-board":
    "Card contract: the inline Smart Site panel shows a screening board table with one row per parcel (the parcels found by a search, the neighbours, or the rows of a screen). It is not a single-parcel map and not a saved screen unless the result says so; the user opens a row to see one parcel.",
  note:
    "Card contract: the inline Smart Site panel shows one short note (no parcel matched, or the request was refused). It shows no map, parcel or table. Do not describe one.",
  "screen-list":
    "Card contract: the inline Smart Site panel lists saved screens to reopen. It is not a parcel map or a screening table yet.",
  none: `Card contract: this tool result does not open the Smart Site MCP App card. ${CARD_CONTRACT_TEXT_ONLY_NOTE}`,
};

export function cardContractSentence(view: CardView): string {
  return SENTENCES[view];
}

/** Infer the card the app will paint from a parsed tool JSON body. */
export function cardViewFromToolPayload(
  toolName: string,
  data: Record<string, unknown>,
): CardView {
  if (toolName === "get_smart_site") {
    if (Array.isArray(data.parcels) && data.parcels.length >= 2) return "parcel-set";
    if (data.parcelNodeId || (Array.isArray(data.parcels) && data.parcels.length === 1)) {
      return "single-parcel";
    }
    if (Array.isArray(data.rows)) return "screen-board";
    return "single-parcel";
  }
  if (toolName === "create_screen" || toolName === "list_screens") {
    if (Array.isArray(data.screens) && !data.rows && !data.screen) return "screen-list";
    const screen = asScreen(data);
    if (screen && Array.isArray(screen.rows)) return "screen-board";
    if (Array.isArray(data.rows)) return "screen-board";
    return "screen-board";
  }
  if (
    toolName === "find_parcel" ||
    toolName === "find_parcels" ||
    toolName === "find_nearest_parcels"
  ) {
    if (
      data.status === "refused" ||
      data.status === "upgrade_required" ||
      data.status === "degraded"
    ) {
      return "note";
    }
    const found = foundParcelCount(data);
    if (found >= 2) return "screen-board";
    if (found === 1) return "single-parcel";
    if (data.draw || data.parcelNodeId) return "single-parcel";
    return "note";
  }
  return "none";
}

/** How many parcels a search result names, whichever field carries them. */
export function foundParcelCount(data: Record<string, unknown>): number {
  const lists: unknown[] = [data.parcels, data.hits, data.nearestNeighbors];
  const matched = data.matched ?? data.constraintMatched;
  if (Array.isArray(matched)) lists.push(matched);
  else if (matched && typeof matched === "object") {
    const rec = matched as Record<string, unknown>;
    lists.push(rec.parcels);
    if (typeof rec.count === "number" && Array.isArray(rec.parcels) === false) {
      return rec.count;
    }
  }
  let best = 0;
  for (const l of lists) if (Array.isArray(l)) best = Math.max(best, l.length);
  return best;
}

function asScreen(data: Record<string, unknown>): Record<string, unknown> | null {
  const screen = data.screen;
  return screen && typeof screen === "object" && !Array.isArray(screen)
    ? (screen as Record<string, unknown>)
    : null;
}

export function injectCardContract(text: string, view: CardView): { text: string; view: CardView } {
  const sentence = cardContractSentence(view);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // answerGuidance leads the result so Claude reads it before the data (voice.ts).
    const data: Record<string, unknown> = view === "none" ? { ...parsed } : { answerGuidance: SMARTSITE_VOICE_LINE, ...parsed };
    data.cardContract = view;
    data.cardContractText = sentence;
    return { text: JSON.stringify(data), view };
  } catch {
    return { text: `${text.trim()}\n\n${sentence}`, view };
  }
}

export function appendCardContractProse(prose: string, view: CardView): string {
  return `${prose.trim()}\n\n${cardContractSentence(view)}`;
}
