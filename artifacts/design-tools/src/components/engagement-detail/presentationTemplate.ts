import type { TabId } from "./urlState";

/**
 * Client presentation deck — page-type catalog (UI shell).
 *
 * Models a downloadable interior-design-style presentation template:
 * neutral layout system, ~30 duplicatable pages, PDF export, and a
 * future Canva handoff. Each page type maps to engagement atoms the
 * assembler will pull when the backend ships.
 */
export type PresentationPageCategory =
  | "intro"
  | "concept"
  | "spatial"
  | "spec"
  | "close";

export interface PresentationPageType {
  id: string;
  label: string;
  description: string;
  /** Layout hint shown in slide preview (grid, full-bleed, etc.). */
  layoutHint: string;
  category: PresentationPageCategory;
  /** Template pages emitted when this block is included (Canva-style duplication). */
  templatePages: number;
  sources: ReadonlyArray<{ kind: string; label: string }>;
}

export const PRESENTATION_TEMPLATE_META = {
  title: "Client presentation template",
  subtitle:
    "Slide-based deck for e-design and remote client review — not technical plan-check documentation.",
  pageTarget: "~30 pages",
  outputs: ["PDF download", "Canva edit link (planned)"],
  aesthetic:
    "Minimal neutral frame; swap lifestyle imagery, palette swatches, typography, and studio logo per project.",
} as const;

export const PRESENTATION_PAGE_CATEGORIES: ReadonlyArray<{
  id: PresentationPageCategory;
  label: string;
}> = [
  { id: "intro", label: "Intro" },
  { id: "concept", label: "Concept" },
  { id: "spatial", label: "Plans & rooms" },
  { id: "spec", label: "Materials & FF&E" },
  { id: "close", label: "Close" },
];

/** Default page types included in a new deck draft. */
export const DEFAULT_PRESENTATION_PAGE_IDS: ReadonlyArray<string> = [
  "cover",
  "concept",
  "moodboard",
  "palette",
  "floor-plan",
  "room-overview",
  "furniture",
  "next-steps",
];

export const PRESENTATION_PAGE_TYPES: ReadonlyArray<PresentationPageType> = [
  {
    id: "cover",
    label: "Cover",
    description:
      "Project name, site address, presenter, and studio logo on a full-bleed hero frame.",
    layoutHint: "Full-bleed cover · logo + title lockup",
    category: "intro",
    templatePages: 1,
    sources: [{ kind: "META", label: "engagement details" }],
  },
  {
    id: "concept",
    label: "Concept summary",
    description:
      "One-page narrative: design direction, goals, and how the palette supports the brief.",
    layoutHint: "Split text + hero image",
    category: "concept",
    templatePages: 2,
    sources: [
      { kind: "BRIEF", label: "design narrative" },
      { kind: "META", label: "project type" },
    ],
  },
  {
    id: "moodboard",
    label: "Moodboard grid",
    description:
      "Style, texture, and inspiration collage — living room lifestyle shots and material cues.",
    layoutHint: "2×2 or 3×2 image grid",
    category: "concept",
    templatePages: 4,
    sources: [
      { kind: "IMG", label: "pinned inspiration" },
      { kind: "RENDER", label: "hero renderings" },
    ],
  },
  {
    id: "palette",
    label: "Color & finishes palette",
    description:
      "Swatches for paint, stone, wood, metal, and textile finishes with short callouts.",
    layoutHint: "Swatch row + caption strip",
    category: "concept",
    templatePages: 2,
    sources: [{ kind: "SPEC", label: "finish selections" }],
  },
  {
    id: "floor-plan",
    label: "Floor plan panel",
    description:
      "Annotated plan graphic with room labels, dimensions, and key circulation notes.",
    layoutHint: "Plan full-width · legend sidebar",
    category: "spatial",
    templatePages: 3,
    sources: [
      { kind: "SHEET", label: "A-series plans" },
      { kind: "BIM", label: "level snapshots" },
    ],
  },
  {
    id: "room-overview",
    label: "Room overviews",
    description:
      "Per-space spreads: perspective or elevation plus a short FF&E summary line.",
    layoutHint: "One room per spread · image + bullet list",
    category: "spatial",
    templatePages: 6,
    sources: [
      { kind: "RENDER", label: "room renders" },
      { kind: "BIM", label: "3D walk captures" },
    ],
  },
  {
    id: "furniture",
    label: "FF&E / furniture board",
    description:
      "Furniture, fixtures, and equipment selections with vendor, finish, and alternates.",
    layoutHint: "Product grid · cut-sheet thumbs",
    category: "spec",
    templatePages: 4,
    sources: [{ kind: "ICC", label: "product specs & FF&E" }],
  },
  {
    id: "materials",
    label: "Materials board",
    description:
      "Countertops, tile, flooring, and hardware samples with installation notes.",
    layoutHint: "Sample chips · detail photos",
    category: "spec",
    templatePages: 3,
    sources: [{ kind: "SPEC", label: "material callouts" }],
  },
  {
    id: "site-context",
    label: "Site context (optional)",
    description:
      "Parcel map, regulatory flood context, and jurisdiction summary for architect-led reviews.",
    layoutHint: "Map inset + briefing excerpt",
    category: "spatial",
    templatePages: 2,
    sources: [
      { kind: "BRIEF", label: "Property Intel briefing" },
      { kind: "GIS", label: "parcel map" },
    ],
  },
  {
    id: "next-steps",
    label: "Next steps & CTA",
    description:
      "Timeline, decisions needed from the client, and contact / approval call to action.",
    layoutHint: "Checklist + contact footer",
    category: "close",
    templatePages: 2,
    sources: [{ kind: "META", label: "engagement timeline" }],
  },
];

export function countTemplatePages(
  selectedIds: ReadonlySet<string> | Iterable<string>,
): number {
  const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return PRESENTATION_PAGE_TYPES.filter((p) => set.has(p.id)).reduce(
    (sum, p) => sum + p.templatePages,
    0,
  );
}

/** Where to edit upstream content for a page type. */
export const PRESENTATION_PAGE_SOURCE_TAB: Partial<Record<string, TabId>> = {
  concept: "property-intel",
  moodboard: "renders",
  palette: "product-specs",
  "floor-plan": "sheets",
  "room-overview": "renders",
  furniture: "product-specs",
  materials: "product-specs",
  "site-context": "property-intel",
  renders: "renders",
};
