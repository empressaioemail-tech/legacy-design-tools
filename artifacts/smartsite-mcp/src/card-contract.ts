/**
 * P-437. Tells the model which MCP App card (if any) matches the inline widget,
 * so it never claims a board when only a single-parcel panel is on screen.
 */

export type CardView =
  | "single-parcel"
  | "parcel-set"
  | "screen-board"
  | "screen-list"
  | "none";

export const CARD_CONTRACT_TEXT_ONLY_NOTE =
  "On hosts that do not render MCP Apps (for example Claude in Chrome on third-party sites), no inline card is shown — use the text and JSON in this result only.";

const SENTENCES: Record<CardView, string> = {
  "single-parcel":
    "Card contract: the inline Smart Site panel shows one parcel (map and report rails). Do not describe a screening board.",
  "parcel-set":
    "Card contract: the inline Smart Site panel shows a map selection with multiple parcels. Do not describe a single-parcel-only view or an empty board.",
  "screen-board":
    "Card contract: the inline Smart Site panel shows a screening board table. Do not describe a single-parcel map unless the user opens a row.",
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
  if (toolName === "find_parcel" || toolName === "find_parcels") {
    if (Array.isArray(data.parcels) && data.parcels.length >= 2) return "parcel-set";
    if (data.draw || data.parcelNodeId) return "single-parcel";
    if (Array.isArray(data.parcels) && data.parcels.length === 1) return "single-parcel";
    if (typeof data.mapPanelNote === "string") return "single-parcel";
    return "single-parcel";
  }
  return "none";
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
    const data = JSON.parse(text) as Record<string, unknown>;
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
