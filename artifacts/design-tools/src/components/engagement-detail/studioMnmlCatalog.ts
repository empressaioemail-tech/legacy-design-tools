/**
 * mnml.ai capability map for Deliver → Studio (Spec 54 / doc 40e).
 * Single source for workbench copy, costs, and tool grouping.
 */

export type StudioWorkbenchMode = "create" | "refine";

export const STUDIO_MODE_LABEL: Record<StudioWorkbenchMode, string> = {
  create: "Create",
  refine: "Refine",
};

/** Static kickoff costs (mirrors @workspace/mnml-client RENDER_COST_CREDITS). */
export const KICKOFF_CREDITS: Record<
  "still" | "elevation-set" | "video",
  { credits: number; label: string }
> = {
  still: { credits: 3, label: "ArchDiffusion still" },
  "elevation-set": { credits: 12, label: "4× elevation (N/E/S/W)" },
  video: { credits: 10, label: "Video AI clip" },
};

export const PROMPT_GENERATOR_CREDITS = 1;

export type PowerToolId =
  | "enhance"
  | "upscale"
  | "erase"
  | "inpaint"
  | "style_transfer";

export interface PowerToolSpec {
  id: PowerToolId;
  label: string;
  short: string;
  credits: number;
  group: "quality" | "edit";
}

export const POWER_TOOLS: PowerToolSpec[] = [
  {
    id: "enhance",
    label: "Enhance",
    short: "Prompt-guided detail pass",
    credits: 1,
    group: "quality",
  },
  {
    id: "upscale",
    label: "Upscale",
    short: "2× / 4× / 8× resolution",
    credits: 1,
    group: "quality",
  },
  {
    id: "erase",
    label: "Erase",
    short: "Mask unwanted regions",
    credits: 1,
    group: "edit",
  },
  {
    id: "inpaint",
    label: "Inpaint",
    short: "Fill masked areas from prompt",
    credits: 1,
    group: "edit",
  },
  {
    id: "style_transfer",
    label: "Restyle",
    short: "Reference-image style transfer",
    credits: 1,
    group: "edit",
  },
];

export const CREATE_OUTPUTS = [
  {
    id: "still",
    title: "Still render",
    hint: "Single frame from BIM capture or uploaded image.",
    credits: 3,
  },
  {
    id: "elevation-set",
    title: "Elevation set",
    hint: "Four directional elevations in one job.",
    credits: 12,
  },
  {
    id: "video",
    title: "Video",
    hint: "5s or 10s flythrough from camera path.",
    credits: 10,
  },
] as const;

export const REFINE_GROUP_LABEL = {
  quality: "Quality & resolution",
  edit: "Mask & edit",
} as const;
