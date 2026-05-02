import { ensureCodeAtomSources } from "@workspace/codes";
import { validateMnmlEnvAtBoot } from "@workspace/mnml-client";
import app from "./app";
import { logger } from "./lib/logger";
import { bootstrapAtomRegistry } from "./atoms/registry";
import { validateConverterEnvAtBoot } from "./lib/converterClient";
import { validateFindingEngineEnvAtBoot } from "./lib/findingLlmClient";

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

// Fail-fast on misconfigured mnml.ai render env (DA-RP-INFRA, Spec
// 54 §5): when MNML_RENDER_MODE=http we require MNML_API_URL and
// MNML_API_KEY (configured in GCP Secret Manager — see
// `docs/wave-2/02-mnml-secrets-handoff.md`). Mock mode is the
// default and boots clean with no env config. The client itself is
// wired (lazy singleton in `@workspace/mnml-client`) but NOT yet
// invoked from any route — DA-RP-1 wires the trigger endpoint that
// consumes it.
//
// We wrap with an explicit log + process.exit(1) because the import
// of `./app` above has already started pino's worker threads and the
// background sweepers — a bare top-level throw would surface as an
// uncaught exception but the worker threads would keep the event
// loop alive (no HTTP listener, no useful error in the boot log).
// Logging + exiting matches the "fail-fast at boot with a clear
// error message naming the missing secret(s)" contract.
try {
  validateMnmlEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "mnml.ai env validation failed — refusing to start",
  );
  process.exit(1);
}

// Fail-fast on misconfigured finding-engine env (V1-1 / AIR-1): when
// AIR_FINDING_LLM_MODE=anthropic we require the AI Integrations
// Anthropic env vars. Mock mode is the default and boots clean with
// no env config. Same try/catch + process.exit(1) pattern as above
// because pino + the background sweepers are already running.
try {
  validateFindingEngineEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "finding-engine env validation failed — refusing to start",
  );
  process.exit(1);
}

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
