/**
 * Deliverable-letter render generation (Cortex Lane C.4 / C.4.6, L6).
 *
 * Turns an L3 deliverable letter (`title` + ordered `LetterSection[]`)
 * into a real DOCX or PDF document, synchronously and in-process:
 *
 *   - PDF  — laid out with `pdf-lib` (a direct api-server dependency):
 *            Helvetica text, manual word-wrap + pagination.
 *   - DOCX — a minimal-but-valid OOXML package: the three required
 *            parts (`[Content_Types].xml`, `_rels/.rels`,
 *            `word/document.xml`) assembled into a ZIP with a
 *            self-contained STORE-method writer (no external zip
 *            dependency — `adm-zip` is not a workspace dependency and a
 *            STORE-method ZIP is fully spec-compliant and Word-openable).
 *
 * Both formats are small documents; generation is well under the ~30s
 * the contract flags as the async-poll threshold.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { LetterSection } from "@workspace/atoms-l-surface";

/** Human label for each section kind, used as a fallback heading. */
const SECTION_KIND_LABEL: Record<LetterSection["kind"], string> = {
  cover: "Cover",
  intro: "Introduction",
  "per-comment-response": "Comment Response",
  signature: "Signature",
};

/* -------------------------------------------------------------------------- */
/*                                  PDF                                       */
/* -------------------------------------------------------------------------- */

/** Wrap `text` to lines no wider than `maxWidth` at `size` in `font`. */
function wrapLines(
  text: string,
  font: import("pdf-lib").PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line.length > 0) out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Render a deliverable letter to a PDF document. */
export async function renderLetterToPdf(
  title: string,
  sections: ReadonlyArray<LetterSection>,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 56;
  const MAX_W = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const writeBlock = (
    text: string,
    size: number,
    blockFont: import("pdf-lib").PDFFont,
    gap: number,
  ): void => {
    const lineHeight = size * 1.4;
    for (const line of wrapLines(text, blockFont, size, MAX_W)) {
      if (y - lineHeight < MARGIN) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
      if (line.length > 0) {
        page.drawText(line, {
          x: MARGIN,
          y: y - size,
          size,
          font: blockFont,
          color: rgb(0.1, 0.1, 0.12),
        });
      }
      y -= lineHeight;
    }
    y -= gap;
  };

  writeBlock(title || "Deliverable Letter", 18, bold, 14);
  for (const section of sections) {
    const heading =
      section.heading.trim().length > 0
        ? section.heading
        : SECTION_KIND_LABEL[section.kind] ?? section.kind;
    writeBlock(heading, 13, bold, 6);
    if (section.content.trim().length > 0) {
      writeBlock(section.content, 11, font, 14);
    } else {
      y -= 8;
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/* -------------------------------------------------------------------------- */
/*                       DOCX — minimal OOXML + ZIP                            */
/* -------------------------------------------------------------------------- */

/** XML-escape a text value for inclusion in OOXML. */
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One OOXML paragraph; `bold` renders the run bold. */
function docxParagraph(text: string, bold: boolean): string {
  const runProps = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  // `xml:space="preserve"` keeps leading/trailing whitespace; newlines
  // in the content become explicit <w:br/> breaks.
  const segments = text.split(/\r?\n/);
  const runs = segments
    .map((seg, i) => {
      const br = i < segments.length - 1 ? "<w:br/>" : "";
      return `<w:r>${runProps}<w:t xml:space="preserve">${xmlEscape(
        seg,
      )}</w:t>${br}</w:r>`;
    })
    .join("");
  return `<w:p>${runs}</w:p>`;
}

function docxDocumentXml(
  title: string,
  sections: ReadonlyArray<LetterSection>,
): string {
  const paragraphs: string[] = [
    docxParagraph(title || "Deliverable Letter", true),
  ];
  for (const section of sections) {
    const heading =
      section.heading.trim().length > 0
        ? section.heading
        : SECTION_KIND_LABEL[section.kind] ?? section.kind;
    paragraphs.push(docxParagraph(heading, true));
    paragraphs.push(docxParagraph(section.content, false));
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs.join("")}</w:body>` +
    "</w:document>"
  );
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

// --- CRC-32 (IEEE) -------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Assemble `files` into a ZIP archive using the STORE method (no
 * compression). Fully spec-compliant — a STORE-method ZIP is what a
 * minimal `.docx` needs, and Word reads it without complaint.
 */
function zipStore(files: ReadonlyArray<ZipEntry>): Buffer {
  // Fixed DOS datetime (2026-01-01 00:00:00) so renders are reproducible.
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = STORE
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + file.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** Render a deliverable letter to a DOCX document. */
export function renderLetterToDocx(
  title: string,
  sections: ReadonlyArray<LetterSection>,
): Buffer {
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES_XML, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS_XML, "utf8") },
    {
      name: "word/document.xml",
      data: Buffer.from(docxDocumentXml(title, sections), "utf8"),
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/*                              Dispatch                                      */
/* -------------------------------------------------------------------------- */

/** MIME type for a render format. */
export function renderContentType(format: "docx" | "pdf"): string {
  return format === "pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

/** Render a deliverable letter to the requested format. */
export async function renderLetter(
  format: "docx" | "pdf",
  title: string,
  sections: ReadonlyArray<LetterSection>,
): Promise<Buffer> {
  return format === "pdf"
    ? renderLetterToPdf(title, sections)
    : renderLetterToDocx(title, sections);
}
