import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

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
  return process.env.BASE_PATH ?? "/";
}

export default defineConfig(({ command }) => {
  const port = resolvePort(command);
  const basePath = resolveBasePath();

  return {
    base: basePath,
    define: {
      "process.env": {},
    },
    plugins: [
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
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
      // Local Windows dev: Replit's workspace proxy normally routes /api → api-server.
      // Note: on Replit the workspace proxy at :80 claims `/api` for the
      // api-server service before this vite proxy gets a chance, so the
      // default below only matters when you `curl http://127.0.0.1:$PORT/api/…`
      // directly past the workspace proxy.
      proxy: {
        "/api": {
          target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8080",
          changeOrigin: true,
        },
      },
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
