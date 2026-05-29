import type { Request } from "express";
import Busboy from "busboy";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface ParsedPdfUpload {
  bytes: Buffer;
  filename: string;
  contentType: string;
  workspaceDid?: string;
}

export function consumePdfUpload(
  req: Request,
): Promise<
  | { ok: true; upload: ParsedPdfUpload }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 5 },
      });
    } catch {
      resolve({ ok: false, status: 400, error: "invalid_multipart" });
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let fileSeen = false;
    let filename = "upload.pdf";
    let contentType = "application/pdf";
    let workspaceDid: string | undefined;
    let aborted = false;

    function abort(status: number, error: string) {
      if (aborted) return;
      aborted = true;
      try {
        req.unpipe(busboy);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status, error });
    }

    busboy.on("field", (name, value) => {
      if (name === "filename" && value) filename = value;
      if (name === "contentType" && value) contentType = value;
      if (name === "workspaceDid" && value) workspaceDid = value;
    });

    busboy.on(
      "file",
      (
        name: string,
        stream: NodeJS.ReadableStream,
        info: { filename: string; mimeType: string },
      ) => {
        if (aborted) {
          stream.resume();
          return;
        }
        if (name !== "file" && name !== "pdf") {
          stream.resume();
          return;
        }
        fileSeen = true;
        if (info.filename) filename = info.filename;
        if (info.mimeType) contentType = info.mimeType;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_PDF_BYTES) {
            truncated = true;
            return;
          }
          chunks.push(chunk);
        });
        stream.on("limit", () => {
          truncated = true;
        });
      },
    );

    busboy.on("error", () => abort(400, "multipart_parse_failed"));
    busboy.on("finish", () => {
      if (aborted) return;
      if (!fileSeen) {
        abort(400, "missing_pdf_part");
        return;
      }
      if (truncated) {
        abort(413, "pdf_too_large");
        return;
      }
      resolve({
        ok: true,
        upload: {
          bytes: Buffer.concat(chunks, total),
          filename,
          contentType: contentType.toLowerCase().includes("pdf")
            ? contentType
            : "application/pdf",
          workspaceDid,
        },
      });
    });

    req.pipe(busboy);
  });
}
