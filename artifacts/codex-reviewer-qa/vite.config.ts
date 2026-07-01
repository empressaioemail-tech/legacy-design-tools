import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

/**
 * Codex Reviewer QA — Vite build config. Mirrors the sibling artifacts
 * (`plan-review` is the closest reference). The artifact is served by
 * api-server's `mountSpaStatic` under the `/codex-reviewer-qa/` path
 * prefix, so `base` defaults to that prefix.
 */

function resolvePort(command: "serve" | "build"): number | undefined {
  const rawPort = process.env.PORT;
  if (!rawPort) {
    if (command === "serve") {
      throw new Error(
        "PORT environment variable is required but was not provided.",
      );
    }
    return undefined;
  }
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  return port;
}

function resolveBasePath(): string {
  return process.env.BASE_PATH ?? "/codex-reviewer-qa/";
}

export default defineConfig(({ command }) => {
  const port = resolvePort(command);
  const basePath = resolveBasePath();

  return {
    base: basePath,
    define: {
      "process.env": {},
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "node:crypto": path.resolve(import.meta.dirname, "src/crypto-browser-stub.ts"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
      proxy: {
        "/api": {
          target: `http://localhost:${process.env.API_PORT ?? 8080}`,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
