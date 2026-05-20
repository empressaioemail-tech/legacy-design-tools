/**
 * Pure validation logic for the L5 `product-spec-reference` routes
 * (Cortex Lane C.4 / C.4.5). Free of `@workspace/db` and Express
 * imports so it is unit-testable without a database.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L5.
 */

import {
  ESR_NUMBER_RE,
  PRODUCT_SPEC_STATUSES,
  type ProductSpecStatus,
} from "@workspace/atoms-l-surface";

/** Discriminated result of a request-body / query-param parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Parsed `POST /engagements/:id/product-spec-references` body. */
export interface ParsedCreateProductSpecReferenceBody {
  product: { name: string; manufacturer: string };
  esrNumber: string;
  findingId: string | null;
  responseTaskId: string | null;
  actorId: string | null;
  principalActorId: string | null;
}

function parseOptionalString(
  raw: unknown,
  field: string,
): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `invalid_${field}` };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/** True when `v` is one of the three `ProductSpecStatus` values. */
export function isProductSpecStatus(v: unknown): v is ProductSpecStatus {
  return (
    typeof v === "string" &&
    (PRODUCT_SPEC_STATUSES as readonly string[]).includes(v)
  );
}

/** Validate `POST /engagements/:id/product-spec-references` request body. */
export function parseCreateProductSpecReferenceBody(
  raw: unknown,
): ParseResult<ParsedCreateProductSpecReferenceBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;

  const product = body.product;
  if (!product || typeof product !== "object") {
    return { ok: false, error: "invalid_product" };
  }
  const p = product as Record<string, unknown>;
  if (
    typeof p.name !== "string" ||
    p.name.trim().length === 0 ||
    typeof p.manufacturer !== "string" ||
    p.manufacturer.trim().length === 0
  ) {
    return { ok: false, error: "invalid_product" };
  }

  if (
    typeof body.esrNumber !== "string" ||
    !ESR_NUMBER_RE.test(body.esrNumber.trim())
  ) {
    return { ok: false, error: "invalid_esr_number" };
  }

  const findingId = parseOptionalString(body.findingId, "finding_id");
  if (!findingId.ok) return findingId;
  const responseTaskId = parseOptionalString(
    body.responseTaskId,
    "response_task_id",
  );
  if (!responseTaskId.ok) return responseTaskId;
  const actorId = parseOptionalString(body.actorId, "actor_id");
  if (!actorId.ok) return actorId;
  const principalActorId = parseOptionalString(
    body.principalActorId,
    "principal_actor_id",
  );
  if (!principalActorId.ok) return principalActorId;

  return {
    ok: true,
    value: {
      product: {
        name: p.name.trim(),
        manufacturer: p.manufacturer.trim(),
      },
      esrNumber: body.esrNumber.trim(),
      findingId: findingId.value,
      responseTaskId: responseTaskId.value,
      actorId: actorId.value,
      principalActorId: principalActorId.value,
    },
  };
}

/** Validate the optional `?status=` list filter. */
export function parseStatusFilter(
  raw: unknown,
): ParseResult<ProductSpecStatus | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (!isProductSpecStatus(raw)) {
    return { ok: false, error: "invalid_status" };
  }
  return { ok: true, value: raw };
}
