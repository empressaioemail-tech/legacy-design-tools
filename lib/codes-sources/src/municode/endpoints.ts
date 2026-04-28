/**
 * Centralized endpoint definitions for the unofficial Municode JSON API
 * exposed at https://api.municode.com.
 *
 * Verified empirically during Sprint A05 reconnaissance. The legal posture is
 * documented in lib/codes-sources/MUNICODE_API_NOTES.md. If Municode ever
 * publishes an official paid API, replace this file's BASE with the new
 * gateway and adapt response parsing.
 */

export const MUNICODE_API_BASE = "https://api.municode.com";
export const MUNICODE_LIBRARY_BASE = "https://library.municode.com";

export const ENDPOINTS = {
  /** GET — looks up a client by name + state. Returns ClientID, ClientName, etc. */
  clientByName: (clientName: string, stateAbbr: string) => ({
    path: "/Clients/name",
    params: { clientName, stateAbbr },
  }),

  /**
   * GET — returns { codes: [{ productName, productId, … }], features, munidocs }
   * for one client. Use codes[0].productId as the productId.
   */
  clientContent: (clientId: number) => ({
    path: `/ClientContent/${clientId}`,
    params: {},
  }),

  /**
   * GET — returns the latest job for a product. The job carries `Id` (the jobId
   * needed for /codesToc and /CodesContent) and `Name` (e.g. "Supplement 19",
   * which we record as the atom edition).
   */
  jobsLatest: (productId: number) => ({
    path: `/Jobs/latest/${productId}`,
    params: {},
  }),

  /**
   * GET — returns the children of a TOC node. Omitting nodeId returns the
   * top-level chapter listing.
   */
  codesTocChildren: (jobId: number, productId: number, nodeId?: string) => ({
    path: "/codesToc/children",
    params: nodeId
      ? { jobId, productId, nodeId }
      : { jobId, productId },
  }),

  /**
   * GET — returns { Docs: [{Id, Title, Content (HTML), …}], … } for a node.
   * Docs whose Content is non-null are leaf sections we promote to atoms.
   */
  codesContent: (jobId: number, productId: number, nodeId: string) => ({
    path: "/CodesContent",
    params: { jobId, productId, nodeId },
  }),
} as const;

/**
 * Build the canonical library.municode.com URL an architect can click to
 * verify a section in their browser, given a state code, formatted
 * municipality slug, and an optional nodeId anchor.
 */
export function libraryUrl(
  stateAbbr: string,
  munipalitySlug: string,
  nodeId?: string,
): string {
  const base = `${MUNICODE_LIBRARY_BASE}/${stateAbbr.toLowerCase()}/${munipalitySlug}/codes/code_of_ordinances`;
  if (!nodeId) return base;
  return `${base}?nodeId=${encodeURIComponent(nodeId)}`;
}
