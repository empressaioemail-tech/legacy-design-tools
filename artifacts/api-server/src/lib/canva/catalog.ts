/**
 * Dev / non-Enterprise fallback brand templates when Canva API is
 * unavailable. Shape matches portal-ui `CanvaBrandTemplate`.
 */
import type { CanvaBrandTemplate } from "./wireTypes";

const THUMB =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect fill="#1a2332" width="120" height="90"/><rect fill="#2dd4bf" opacity="0.25" x="12" y="12" width="96" height="66" rx="4"/></svg>`,
  );

export const FALLBACK_BRAND_TEMPLATES: CanvaBrandTemplate[] = [
  {
    id: "tpl-proposal",
    name: "Commercial proposal deck",
    thumbnailUrl: THUMB,
    tags: ["Proposal", "Deck"],
    pageCount: 18,
    slots: [
      { key: "project_name", type: "text", label: "Project name" },
      { key: "address", type: "text", label: "Site address" },
      {
        key: "hero_image",
        type: "image",
        label: "Cover hero",
        accepts: ["render", "site-context"],
      },
      {
        key: "floor_plan",
        type: "image",
        label: "Floor plan spread",
        accepts: ["floorplan", "sheet"],
      },
    ],
  },
  {
    id: "tpl-one-pager",
    name: "Project one-pager",
    thumbnailUrl: THUMB,
    tags: ["One-pager"],
    pageCount: 1,
    slots: [
      { key: "headline", type: "text", label: "Headline" },
      {
        key: "hero_image",
        type: "image",
        label: "Hero image",
        accepts: ["render"],
      },
    ],
  },
];

export function fallbackTemplateName(templateId: string): string {
  return (
    FALLBACK_BRAND_TEMPLATES.find((t) => t.id === templateId)?.name ??
    templateId
  );
}
