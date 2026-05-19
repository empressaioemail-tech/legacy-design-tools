import express, { type Express, type Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../lib/logger";

/**
 * Mounts the built Vite SPAs as static assets so a single Cloud Run
 * service serves both the `/api` surface and the browser apps. This is
 * the single-service static-serve model chosen in Q2 of the C.2.1
 * Replit-decouple audit — off Replit there is no separate frontend
 * host, so api-server itself serves the SPAs.
 *
 * Gated on the `SPA_STATIC_ROOT` env var:
 *   - Set (the Cloud Run image sets it to `/app/artifacts`): each SPA
 *     is served from `${SPA_STATIC_ROOT}/<name>/dist/public`.
 *   - Unset (local dev): no-op — the SPAs run under their own `vite`
 *     dev servers and api-server stays API-only.
 *
 * `mockup-sandbox` is intentionally NOT served — it is a dev-only UI
 * preview sandbox, not a production surface.
 */

/** Sub-path SPAs — mounted before the root SPA so their prefixes win. */
const SUBPATH_SPAS = [
  { name: "plan-review", mount: "/plan-review" },
  { name: "qa", mount: "/qa" },
] as const;

/** The root SPA — its catch-all must mount LAST (see mountSpaStatic). */
const ROOT_SPA = { name: "design-tools", mount: "/" } as const;

/**
 * One SPA's router: static assets + a client-side-routing fallback to
 * `index.html`. `index.html` is served `no-cache` (a stale bootstrap
 * document would pin the browser to an old build); hashed asset files
 * keep `express.static`'s default caching.
 */
function spaRouter(distDir: string): Router {
  const r = express.Router();
  r.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(`${path.sep}index.html`)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  // Unmatched GET → index.html so wouter client-side routes resolve.
  // Non-GET falls through (these SPA mounts carry no API).
  r.get("*", (req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
  return r;
}

/**
 * Mount the production SPA static surface onto `app`. Call AFTER the
 * `/api` router is registered: the root SPA's catch-all would otherwise
 * swallow `/api/*`. Sub-path SPAs are registered before the root SPA so
 * `/plan-review/*` and `/qa/*` match their own routers first.
 */
export function mountSpaStatic(app: Express): void {
  const root = process.env["SPA_STATIC_ROOT"];
  if (!root) {
    logger.info(
      "SPA_STATIC_ROOT unset — SPA static-serving disabled (dev mode)",
    );
    return;
  }

  for (const spa of SUBPATH_SPAS) {
    const distDir = path.join(root, spa.name, "dist", "public");
    if (!fs.existsSync(distDir)) {
      logger.warn(
        { spa: spa.name, distDir },
        "SPA dist dir missing — skipping mount",
      );
      continue;
    }
    app.use(spa.mount, spaRouter(distDir));
    logger.info({ spa: spa.name, mount: spa.mount }, "mounted SPA static");
  }

  const rootDist = path.join(root, ROOT_SPA.name, "dist", "public");
  if (fs.existsSync(rootDist)) {
    app.use(ROOT_SPA.mount, spaRouter(rootDist));
    logger.info(
      { spa: ROOT_SPA.name, mount: ROOT_SPA.mount },
      "mounted SPA static (root)",
    );
  } else {
    logger.warn(
      { distDir: rootDist },
      "design-tools dist dir missing — root SPA not mounted",
    );
  }
}
