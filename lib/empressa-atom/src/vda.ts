/**
 * VDA (Versioned Data Atom) wrapping — interface-stable, no-op in A0.
 *
 * Spec 20 envisions every data-level atom write going through a versioning
 * envelope so the historical chain can be reconstructed without mutating
 * source rows. A0 ships the **shape** of that envelope plus pure
 * `wrapForStorage` / `unwrapFromStorage` functions whose runtime is a no-op:
 * the value travels through unchanged. A1+ atoms call these from their
 * write paths today; when the real envelope ships, no consumer code needs
 * to change.
 *
 * TODO(M2-C): replace the no-op envelope with the real version chain plus
 * tombstone semantics. The current shape is intentionally minimal so
 * extensions are additive.
 */

/**
 * Storage envelope wrapped around every persisted atom payload. The
 * `version` field is the envelope schema version; `vdaApplied` is `false`
 * in A0 so consumers can detect "real-VDA-not-yet-on" data even if a
 * caller forgets to migrate when M2-C lands.
 */
export interface VdaEnvelope {
  version: number;
  vdaApplied: boolean;
}

/** A wrapped value as it lives at rest. */
export interface WrappedValue<T> {
  envelope: VdaEnvelope;
  payload: T;
}

const A0_ENVELOPE: VdaEnvelope = { version: 1, vdaApplied: false };

/**
 * Wrap `value` for storage. A0 implementation is a pure structural
 * wrapper — it never mutates `value` and never copies it.
 *
 * @example
 *   await db.insert(atoms).values({ payload: wrapForStorage(record) });
 */
export function wrapForStorage<T>(value: T): WrappedValue<T> {
  return { envelope: A0_ENVELOPE, payload: value };
}

/**
 * Unwrap a storage envelope. Returns the inner payload unchanged. Tolerant
 * of the no-envelope shape so legacy rows (or future shapes) read cleanly:
 * if the input does not look like a {@link WrappedValue}, it is returned
 * as-is and treated as the payload.
 */
export function unwrapFromStorage<T>(stored: WrappedValue<T> | T): T {
  if (
    stored !== null &&
    typeof stored === "object" &&
    "envelope" in (stored as Record<string, unknown>) &&
    "payload" in (stored as Record<string, unknown>)
  ) {
    return (stored as WrappedValue<T>).payload;
  }
  return stored as T;
}
