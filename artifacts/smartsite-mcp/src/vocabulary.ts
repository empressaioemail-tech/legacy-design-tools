/**
 * P-167 (OPS-23 R-6). This module used to own the single vocabulary table
 * for the machine tokens this server puts on the wire (the disposition
 * enum, the refusal codes, the two Open failure sentences, citationsDegraded,
 * confidence "seed", edge role side_corner, frame quality gis-approximate,
 * and the P-153 modelled-figure-withheld draw-overlay basis). That table now
 * lives once, in `@empressaio/atom-contract/display` (moved verbatim at
 * P-167 steps 1-2; see that package's CHANGELOG.md 1.32.0/1.33.0/1.33.1
 * entries for the exact provenance of every entry). This module is now a
 * thin re-export of it, plus the resource-registration and standing-block
 * plumbing below, which stays MCP-specific (the panel and the PDF have no
 * equivalent of an MCP resource or a per-tool-call content block).
 *
 * Do not add a table, a lock, or a literal copy back here. A consumer that
 * needs the vocabulary imports `@empressaio/atom-contract/display` directly
 * (tool-honesty.ts and mcp-app.ts both do) or imports the re-export below;
 * either way there is one table.
 */
export {
  type VocabularyEntry,
  WIRE_DISPOSITION_DISPLAY_TEXT,
  DERIVED_FIGURES_POLICY,
  VOCABULARY,
  DOCUMENTED_VOCABULARY_COUNT,
} from "@empressaio/atom-contract/display";
import { VOCABULARY, type VocabularyEntry } from "@empressaio/atom-contract/display";

export const VOCABULARY_RESOURCE_URI = "docs://smartsite/vocabulary-p91v3.json";
export const VOCABULARY_MIME = "application/json";

/**
 * V2, payload half, resource leg. The vocabulary as an MCP resource the
 * assistant can read directly, independent of any single tool call.
 */
export function buildVocabularyResourceText(): string {
  return JSON.stringify({ vocabulary: VOCABULARY }, null, 2);
}

/** Same dual-signature shape as mcp-app.ts registerMcpApp, so one server object serves both. */
export function registerVocabularyResource(server: {
  registerResource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => void;
  resource?: (
    name: string,
    uri: string,
    config: Record<string, unknown>,
    handler: (uri: { href: string }) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => void;
}): void {
  const handler = async (uri: { href: string }) => ({
    contents: [
      { uri: uri.href, mimeType: VOCABULARY_MIME, text: buildVocabularyResourceText() },
    ],
  });
  if (typeof server.registerResource === "function") {
    server.registerResource(
      "Smart Site vocabulary",
      VOCABULARY_RESOURCE_URI,
      { mimeType: VOCABULARY_MIME },
      handler,
    );
    return;
  }
  if (typeof server.resource === "function") {
    server.resource(
      "Smart Site vocabulary",
      VOCABULARY_RESOURCE_URI,
      { mimeType: VOCABULARY_MIME },
      handler,
    );
  }
}

/**
 * V2, payload half, standing-block leg. Attached to EVERY tool result as an
 * ADDITIONAL content entry (tools.ts attachStandingVocabBlock), never
 * replacing content[0], which stays the tool's own JSON. Lookup only: token,
 * displayText, meaning triples. No behavioural instruction lives here (that
 * is agentGuidance's job, attached per-facet in tool-honesty.ts, and it is
 * explicitly allowed to instruct); this block only ever tells the model what
 * a code means, never what to do about it.
 *
 * Computed once at module load from the package's static table: no
 * timestamp, no per-request field, so it is byte-identical across every call
 * and every tool for the life of the process.
 *
 * What is true and load-bearing about this mechanism, and does not change
 * by adding more fields to it: it reaches the assistant only on a turn
 * where a Smart Site MCP tool is actually called. Every call re-arms the
 * vocabulary fresh, which is the point, but it holds no framing across a
 * run of turns where no Smart Site tool is invoked. Continuity across
 * off-topic turns is not this mechanism's job; the canonical-doc half of
 * V2 (planner-owned, filed in doc_repo, not in this repo) is what is
 * supposed to carry that, and this lane does not build it.
 */
export const STANDING_VOCAB_BLOCK_TEXT: string = JSON.stringify({
  smartSiteVocabulary: VOCABULARY.map(({ token, displayText, meaning }: VocabularyEntry) => ({
    token,
    displayText,
    meaning,
  })),
  resource: VOCABULARY_RESOURCE_URI,
});

export const STANDING_VOCAB_CONTENT_PART: { type: "text"; text: string } = {
  type: "text",
  text: STANDING_VOCAB_BLOCK_TEXT,
};
