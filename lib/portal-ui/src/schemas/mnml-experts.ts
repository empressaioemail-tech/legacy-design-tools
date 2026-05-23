/**
 * doc 40e A.3 — static per-expert parameter schema for mnml.ai's
 * `archDiffusion-v43` endpoint. Captured from `mnmlai.dev/docs/api/
 * arch-diffusion-v43` on 2026-05-23 (cross-checked against the
 * planner-session capture at
 * `_sessions/2026-05-23_cortex_rendering_parity_sprint_planning_claude_code.md`).
 *
 * Used by:
 *
 *   - **B.1** — `RenderKickoffDialog` renders the per-expert parameter
 *     grid by walking these defs. Each param's `type` + `allowedValues`
 *     decide whether to render a select, a slider, a number input, or
 *     a toggle.
 *   - **A.2** — Power-tool routes can optionally re-use these defs for
 *     server-side validation before forwarding to mnml. Keeping the
 *     schema TS-defined (vs fetched at runtime) preserves compile-time
 *     narrowing on the values.
 *
 * The mnml docs encode booleans as string enums `"true"` / `"false"`;
 * the schema reflects the wire surface — UI code is free to render
 * those as native toggles, but the value emitted to mnml is the
 * documented string. Same posture for `seed`: mnml's docs list the
 * type as "number, default random"; we model it as an optional number
 * (range 0..1,000,000) with a UI-side "random" affordance that simply
 * omits the field, since mnml defaults to a random seed when absent.
 *
 * Updating to a new mnml version is a code change in this file, not a
 * config change — intentional for type safety. If mnml ships a new
 * allowed value the schema rejects it; that surfaces a contract drift
 * the build catches before users do.
 */

// ─────────────────────────────────────────────────────────────────────
// Param shape
// ─────────────────────────────────────────────────────────────────────

export type MnmlExpertName =
  | "exterior"
  | "interior"
  | "masterplan"
  | "landscape"
  | "plan"
  | "product";

export type MnmlRenderStyle =
  | "raw"
  | "photoreal"
  | "cgi_render"
  | "cad"
  | "freehand_sketch"
  | "clay_model"
  | "illustration"
  | "watercolor";

/**
 * Per-parameter definition. Discriminated by `type`:
 *
 * - `enum`   — closed-set string value; renders as a select. `default`
 *              is one of `allowedValues`.
 * - `number` — numeric value; renders as a slider (when `range` is
 *              given) or a free-form number input. mnml's docs use
 *              `"random"` as the default for `seed`; the schema treats
 *              that as "no default", surfaced via `default: undefined`.
 * - `file`   — file part on the multipart body. `multiple: true` for
 *              `reference_image_1-4` (the docs treat them as four
 *              numbered slots).
 *
 * `required: true` means the kickoff route must surface a value (the
 * common `image` + `prompt` params for archDiffusion-v43). Everything
 * else defaults to `required: false` (the dispatch's optional grid).
 */
export type MnmlParamDef =
  | MnmlEnumParamDef
  | MnmlNumberParamDef
  | MnmlFileParamDef;

export interface MnmlEnumParamDef {
  readonly name: string;
  readonly type: "enum";
  readonly required?: boolean;
  readonly default: string;
  readonly allowedValues: readonly string[];
  /** UI affordance hint — useful for B.1's renderer to pick a control. */
  readonly uiHint?: "select" | "radio" | "toggle";
  /** Optional short description for tooltips / help text. */
  readonly description?: string;
}

export interface MnmlNumberParamDef {
  readonly name: string;
  readonly type: "number";
  readonly required?: boolean;
  /** Default value. `undefined` means "no default" — mnml picks (e.g. random seed). */
  readonly default: number | undefined;
  readonly range?: { readonly min: number; readonly max: number };
  readonly uiHint?: "slider" | "input";
  readonly description?: string;
}

export interface MnmlFileParamDef {
  readonly name: string;
  readonly type: "file";
  readonly required?: boolean;
  /** Up to N slots (e.g. `reference_image_1` through `reference_image_4`). */
  readonly maxSlots?: number;
  readonly maxBytes?: number;
  readonly description?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Common parameters (apply to every expert)
// ─────────────────────────────────────────────────────────────────────

/**
 * The 10 common params per mnml docs 2026-05-23. The two "required"
 * fields are `image` + `prompt`, which are surfaced separately by the
 * route layer (they're the discriminator between a kickoff body and a
 * cancel / status call). Everything below is the "optional grid" the
 * B.1 dialog renders.
 */
export const MNML_COMMON_PARAMS = [
  {
    name: "expert_name",
    type: "enum",
    default: "exterior",
    allowedValues: [
      "exterior",
      "interior",
      "masterplan",
      "landscape",
      "plan",
      "product",
    ],
    uiHint: "select",
    description: "Which mnml expert pipeline to route the render through.",
  },
  {
    name: "render_style",
    type: "enum",
    default: "photoreal",
    allowedValues: [
      "raw",
      "photoreal",
      "cgi_render",
      "cad",
      "freehand_sketch",
      "clay_model",
      "illustration",
      "watercolor",
    ],
    uiHint: "select",
    description: "Output rendering style.",
  },
  {
    name: "geometry",
    type: "enum",
    default: "precise",
    allowedValues: ["precise", "creative"],
    uiHint: "radio",
    description:
      "`precise` follows source geometry tightly; `creative` allows mnml more interpretive freedom.",
  },
  {
    name: "view_mode",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "manual"],
    uiHint: "radio",
  },
  {
    name: "seed",
    type: "number",
    default: undefined,
    range: { min: 0, max: 1_000_000 },
    uiHint: "input",
    description:
      "Random when omitted. Pin a seed to reproduce a prior generation.",
  },
  {
    name: "annotation",
    type: "enum",
    default: "false",
    allowedValues: ["true", "false"],
    uiHint: "toggle",
  },
  {
    name: "show_dimensions",
    type: "enum",
    default: "false",
    allowedValues: ["true", "false"],
    uiHint: "toggle",
  },
  {
    name: "markup_mode",
    type: "enum",
    default: "false",
    allowedValues: ["true", "false"],
    uiHint: "toggle",
  },
  {
    name: "has_collage",
    type: "enum",
    default: "false",
    allowedValues: ["true", "false"],
    uiHint: "toggle",
  },
  {
    name: "reference_image_1-4",
    type: "file",
    maxSlots: 4,
    description:
      "Up to 4 optional style reference images. Extras are silently dropped by the mnml-client.",
  },
] as const satisfies readonly MnmlParamDef[];

// ─────────────────────────────────────────────────────────────────────
// Per-expert grids
// ─────────────────────────────────────────────────────────────────────

/** Exterior: 12 expert-specific params. */
const MNML_EXTERIOR_PARAMS = [
  {
    name: "camera_angle",
    type: "enum",
    default: "auto",
    allowedValues: [
      "auto",
      "eye_level",
      "elevation",
      "low",
      "elevated",
      "aerial",
      "top_down",
      "close_up",
    ],
    uiHint: "select",
  },
  {
    name: "camera_direction",
    type: "enum",
    default: "front",
    allowedValues: [
      "front",
      "corner_right",
      "right",
      "back",
      "left",
      "corner_left",
    ],
    uiHint: "select",
  },
  {
    name: "site_context",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "urban", "suburban", "nature"],
    uiHint: "radio",
  },
  {
    name: "greenery",
    type: "enum",
    default: "some",
    allowedValues: ["none", "some", "lush"],
    uiHint: "radio",
  },
  {
    name: "vehicles",
    type: "enum",
    default: "few",
    allowedValues: ["none", "few", "many"],
    uiHint: "radio",
  },
  {
    name: "people",
    type: "enum",
    default: "few",
    allowedValues: ["none", "few", "many"],
    uiHint: "radio",
  },
  {
    name: "street_props",
    type: "enum",
    default: "off",
    allowedValues: ["off", "on"],
    uiHint: "toggle",
  },
  {
    name: "motion",
    type: "enum",
    default: "subtle",
    allowedValues: ["off", "subtle", "long_exposure"],
    uiHint: "radio",
  },
  {
    name: "time_of_day",
    type: "enum",
    default: "auto",
    allowedValues: [
      "auto",
      "day",
      "morning",
      "golden_hour",
      "sunset",
      "dusk",
      "blue_hour",
      "night",
    ],
    uiHint: "select",
  },
  {
    name: "weather",
    type: "enum",
    default: "clear",
    allowedValues: [
      "clear",
      "overcast",
      "cloudy",
      "hazy",
      "rain",
      "fog",
      "snow",
    ],
    uiHint: "select",
  },
  {
    name: "ground_wetness",
    type: "enum",
    default: "dry",
    allowedValues: ["dry", "damp", "wet"],
    uiHint: "radio",
  },
] as const satisfies readonly MnmlParamDef[];

/** Interior: 8 expert-specific params. */
const MNML_INTERIOR_PARAMS = [
  {
    name: "room_type",
    type: "enum",
    default: "living room",
    allowedValues: [
      "living room",
      "bedroom",
      "kitchen",
      "bathroom",
      "dining room",
      "office",
    ],
    uiHint: "select",
  },
  {
    name: "room_style",
    type: "enum",
    default: "Modern interior",
    allowedValues: [
      "Modern interior",
      "Minimalism",
      "Japandi",
      "Industrial",
      "Scandinavian",
    ],
    uiHint: "select",
  },
  {
    name: "furnishing_level",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "empty", "minimal", "moderate", "full"],
    uiHint: "radio",
  },
  {
    name: "indoor_plants",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "none", "some", "lush"],
    uiHint: "radio",
  },
  {
    name: "interior_accessories",
    type: "enum",
    default: "off",
    allowedValues: ["off", "on"],
    uiHint: "toggle",
  },
  {
    name: "lighting_mode",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "off", "natural", "artificial", "mixed"],
    uiHint: "select",
  },
  {
    name: "floor_finish",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "matte", "reflective"],
    uiHint: "radio",
  },
  {
    name: "ambience",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "daylight", "golden_hour", "night"],
    uiHint: "select",
  },
] as const satisfies readonly MnmlParamDef[];

/** Masterplan: 5 expert-specific params. */
const MNML_MASTERPLAN_PARAMS = [
  {
    name: "plan_mode",
    type: "enum",
    default: "3d",
    allowedValues: ["3d", "2d"],
    uiHint: "radio",
  },
  {
    name: "urban_density",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "low", "medium", "high"],
    uiHint: "radio",
  },
  {
    name: "development_type",
    type: "enum",
    default: "auto",
    allowedValues: [
      "auto",
      "residential",
      "commercial",
      "mixed_use",
      "industrial",
      "institutional",
      "recreational",
    ],
    uiHint: "select",
  },
  {
    name: "water_features",
    type: "enum",
    default: "auto",
    allowedValues: ["auto", "none", "river", "lake", "coastal", "fountains"],
    uiHint: "select",
  },
  {
    name: "greenery",
    type: "enum",
    default: "moderate",
    allowedValues: ["sparse", "moderate", "dense", "forest"],
    uiHint: "radio",
  },
] as const satisfies readonly MnmlParamDef[];

/** Landscape: 6 expert-specific params. */
const MNML_LANDSCAPE_PARAMS = [
  {
    name: "landscape_style",
    type: "enum",
    default: "modern",
    allowedValues: [
      "modern",
      "traditional",
      "japanese",
      "tropical",
      "mediterranean",
      "desert",
    ],
    uiHint: "select",
  },
  {
    name: "vegetation",
    type: "enum",
    default: "moderate",
    allowedValues: ["minimal", "moderate", "lush", "wild"],
    uiHint: "radio",
  },
  {
    name: "water_features",
    type: "enum",
    default: "none",
    allowedValues: ["none", "pool", "pond", "fountain", "stream", "waterfall"],
    uiHint: "select",
  },
  {
    name: "hardscape",
    type: "enum",
    default: "minimal",
    allowedValues: ["minimal", "moderate", "extensive"],
    uiHint: "radio",
  },
  {
    name: "outdoor_furniture",
    type: "enum",
    default: "none",
    allowedValues: ["none", "minimal", "moderate", "full"],
    uiHint: "radio",
  },
  {
    name: "landscape_lighting",
    type: "enum",
    default: "none",
    allowedValues: ["none", "path", "accent", "dramatic", "full"],
    uiHint: "select",
  },
] as const satisfies readonly MnmlParamDef[];

/** Product: 5 expert-specific params. */
const MNML_PRODUCT_PARAMS = [
  {
    name: "product_category",
    type: "enum",
    default: "furniture",
    allowedValues: [
      "furniture",
      "lighting",
      "decor",
      "kitchenware",
      "electronics",
      "fashion",
      "jewelry",
      "packaging",
      "industrial",
      "automotive",
    ],
    uiHint: "select",
  },
  {
    name: "background",
    type: "enum",
    default: "white",
    allowedValues: ["white", "gradient", "studio", "contextual", "transparent"],
    uiHint: "select",
  },
  {
    name: "product_lighting",
    type: "enum",
    default: "soft",
    allowedValues: ["soft", "dramatic", "natural", "rim", "flat"],
    uiHint: "select",
  },
  {
    name: "material_finish",
    type: "enum",
    default: "auto",
    allowedValues: [
      "auto",
      "matte",
      "glossy",
      "metallic",
      "wood",
      "fabric",
      "leather",
      "glass",
      "ceramic",
    ],
    uiHint: "select",
  },
  {
    name: "shadow_style",
    type: "enum",
    default: "soft",
    allowedValues: ["none", "contact", "soft", "dramatic", "reflection"],
    uiHint: "select",
  },
] as const satisfies readonly MnmlParamDef[];

/** Plan: 6 expert-specific params. */
const MNML_PLAN_PARAMS = [
  {
    name: "plan_view_mode",
    type: "enum",
    default: "2d",
    allowedValues: ["2d", "3d"],
    uiHint: "radio",
  },
  {
    name: "drawing_style",
    type: "enum",
    default: "architectural",
    allowedValues: [
      "architectural",
      "schematic",
      "presentation",
      "technical",
    ],
    uiHint: "select",
  },
  {
    name: "color_mode",
    type: "enum",
    default: "monochrome",
    allowedValues: ["monochrome", "colored", "gradient"],
    uiHint: "radio",
  },
  {
    name: "furniture_2d",
    type: "enum",
    default: "outline",
    allowedValues: ["none", "outline", "filled", "detailed"],
    uiHint: "radio",
  },
  {
    name: "wall_style",
    type: "enum",
    default: "filled",
    allowedValues: ["outline", "filled", "hatched", "poche"],
    uiHint: "select",
  },
  {
    name: "view_type_3d",
    type: "enum",
    default: "bird_eye",
    allowedValues: ["bird_eye", "isometric", "perspective", "section"],
    uiHint: "select",
  },
] as const satisfies readonly MnmlParamDef[];

/**
 * Full per-expert lookup. The B.1 dialog renders the union of the
 * common grid (above) + the active expert's grid. The values mnml
 * accepts as form fields are the documented strings (or the documented
 * number range for `seed`).
 */
export const MNML_EXPERT_PARAMS = {
  exterior: MNML_EXTERIOR_PARAMS,
  interior: MNML_INTERIOR_PARAMS,
  masterplan: MNML_MASTERPLAN_PARAMS,
  landscape: MNML_LANDSCAPE_PARAMS,
  product: MNML_PRODUCT_PARAMS,
  plan: MNML_PLAN_PARAMS,
} as const;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate a per-expert param value against the documented allowed
 * values. Returns `{ ok: true }` when the value is acceptable, or
 * `{ ok: false, reason }` with a message suitable for surfacing.
 *
 * Used by:
 *
 *   - **B.1** — UI form validation before allowing the kickoff submit.
 *   - **A.2** — Routes may call this server-side before forwarding
 *     to mnml as a defense-in-depth check.
 *
 * The fast-path is the enum check (most params); number-typed params
 * check the range when provided.
 */
export function validateMnmlParamValue(
  def: MnmlParamDef,
  value: string,
): { ok: true } | { ok: false; reason: string } {
  if (def.type === "enum") {
    if (!def.allowedValues.includes(value)) {
      return {
        ok: false,
        reason: `${def.name}: "${value}" is not in [${def.allowedValues.join(", ")}]`,
      };
    }
    return { ok: true };
  }
  if (def.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return { ok: false, reason: `${def.name}: "${value}" is not a number` };
    }
    if (def.range && (n < def.range.min || n > def.range.max)) {
      return {
        ok: false,
        reason: `${def.name}: ${n} is outside [${def.range.min}, ${def.range.max}]`,
      };
    }
    return { ok: true };
  }
  // `file` is not validated by this helper — the route handles
  // multipart file parts directly.
  return { ok: true };
}

/**
 * Total param count per expert (common + expert-specific). Useful for
 * the B.1 dialog's "12 params" header and for tests asserting the
 * captured schema completeness against the 2026-05-23 mnml docs.
 */
export function mnmlExpertParamCount(expert: MnmlExpertName): number {
  return MNML_COMMON_PARAMS.length + MNML_EXPERT_PARAMS[expert].length;
}
