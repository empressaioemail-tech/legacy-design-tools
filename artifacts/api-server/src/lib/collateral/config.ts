export function placidApiToken(): string | null {
  const t = process.env.PLACID_API_TOKEN?.trim();
  return t || null;
}

export function isPlacidConfigured(): boolean {
  return Boolean(placidApiToken());
}

export function placidTestMode(): boolean {
  const v = process.env.PLACID_TEST_MODE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function placidTemplateCover(): string | null {
  return process.env.PLACID_TEMPLATE_COVER?.trim() || null;
}

export function placidTemplatePlan(): string | null {
  return process.env.PLACID_TEMPLATE_PLAN?.trim() || null;
}

export function placidTemplateClosing(): string | null {
  return process.env.PLACID_TEMPLATE_CLOSING?.trim() || null;
}

export const PLACID_API_BASE = "https://api.placid.app/api/rest";

export const MAX_PDF_PAGES = 14;
