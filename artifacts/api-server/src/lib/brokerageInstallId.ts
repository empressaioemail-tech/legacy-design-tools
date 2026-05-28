import type { Request, Response } from "express";

export function installIdFromRequest(req: Request): string | null {
  const raw = req.headers["x-hauska-install-id"];
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length >= 8 ? id : null;
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
