import type {
  CanvaBrandTemplate,
  CanvaDesignPush,
  CanvaSelectableAsset,
} from "./types";

const THUMB =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect fill="#1a2332" width="120" height="90"/><rect fill="#2dd4bf" opacity="0.25" x="12" y="12" width="96" height="66" rx="4"/></svg>`,
  );

export function mockEngagementAssets(
  engagementId: string,
): CanvaSelectableAsset[] {
  return [
    {
      id: `${engagementId}-render-hero`,
      kind: "render",
      label: "Hero exterior still",
      fileType: "PNG",
      thumbnailUrl: THUMB,
      exportable: true,
      sourceTab: "renders",
    },
    {
      id: `${engagementId}-render-lobby`,
      kind: "render",
      label: "Lobby interior",
      fileType: "WebP",
      thumbnailUrl: THUMB,
      exportable: true,
      sourceTab: "renders",
    },
    {
      id: `${engagementId}-floor-a1`,
      kind: "floorplan",
      label: "Level 1 plan — A1.01",
      fileType: "PDF",
      thumbnailUrl: THUMB,
      exportable: true,
      sourceTab: "sheets",
    },
    {
      id: `${engagementId}-floor-dwg`,
      kind: "floorplan",
      label: "Level 1 — source DWG",
      fileType: "DWG",
      exportable: false,
      disabledReason: "Export to PNG or PDF before sending to Canva",
      sourceTab: "sheets",
    },
    {
      id: `${engagementId}-sheet-pdf`,
      kind: "sheet",
      label: "Sheet set export",
      fileType: "PDF",
      thumbnailUrl: THUMB,
      exportable: true,
      sourceTab: "sheets",
    },
    {
      id: `${engagementId}-site-hero`,
      kind: "site-context",
      label: "Parcel map hero",
      fileType: "PNG",
      thumbnailUrl: THUMB,
      exportable: true,
      sourceTab: "site",
    },
  ];
}

export const MOCK_BRAND_TEMPLATES: CanvaBrandTemplate[] = [
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
  {
    id: "tpl-social",
    name: "Social post set",
    thumbnailUrl: THUMB,
    tags: ["Social"],
    pageCount: 4,
    slots: [
      {
        key: "feature_render",
        type: "image",
        label: "Feature render",
        accepts: ["render"],
      },
    ],
  },
];

export function mockEngagementDesigns(
  engagementId: string,
): CanvaDesignPush[] {
  return [
    {
      id: `${engagementId}-push-1`,
      createdAt: "2 days ago",
      templateName: "Commercial proposal deck",
      status: "edited_in_canva",
      thumbnailUrl: THUMB,
      designUrl: "https://www.canva.com/design/stub",
      sourceAssetIds: [`${engagementId}-render-hero`],
    },
  ];
}
