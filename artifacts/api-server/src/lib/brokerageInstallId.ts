import type { Request, Response } from "express";

function normalizeInstallId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length >= 8 ? id : null;
}

export function installIdFromRequest(req: Request): string | null {
  return normalizeInstallId(req.headers["x-hauska-install-id"]);
}

/** Extension web-auth signup may pass install id via header, JSON body, or query. */
export function signupInstallIdFromRequest(
  req: Request,
  body?: { installId?: string; install_id?: string },
): string | null {
  const fromHeader = installIdFromRequest(req);
  if (fromHeader) return fromHeader;
  const fromBody = normalizeInstallId(body?.installId ?? body?.install_id);
  if (fromBody) return fromBody;
  const query = req.query.install_id ?? req.query.installId;
  const fromQuery = normalizeInstallId(
    Array.isArray(query) ? query[0] : query,
  );
  return fromQuery;
}

export function pipedriveInstallIdForSignup(
  req: Request,
  userId: string,
  body?: { installId?: string; install_id?: string },
): string {
  return (
    signupInstallIdFromRequest(req, body) ??
    `hauska-user-${userId.replace(/^user_/, "").slice(0, 24)}`
  );
}

export function requireInstallId(
  req: Request,
  res: Response,
): string | null {
  const installId = installIdFromRequest(req);
  if (!installId) {
    res.status(400).json({
      error: "install_id_required",
      message: "X-Hauska-Install-Id header is required",
    });
    return null;
  }
  return installId;
}
