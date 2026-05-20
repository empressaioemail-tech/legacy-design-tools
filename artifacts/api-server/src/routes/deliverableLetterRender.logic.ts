/**
 * Pure validation logic for the L6 `deliverable-letter-render` routes
 * (Cortex Lane C.4 / C.4.6). Free of `@workspace/db` and Express
 * imports so it is unit-testable without a database.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L6.
 */

import { RENDER_FORMATS, type RenderFormat } from "@workspace/atoms-l-surface";

/** Discriminated result of a request-body parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** True when `v` is one of the `RenderFormat` values. */
export function isRenderFormat(v: unknown): v is RenderFormat {
  return (
    typeof v === "string" &&
    (RENDER_FORMATS as readonly string[]).includes(v)
  );
}

/** Parsed `POST /deliverable-letters/:id/renders` body. */
export interface ParsedRenderBody {
  format: RenderFormat;
  renderedByActorId: string | null;
}

/** Validate the render request body. */
export function parseRenderBody(raw: unknown): ParseResult<ParsedRenderBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;
  if (!isRenderFormat(body.format)) {
    return { ok: false, error: "invalid_format" };
  }
  let renderedByActorId: string | null = null;
  if (body.renderedByActorId !== undefined && body.renderedByActorId !== null) {
    if (typeof body.renderedByActorId !== "string") {
      return { ok: false, error: "invalid_rendered_by_actor_id" };
    }
    const trimmed = body.renderedByActorId.trim();
    renderedByActorId = trimmed.length > 0 ? trimmed : null;
  }
  return { ok: true, value: { format: body.format, renderedByActorId } };
}

/** Build the `did:hauska:deliverable-letter:<id>` ref for a letter. */
export function deliverableLetterRef(letterId: string): string {
  return `did:hauska:deliverable-letter:${letterId}`;
}

/** Build the opaque `blobRef` for a render row. */
export function renderBlobRef(renderId: string): string {
  return `db:deliverable-letter-render:${renderId}`;
}
