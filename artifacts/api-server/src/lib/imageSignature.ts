/**
 * Magic-number / signature sniffing for the image MIME types we accept
 * on the avatar upload path.
 *
 * Why this exists
 * ---------------
 * The presigned-URL endpoint constrains the *declared* `contentType`
 * a client can request to the image MIME allow-list (JPEG / PNG /
 * WebP / GIF / SVG), but the bytes themselves are PUT directly to
 * GCS via the signed URL. A non-browser caller can therefore declare
 * `image/jpeg` and upload an arbitrary blob (a JSON dump, an
 * executable, …) under the metadata gate. This module is the second
 * gate: before the API server lets `users.avatar_url` reference an
 * uploaded object, it pulls the head of the bytes off GCS and runs
 * them through {@link looksLikeImage}. Anything that doesn't decode
 * to a recognized image signature is rejected and the orphaned object
 * is best-effort cleaned up by the route.
 *
 * Detection strategy
 * ------------------
 * We use byte-level magic numbers for the binary formats and a
 * conservative text scan for SVG (which is just XML and so doesn't
 * have a single-byte signature). We do NOT cross-reference the
 * declared `contentType` from the request body — the goal is "are
 * these bytes one of the image types we accept?", not "do the bytes
 * match the label". If the FE declared `image/png` and uploaded a
 * valid JPEG, the row still gets a real image, which is the actual
 * security property we care about. The MIME label on the row is
 * informational only.
 *
 * The byte budget is small on purpose: 32 bytes is enough for every
 * binary signature in the allow-list; SVG sniffing needs a few
 * hundred to skip the optional `<?xml … ?>` prologue and any
 * comments / whitespace before `<svg`. {@link IMAGE_SIGNATURE_HEAD_BYTES}
 * is the recommended head-read size for callers — keep it in sync with
 * the SVG scan window.
 */

/**
 * Recommended number of leading bytes to read from the stored object
 * before calling {@link looksLikeImage}. Sized to fit the SVG sniff
 * window (which has to skip an optional XML prologue, doctype, and
 * comments) plus headroom; the binary-format checks only need the
 * first ~16 bytes.
 */
export const IMAGE_SIGNATURE_HEAD_BYTES = 1024;

/**
 * Returns `true` iff `bytes` start with one of the image signatures
 * we accept on avatar uploads. The check is intentionally narrow:
 *
 * - JPEG: starts with `FF D8 FF`
 * - PNG: starts with the 8-byte PNG signature
 * - GIF: starts with `GIF87a` or `GIF89a`
 * - WebP: 4-byte `RIFF`, then 4 size bytes, then 4-byte `WEBP`
 * - SVG: text-based; first non-whitespace, non-prologue, non-comment
 *   tag is `<svg` (case-insensitive). A leading UTF-8 BOM is tolerated.
 *
 * Anything else (including a `text/plain` body, a JSON dump, a TIFF,
 * a BMP, an HTML page, …) returns `false`. We deliberately keep the
 * accept set in lock-step with the OpenAPI `contentType` allow-list
 * so the two gates stay aligned.
 */
export function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;

  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return true;
  }

  // GIF: ASCII "GIF87a" or "GIF89a"
  if (bytes.length >= 6) {
    const header = bytes.slice(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return true;
    }
  }

  // WebP: ASCII "RIFF" at 0..3 and "WEBP" at 8..11. The 4 bytes in
  // between are the file size and not a fixed signature.
  if (
    bytes.length >= 12 &&
    bytes.slice(0, 4).toString("ascii") === "RIFF" &&
    bytes.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }

  // SVG: text-based sniff. SVG is just XML, so we have to walk the
  // head bytes and confirm `<svg` is the first *meaningful* tag —
  // i.e. nothing precedes it but optional whitespace, an XML
  // prologue, a doctype, and/or comments. A naive "match `<svg`
  // anywhere in the head" sniff would happily accept HTML pages that
  // happen to embed an inline `<svg>`, JSON strings that contain the
  // substring, etc. — that's a security gap, not a parser
  // convenience, because the bytes still get rendered by browsers as
  // whatever the *first* tag actually is. We accept ASCII / UTF-8
  // here; UTF-16 SVGs are vanishingly rare and not on the happy path
  // our FE produces, so they'd surface as a clear 415.
  if (looksLikeSvgPrefix(stripUtf8Bom(bytes))) {
    return true;
  }

  return false;
}

/**
 * Confirm that the leading bytes parse as the prefix of an SVG
 * document — i.e. zero or more of {whitespace, XML prologue,
 * doctype, comment} followed by an `<svg` tag-open. Anything else
 * (a `<html>` tag, a `{` of JSON, raw text, …) returns `false`,
 * even if the buffer contains `<svg` somewhere later.
 *
 * The walker is intentionally tiny and tolerant — it does NOT try to
 * be a real XML parser. It only cares about the tokens that can
 * legitimately appear *before* the root `<svg>` element of a real
 * SVG file. UTF-8 BOM is assumed already stripped by the caller.
 */
function looksLikeSvgPrefix(bytes: Buffer): boolean {
  // Decode the whole head window as UTF-8. SVG is XML so a UTF-8
  // decode of the leading bytes is safe; multi-byte sequences only
  // appear inside attribute values / text nodes which can't precede
  // the root tag.
  const text = bytes.toString("utf8");
  let pos = 0;

  const skipWhitespace = (): void => {
    while (pos < text.length) {
      const ch = text.charCodeAt(pos);
      // ASCII whitespace: space, tab, LF, CR, FF, VT.
      if (
        ch === 0x20 ||
        ch === 0x09 ||
        ch === 0x0a ||
        ch === 0x0d ||
        ch === 0x0c ||
        ch === 0x0b
      ) {
        pos++;
        continue;
      }
      break;
    }
  };

  skipWhitespace();

  // Optional XML prologue: `<?xml … ?>`. At most one, and only at
  // the very start (after whitespace), per the XML spec.
  if (text.startsWith("<?xml", pos)) {
    const end = text.indexOf("?>", pos + 5);
    if (end === -1) return false;
    pos = end + 2;
    skipWhitespace();
  }

  // Zero or more comments and at most one DOCTYPE, in either order
  // (comments may appear before *or* after the doctype). We loop so
  // a `<!-- … --> <!DOCTYPE …> <!-- … -->` sequence is tolerated.
  let sawDoctype = false;
  for (;;) {
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) return false;
      pos = end + 3;
      skipWhitespace();
      continue;
    }
    if (
      !sawDoctype &&
      text.slice(pos, pos + 9).toLowerCase() === "<!doctype"
    ) {
      // Bare-bones DOCTYPE matcher: skip to the next `>`. SVG
      // doctypes don't carry an internal subset in practice (no
      // `[...]`), so a single `>` terminator is enough. If a
      // pathological author ships one with an internal subset, the
      // sniff will reject it — they can re-export without one.
      const end = text.indexOf(">", pos + 9);
      if (end === -1) return false;
      pos = end + 1;
      sawDoctype = true;
      skipWhitespace();
      continue;
    }
    break;
  }

  // The next token must be `<svg` followed by whitespace, `>`, or
  // `/` (for `<svg/>`). Tag name matching is case-insensitive — XML
  // is case-sensitive but real-world corpora include `<SVG>` and
  // browsers render either, so a strict-lowercase check would be
  // user-hostile without buying us anything security-wise.
  if (pos + 4 > text.length) return false;
  if (text.slice(pos, pos + 4).toLowerCase() !== "<svg") return false;
  const after = text.charCodeAt(pos + 4);
  // Allow space, tab, LF, CR, FF, VT, `>`, `/`. Anything else (like
  // a letter — `<svgfoo>`) means this isn't actually the root tag.
  return (
    after === 0x20 ||
    after === 0x09 ||
    after === 0x0a ||
    after === 0x0d ||
    after === 0x0c ||
    after === 0x0b ||
    after === 0x3e || // '>'
    after === 0x2f // '/'
  );
}

/**
 * Drop a leading UTF-8 BOM (EF BB BF) so the SVG text sniff doesn't
 * have to special-case BOM-prefixed files. Returns the input
 * unchanged when no BOM is present.
 */
function stripUtf8Bom(bytes: Buffer): Buffer {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return bytes.slice(3);
  }
  return bytes;
}
