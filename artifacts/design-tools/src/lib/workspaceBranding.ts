import type { CSSProperties } from "react";
import { BRIEFING_PDF_HEADER_TOKENS } from "@workspace/briefing-pdf-tokens";

/** Preset accent colors (null = theme default). */
export const WORKSPACE_ACCENT_PRESETS = [
  { id: "default", label: "Cortex cyan (default)", value: null as string | null },
  { id: "sky", label: "Sky blue", value: "#0284C7" },
  { id: "teal", label: "Teal", value: "#14B8A6" },
  { id: "violet", label: "Violet", value: "#7C3AED" },
] as const;

export function applyWorkspaceAccent(primaryColor: string | null): void {
  const root = document.documentElement;
  if (primaryColor) {
    root.style.setProperty("--workspace-accent", primaryColor);
    root.dataset.workspaceAccent = "custom";
  } else {
    root.style.removeProperty("--workspace-accent");
    delete root.dataset.workspaceAccent;
  }
}

export const letterHeaderPreviewStyle: CSSProperties = {
  fontFamily: BRIEFING_PDF_HEADER_TOKENS.fontFamily,
  fontSize: BRIEFING_PDF_HEADER_TOKENS.fontSize,
  color: BRIEFING_PDF_HEADER_TOKENS.color,
  lineHeight: 1.2,
};
