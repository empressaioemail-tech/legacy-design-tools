/**
 * `looksLikeImage` — magic-number detection for the image MIME types
 * we accept on the avatar upload path.
 *
 * The route-level tests in `users.test.ts` pin the rejection wiring
 * (415 status, orphan cleanup, no DB write). This file pins the
 * detection logic itself so a regression in the byte-pattern checks
 * surfaces here with a clear minimal repro instead of as a confusing
 * 415 in the route suite.
 */

import { describe, it, expect } from "vitest";
import {
  IMAGE_SIGNATURE_HEAD_BYTES,
  looksLikeImage,
} from "../lib/imageSignature";

describe("looksLikeImage — accepted formats", () => {
  it("accepts the JPEG SOI marker (FF D8 FF)", () => {
    // Real JPEGs always start with FF D8 FF EX where X is the marker
    // type; the gate only needs the first three bytes to commit.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(looksLikeImage(jpeg)).toBe(true);
  });

  it("accepts the full PNG signature", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(looksLikeImage(png)).toBe(true);
  });

  it("accepts both GIF87a and GIF89a", () => {
    expect(looksLikeImage(Buffer.from("GIF87a", "ascii"))).toBe(true);
    expect(looksLikeImage(Buffer.from("GIF89a", "ascii"))).toBe(true);
  });

  it("accepts a WebP RIFF/WEBP container even with arbitrary size bytes", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x10, 0x20, 0x30, 0x40]), // size field — content-free
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(looksLikeImage(webp)).toBe(true);
  });

  it("accepts a minimal SVG", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "utf8",
    );
    expect(looksLikeImage(svg)).toBe(true);
  });

  it("accepts an SVG with an XML prologue and doctype", () => {
    // The most verbose realistic SVG header — prologue, doctype, then
    // the `<svg>` tag. The sniff window must accommodate all of this.
    const svg = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ` +
        `"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n` +
        `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
      "utf8",
    );
    expect(looksLikeImage(svg)).toBe(true);
  });

  it("accepts an SVG with a leading UTF-8 BOM", () => {
    // BOM-prefixed SVGs are rare but legal. The sniff strips the BOM
    // before scanning, so this should pass.
    const svg = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from("<svg></svg>", "utf8"),
    ]);
    expect(looksLikeImage(svg)).toBe(true);
  });

  it("accepts SVG case-insensitively", () => {
    // XML is case-sensitive but the SVG tag name is in lowercase by
    // spec; still, real-world corpora include `<SVG>` so the sniff
    // is intentionally tolerant.
    expect(looksLikeImage(Buffer.from("<SVG></SVG>", "utf8"))).toBe(true);
  });

  it("accepts an SVG with leading XML comments before the root tag", () => {
    // Editors (Inkscape, Illustrator, …) routinely emit a banner
    // comment between the prologue/doctype and the root `<svg>`. The
    // sniff must skip those without losing its grip on the "first
    // meaningful tag must be `<svg>`" rule.
    const svg = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!-- Generator: Acme Editor 1.0 -->\n` +
        `<!-- Another comment -->\n` +
        `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
      "utf8",
    );
    expect(looksLikeImage(svg)).toBe(true);
  });

  it("accepts a self-closing `<svg/>` shorthand", () => {
    // `<svg/>` is a legal (if useless) empty SVG document. The sniff
    // must accept the `/` immediately after the tag name, not just
    // whitespace or `>`.
    expect(looksLikeImage(Buffer.from("<svg/>", "utf8"))).toBe(true);
  });
});

describe("looksLikeImage — rejected payloads", () => {
  it("rejects an empty buffer", () => {
    expect(looksLikeImage(Buffer.alloc(0))).toBe(false);
  });

  it("rejects a JSON dump declared as image/jpeg", () => {
    // The exact threat the gate exists to catch: a non-browser caller
    // declaring image/jpeg in the presigned-URL request and PUTing
    // arbitrary bytes that look nothing like an image.
    const json = Buffer.from(
      '{"username":"admin","secret":"smuggled"}',
      "utf8",
    );
    expect(looksLikeImage(json)).toBe(false);
  });

  it("rejects an HTML page", () => {
    const html = Buffer.from(
      "<!DOCTYPE html><html><body>not an image</body></html>",
      "utf8",
    );
    expect(looksLikeImage(html)).toBe(false);
  });

  it("rejects a near-miss WebP (RIFF without WEBP)", () => {
    // RIFF wraps several other formats (WAV, AVI, …) — the sniff has
    // to distinguish WebP specifically by the 4-byte tag at offset 8.
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x10, 0x20, 0x30, 0x40]),
      Buffer.from("WAVE", "ascii"),
    ]);
    expect(looksLikeImage(wav)).toBe(false);
  });

  it("rejects a near-miss JPEG (FF D8 without the third byte)", () => {
    // A two-byte buffer that looks like the start of a JPEG but isn't
    // long enough to commit. The gate must require the full three-byte
    // SOI to avoid false positives on truncated/garbage uploads.
    expect(looksLikeImage(Buffer.from([0xff, 0xd8]))).toBe(false);
  });

  it("rejects a near-miss PNG (one corrupted byte)", () => {
    const corrupted = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0xff, // last byte wrong
    ]);
    expect(looksLikeImage(corrupted)).toBe(false);
  });

  it("rejects a TIFF (not in the allow-list)", () => {
    // TIFF is a real image format but not on our allow-list, so the
    // sniff must reject it the same way it rejects JSON. Keeps the
    // sniff in lock-step with the OpenAPI contentType enum.
    const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00]); // "II*\0"
    const tiffBE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]); // "MM\0*"
    expect(looksLikeImage(tiffLE)).toBe(false);
    expect(looksLikeImage(tiffBE)).toBe(false);
  });

  it("rejects a BMP (not in the allow-list)", () => {
    const bmp = Buffer.concat([
      Buffer.from("BM", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    expect(looksLikeImage(bmp)).toBe(false);
  });

  it("rejects an XML document that is not SVG", () => {
    const xml = Buffer.from(
      `<?xml version="1.0"?><config><foo>bar</foo></config>`,
      "utf8",
    );
    expect(looksLikeImage(xml)).toBe(false);
  });

  it("rejects an HTML page that contains an inline `<svg>` later", () => {
    // The exact bypass the strict SVG prefix walker exists to close.
    // A naive "contains `<svg` anywhere in the head" sniff would
    // accept this — but browsers render the bytes as HTML (because
    // that's what the *first* tag is), so accepting it would let an
    // attacker store an HTML page under `users.avatar_url`.
    const html = Buffer.from(
      `<!DOCTYPE html>\n` +
        `<html><body>\n` +
        `  <h1>Not an avatar</h1>\n` +
        `  <svg xmlns="http://www.w3.org/2000/svg"></svg>\n` +
        `</body></html>`,
      "utf8",
    );
    expect(looksLikeImage(html)).toBe(false);
  });

  it("rejects a JSON document that contains a `<svg` substring", () => {
    // Same threat model as the HTML case but with JSON — the bytes
    // would be served back as `application/json` by anything that
    // sniffs them, never as an image. The substring-anywhere sniff
    // would have falsely accepted this.
    const json = Buffer.from(
      `{"description": "a fake avatar payload with <svg> embedded"}`,
      "utf8",
    );
    expect(looksLikeImage(json)).toBe(false);
  });

  it("rejects plain text that mentions `<svg` after other content", () => {
    // The prefix walker rejects anything where a non-comment,
    // non-prologue, non-doctype token precedes `<svg` — including
    // raw text, which would hit the walker's "first non-whitespace
    // char is not `<`" branch.
    const text = Buffer.from(
      "Hello world! Here is some text that mentions <svg> in passing.",
      "utf8",
    );
    expect(looksLikeImage(text)).toBe(false);
  });

  it("rejects an XML document where another root element precedes `<svg>`", () => {
    // A second flavor of the bypass: legal XML, but the root tag
    // isn't `<svg>`. Even though the bytes contain `<svg` later, an
    // XML processor would render them as the outer element.
    const xml = Buffer.from(
      `<?xml version="1.0"?>\n` +
        `<wrapper><svg xmlns="http://www.w3.org/2000/svg"></svg></wrapper>`,
      "utf8",
    );
    expect(looksLikeImage(xml)).toBe(false);
  });

  it("rejects a tag that merely starts with `svg` (e.g. `<svgfoo>`)", () => {
    // Tag-name boundary check: `<svgfoo>` is not an SVG root, so the
    // sniff must require `<svg` to be followed by whitespace, `>`,
    // or `/` — not another name character.
    const xml = Buffer.from(
      `<svgfoo xmlns="http://www.w3.org/2000/svg"></svgfoo>`,
      "utf8",
    );
    expect(looksLikeImage(xml)).toBe(false);
  });
});

describe("IMAGE_SIGNATURE_HEAD_BYTES", () => {
  it("is large enough to fit a verbose SVG prologue", () => {
    // The constant is the recommended head-read size for callers, and
    // the SVG sniff is the only check that needs more than ~16 bytes.
    // Pin a generous floor so we notice if it ever shrinks too far.
    expect(IMAGE_SIGNATURE_HEAD_BYTES).toBeGreaterThanOrEqual(512);
  });
});
