/**
 * ICC notice and disclaimer (Exhibit B) plus the ICC source policy.
 *
 * One shared module. Every Smart Site surface that renders an ICC citation or
 * an ICC Digital Codes link shows `ICC_NOTICE` and `ICC_DISCLAIMER`, and only
 * when an ICC citation is actually present. No ICC section text lives here.
 *
 * The source policy half (`isIccSource`, `isIccHost`) is how the server tells
 * ICC-sourced rows apart so it can return citations only, never text.
 */

export const ICC_NOTICE =
  "This software contains material which is proprietary to and copyrighted by or licensed to International Code Council, Inc. The portions of information copyrighted by or licensed to the International Code Council, Inc., have been obtained and reproduced with permission. The acronym ICC® and the ICC logogram are federally protected trademarks and service marks of ICC. All other code titles are the trademarks and services marks of the International Code Council, Inc. ALL RIGHTS RESERVED. Without advance written permission from the International Code Council, Inc., no part of the International Code Council, Inc.'s copyrighted or licensed material may be reproduced, distributed or transmitted in any form or by any means, including, without limitation, electronic, optical or mechanical means (by way of example and not limitation, photocopying, printing, or recording by or in an information storage retrieval system). For information on permission to copy the International Code Council, Inc. materials, please contact: Publications, 4051 West Flossmoor Road, Country Club Hills, IL 60478. Phone 1-888-ICC-SAFE (422-7233).";

export const ICC_DISCLAIMER =
  "ICC is not responsible for the performance or technical accuracy of this software.";

/** ICC-owned hosts: iccsafe.org and any true subdomain (codes.iccsafe.org, ...). */
export function isIccHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "iccsafe.org" || host.endsWith(".iccsafe.org");
}

/** True when `value` is a URL whose host is an ICC host. Non-URLs are false. */
export function isIccUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return isIccHost(new URL(value.trim()).hostname);
  } catch {
    return false;
  }
}

/** ICC model code acronyms (titles ICC publishes). */
const ICC_TITLE_ACRONYMS =
  /\b(IBC|IRC|IFC|IPMC|IECC|IPC|IMC|IFGC|IEBC|ISPSC|IgCC|IWUIC|IZC|IPSDC|ICC\s*A117\.1)\b/;
const ICC_TITLE_WORDS =
  /\bInternational\s+(?:[A-Za-z-]+\s+){0,4}Code\b|\bInternational Code Council\b|\bICC\b|\bICC[- ]?(?:ES|model[- ]code)\b|icc-model-code/i;

/** True when a text label names an ICC code title or ICC. */
export function isIccLabel(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return ICC_TITLE_ACRONYMS.test(value) || ICC_TITLE_WORDS.test(value);
}

export interface IccSourceFields {
  jurisdictionKey?: unknown;
  sourceName?: unknown;
  sourceUrl?: unknown;
  url?: unknown;
  deeplink?: unknown;
  codeBook?: unknown;
  codeSource?: unknown;
}

/**
 * True when a stored row or source link is ICC content: ICC host, the
 * icc-model-code jurisdiction, or a source named for ICC. The code book is not
 * used: a city that adopted the IBC publishes its own ordinance, which is not
 * ICC content.
 */
export function isIccSource(fields: IccSourceFields | null | undefined): boolean {
  if (!fields) return false;
  if (isIccUrl(fields.sourceUrl) || isIccUrl(fields.url) || isIccUrl(fields.deeplink)) {
    return true;
  }
  if (fields.jurisdictionKey === "icc-model-code" || fields.codeSource === "icc-model-code") {
    return true;
  }
  if (typeof fields.sourceName === "string" && isIccLabel(fields.sourceName)) return true;
  return false;
}

/** True when a citation (URL string, label string, or object) is an ICC citation. */
export function isIccCitation(citation: unknown): boolean {
  if (typeof citation === "string") {
    // A URL is judged by its host alone; anything else is a text label.
    if (HTTP_URL.test(citation.trim())) return isIccUrl(citation);
    return isIccLabel(citation);
  }
  if (citation && typeof citation === "object") {
    const o = citation as Record<string, unknown>;
    if (isIccSource(o)) return true;
    if (typeof o.codeBook === "string" && isIccLabel(o.codeBook)) return true;
    for (const k of ["label", "title", "name", "edition", "atomId", "source", "citation", "text"]) {
      if (typeof o[k] === "string" && (HTTP_URL.test(o[k] as string) ? isIccUrl(o[k]) : isIccLabel(o[k]))) return true;
    }
  }
  return false;
}

/** True when any entry of a citation list is an ICC citation. */
export function hasIccCitation(citations: unknown): boolean {
  if (!Array.isArray(citations)) return false;
  return citations.some(isIccCitation);
}

export interface IccNotice {
  notice: string;
  disclaimer: string;
}

/** The notice and disclaimer, or null when no ICC citation is present. */
export function iccNoticeFor(citations: unknown): IccNotice | null {
  return hasIccCitation(citations)
    ? { notice: ICC_NOTICE, disclaimer: ICC_DISCLAIMER }
    : null;
}

function iccEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML block for card and web surfaces. Empty string when no ICC citation. */
export function iccNoticeHtml(citations: unknown): string {
  if (!hasIccCitation(citations)) return "";
  return (
    `<div class="icc-notice" data-icc-notice="1" style="margin-top:12px;font-size:11px;line-height:1.4;opacity:.8">` +
    `<p style="margin:0 0 6px">${iccEscape(ICC_NOTICE)}</p>` +
    `<p style="margin:0">${iccEscape(ICC_DISCLAIMER)}</p>` +
    `</div>`
  );
}

/** Plain text block for PDFs, exports and text results. Null when no ICC citation. */
export function iccNoticeText(citations: unknown): string | null {
  return hasIccCitation(citations) ? `${ICC_NOTICE}\n\n${ICC_DISCLAIMER}` : null;
}

const HTTP_URL = /^https?:[/][/]/i;
