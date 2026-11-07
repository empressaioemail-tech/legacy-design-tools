/** Customer-facing research chat copy — no internal product names. */

export const RESEARCH_CHAT_CUSTOMER_DISCLAIMER =
  "From public records and the municipal code on file. Not legal advice. Verify with city staff before relying on it.";

export function sanitizeResearchChatCustomerText(text: string): string {
  let out = text;
  out = out.replace(/\bHauska\b/gi, "Smart Site");
  out = out.replace(
    /\b(Hauska\s+)?property atom chain\b/gi,
    "parcel record",
  );
  out = out.replace(/\bnot a Hauska atom\b/gi, "City website · not yet verified");
  out = out.replace(/\bHauska catalog atom\b/gi, "verified code record");
  out = out.replace(/\bHauska atom\b/gi, "code record");
  if (/\batom chain\b/i.test(out)) {
    out = out.replace(/\batom chain\b/gi, "parcel record");
  }
  return out;
}
