/**
 * Pure parser for the Grand County IWUIC PDF.
 *
 * Holds the heuristic header chunker so it can be tested directly from
 * pre-extracted text without invoking pdf-parse-fork on a live HTTP fetch.
 */

export interface PdfChunk {
  ref: string | null;
  title: string | null;
  body: string;
}

/** Hard cap per chunk for embedding model context safety. */
export const MAX_CHARS_PER_CHUNK = 4000;

/**
 * Chunk the IWUIC PDF text into atomic sections. Splits on:
 *   - "CHAPTER N" / "CHAPTER N - TITLE"
 *   - "SECTION NNN" / "SECTION NNN - TITLE"
 *   - subsection headers like "401.1 General." (capitalized title <= 80 chars)
 *
 * Chunks larger than {@link MAX_CHARS_PER_CHUNK} are split into `…#partN`
 * children with a parallel suffix on the title.
 */
export function chunkByHeader(text: string): PdfChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: PdfChunk[] = [];

  let curRef: string | null = null;
  let curTitle: string | null = null;
  let curBuf: string[] = [];

  const flush = () => {
    const body = curBuf.join("\n").trim();
    if (body.length > 0) {
      chunks.push({ ref: curRef, title: curTitle, body });
    }
    curBuf = [];
  };

  const chapterRe = /^(CHAPTER\s+\d+)(?:\s*[-—–]\s*(.+))?$/;
  const sectionRe = /^(SECTION\s+\d+)(?:\s*[-—–]\s*(.+))?$/;
  const subsectionRe = /^(\d{3,}(?:\.\d+)+)\s+([A-Z][^.]{0,80}\.)\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      curBuf.push("");
      continue;
    }
    const ch = chapterRe.exec(line);
    const sec = sectionRe.exec(line);
    const sub = subsectionRe.exec(line);
    if (ch) {
      flush();
      curRef = ch[1];
      curTitle = ch[2] ? ch[2].trim() : ch[1];
    } else if (sec) {
      flush();
      curRef = sec[1];
      curTitle = sec[2] ? sec[2].trim() : sec[1];
    } else if (sub) {
      flush();
      curRef = sub[1];
      curTitle = sub[2].trim();
      curBuf.push(line);
    } else {
      curBuf.push(line);
    }
  }
  flush();

  const out: PdfChunk[] = [];
  for (const c of chunks) {
    if (c.body.length <= MAX_CHARS_PER_CHUNK) {
      out.push(c);
      continue;
    }
    let i = 0;
    let part = 1;
    while (i < c.body.length) {
      const slice = c.body.slice(i, i + MAX_CHARS_PER_CHUNK);
      out.push({
        ref: c.ref ? `${c.ref}#part${part}` : null,
        title: c.title ? `${c.title} (part ${part})` : null,
        body: slice,
      });
      i += MAX_CHARS_PER_CHUNK;
      part += 1;
    }
  }
  return out;
}
