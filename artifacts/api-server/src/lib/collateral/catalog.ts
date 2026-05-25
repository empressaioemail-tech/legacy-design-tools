import type { CollateralTemplatePack } from "./wireTypes";

const THUMB =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect fill="#1a2332" width="120" height="90"/><rect fill="#14b8a6" opacity="0.35" x="12" y="12" width="96" height="66" rx="4"/><text x="60" y="48" fill="#e2e8f0" font-size="10" text-anchor="middle" font-family="sans-serif">PDF</text></svg>`,
  );

export const CLIENT_PRESENTATION_PACK: CollateralTemplatePack = {
  id: "client-presentation",
  name: "Client presentation (PDF)",
  thumbnailUrl: THUMB,
  tags: ["PDF", "Deliver"],
  pageCountEstimate: 6,
  creditsPerPage: 2,
  slots: [
    { key: "project_name", type: "text", label: "Project name" },
    { key: "address", type: "text", label: "Site address" },
    { key: "headline", type: "text", label: "Cover headline" },
    { key: "talking_points", type: "text", label: "Closing talking points" },
    {
      key: "hero_image",
      type: "image",
      label: "Cover hero",
      accepts: ["render", "site-context"],
    },
    {
      key: "floor_plan",
      type: "image",
      label: "Plan spread image",
      accepts: ["floorplan", "sheet"],
    },
  ],
};

export const COLLATERAL_TEMPLATE_PACKS: CollateralTemplatePack[] = [
  CLIENT_PRESENTATION_PACK,
];

export function templatePackById(id: string): CollateralTemplatePack | undefined {
  return COLLATERAL_TEMPLATE_PACKS.find((t) => t.id === id);
}

export function templatePackName(id: string): string {
  return templatePackById(id)?.name ?? id;
}

/** Estimate Placid credits: 2 per PDF page. */
export function estimateCreditsForRequest(params: {
  sheetPageCount: number;
}): number {
  const pages = 1 + params.sheetPageCount + 1;
  return pages * CLIENT_PRESENTATION_PACK.creditsPerPage;
}
