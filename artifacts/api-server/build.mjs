import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    // Two entry points: the server itself, and the IFC parse worker
    // (QA-16). esbuild's outbase is their common ancestor `src/`, so they
    // land at `dist/index.mjs` and `dist/lib/ifcParser/ifcParseWorker.mjs`
    // respectively — the path `workerClient.ts` resolves at runtime.
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/lib/ifcParser/ifcParseWorker.ts"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Add ONLY the custom "workspace" export condition. The `@empressaio/*`
    // workspace packages carry it pointing at their TS source (./src); their
    // dist/ is NOT prebuilt in the Docker build context, so a *value* import
    // (e.g. TILE_CAPABILITIES from @empressaio/cortex-client in planReviewBff.ts)
    // would otherwise resolve to the missing dist/index.mjs and fail the build.
    //
    // CRITICAL: do NOT also list "import"/"default" here. esbuild layers this
    // list on top of its format/platform defaults, but listing "import"
    // explicitly promotes it ABOVE "require" for every dual-package dependency
    // — which flips pg (and others) from their CJS entry to a broken ESM
    // wrapper and crashes the container at boot ("Class extends value
    // #<Object>"). "workspace" is a bespoke condition only the @empressaio/*
    // packages declare, so adding just it changes resolution for nothing else.
    // Type-only imports are erased before resolution, which is why the
    // pre-existing type imports built fine without this. Mirrors the
    // resolve.conditions:["workspace"] in codex-reviewer-qa/vite.config.ts and
    // artifacts/api-server/vitest.config.ts.
    conditions: ["workspace"],
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      // web-ifc ships a Node-side WASM artifact that the JS entry resolves
      // via `fs.readFileSync(__dirname + '/web-ifc-node.wasm')`. Bundling
      // would point __dirname at dist/ where the wasm doesn't exist;
      // externalizing keeps the require resolving against node_modules/web-ifc/
      // where the .wasm sits next to the JS. Same pattern as @google-cloud/* /
      // puppeteer above.
      "web-ifc",
      "web-ifc/web-ifc-api-node.js",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
