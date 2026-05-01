import { ensureCodeAtomSources } from "@workspace/codes";
import app from "./app";
import { logger } from "./lib/logger";
import { bootstrapAtomRegistry } from "./atoms/registry";
import { validateConverterEnvAtBoot } from "./lib/converterClient";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Idempotent boot-time data bootstrap: ensure the small registry of
// `code_atom_sources` rows required by the warmup orchestrator exists.
// This self-heals fresh environments (e.g. a freshly provisioned prod DB)
// without requiring an out-of-band seed step. Any row-level failures are
// logged inside ensureCodeAtomSources and do NOT crash the server — the
// API surface stays available so the operator can debug from the UI.
ensureCodeAtomSources(logger).catch((err) => {
  logger.error(
    { err },
    "ensureCodeAtomSources: unexpected boot-time failure — continuing",
  );
});

// Fail-fast on misconfigured DXF converter env (DA-MV-1): when
// DXF_CONVERTER_MODE=http we require CONVERTER_URL and
// CONVERTER_SHARED_SECRET. Surfaces at boot rather than at the first
// upload so a bad deploy is caught immediately.
validateConverterEnvAtBoot();

// Empressa atom framework: register every catalog atom this artifact owns
// and run the registry's composition validator. This is a hard boot gate
// per `lib/empressa-atom/README.md` — a dangling composition reference
// here would otherwise surface only at the first chat turn that touched
// the broken atom, hours after deploy.
bootstrapAtomRegistry(logger);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
