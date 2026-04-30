import { ensureCodeAtomSources } from "@workspace/codes";
import app from "./app";
import { logger } from "./lib/logger";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
