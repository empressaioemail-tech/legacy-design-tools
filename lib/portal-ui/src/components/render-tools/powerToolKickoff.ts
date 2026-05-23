import {
  customFetch,
  type KickoffPowerToolResponse,
} from "@workspace/api-client-react";

export type PowerToolKind =
  | "enhance"
  | "upscale"
  | "erase"
  | "inpaint"
  | "style_transfer";

const PATH: Record<PowerToolKind, string> = {
  enhance: "enhance",
  upscale: "upscale",
  erase: "erase",
  inpaint: "inpaint",
  style_transfer: "style-transfer",
};

export function getPowerToolKickoffUrl(
  parentOutputId: string,
  tool: PowerToolKind,
): string {
  return `/api/render-outputs/${parentOutputId}/${PATH[tool]}`;
}

/** Multipart kickoff — OpenAPI uses empty object schemas for file parts. */
export async function kickoffPowerTool(
  parentOutputId: string,
  tool: PowerToolKind,
  form: FormData,
): Promise<KickoffPowerToolResponse> {
  return customFetch<KickoffPowerToolResponse>(
    getPowerToolKickoffUrl(parentOutputId, tool),
    { method: "POST", body: form, responseType: "json" },
  );
}
