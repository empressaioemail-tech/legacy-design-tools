/**
 * Unified GTM / Property Brief / place API error taxonomy.
 */

export const GTM_ERROR_CLASSES = [
  "no_coverage",
  "empty_corpus",
  "auth_reject",
  "upstream_timeout",
  "geocode_miss",
  "validation_error",
  "unknown",
] as const;

export type GtmErrorClass = (typeof GTM_ERROR_CLASSES)[number];

export function isGtmErrorClass(value: string): value is GtmErrorClass {
  return (GTM_ERROR_CLASSES as readonly string[]).includes(value);
}

export function gtmErrorBody(
  errorClass: GtmErrorClass,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return { error, errorClass, message, ...extra };
}
