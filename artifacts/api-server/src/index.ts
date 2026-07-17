import { ensureCodeAtomSources } from "@workspace/codes";
import { validateMnmlEnvAtBoot } from "@workspace/mnml-client";
import app from "./app";
import { logger } from "./lib/logger";
import { bootstrapAtomRegistry } from "./atoms/registry";
import { validateConverterEnvAtBoot } from "./lib/converterClient";
import { validateHauskaSubstrateEnvAtBoot } from "./lib/hauskaSubstrateClient";
import { validateEngineSpineEnvAtBoot } from "./lib/engineSpineClient";
import { validateFindingEngineEnvAtBoot } from "./lib/findingLlmClient";
import { validateBriefingEngineEnvAtBoot } from "./lib/briefingLlmClient";
import { validateSheetContentEnvAtBoot } from "./lib/sheetContentLlmClient";
import { validateClassificationEnvAtBoot } from "@workspace/submission-classifier";
import { reconcileOrphanedAutopilotRuns } from "./lib/qa/autopilot";
import { ensureBrokerageFederalDataFromGcs } from "./lib/brokerageFederalDataBootstrap";

// Process-level diagnosability safety net. Before this, an unhandled
// rejection vanished silently and an uncaught exception (e.g. an unhandled
// 'error' event on a raw socket / a child-process stdin pipe that EPIPEs
// mid-write — the async terrain worker's exact prod crash) exited the
// container with only Node's default one-line stack on stderr, no structured
// log, taking down every co-scheduled brief/map request with it.
//
// unhandledRejection: LOG with full context and continue. A stray rejection
// should never silently disappear, but it also should not kill the process.
//
// uncaughtException: LOG the full stack through pino FIRST (the diagnosability
// that was missing), then let the process exit. We deliberately do NOT swallow
// it — an uncaughtException means the process may be in an indeterminate state,
// and Cloud Run restarts the container cleanly; the value here is the
// structured log identifying WHICH socket/stream/pipe crashed, not preventing
// the exit. `process.exit(1)` is explicit so the intent is unambiguous and so
// we exit before pino's async transport can lose the line.
process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason },
    "unhandledRejection — logged and swallowed (should be investigated; not crashing the process)",
  );
});

process.on("uncaughtException", (err) => {
  logger.error(
    { err },
    "uncaughtException — logged before exit (process state may be indeterminate; exiting for a clean container restart)",
  );
  // Give pino's transport a tick to flush, then exit. Cloud Run restarts.
  process.exit(1);
});

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

// Fail-fast on misconfigured briefing-engine env: BRIEFING_LLM_MODE
// is required (unset or unknown values throw — no implicit mock);
// when grok we require XAI_API_KEY; when anthropic we require the AI
// Integrations env vars. Mock mode must be requested explicitly with
// BRIEFING_LLM_MODE=mock and then boots clean.
try {
  validateBriefingEngineEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "briefing-engine env validation failed — refusing to start",
  );
  process.exit(1);
}

// Fail-fast on misconfigured sheet-content extractor env (Task #477):
// when SHEET_CONTENT_LLM_MODE=anthropic we require the AI Integrations
// Anthropic env vars. Mock mode is the default and boots clean.
try {
  validateSheetContentEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "sheet-content env validation failed — refusing to start",
  );
  process.exit(1);
}

try {
  validateClassificationEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "classification env validation failed — refusing to start",
  );
  process.exit(1);
}

// Fail-fast on misconfigured Hauska substrate env (QA-17): when
// HAUSKA_SUBSTRATE_MODE=mcp we require HAUSKA_MCP_URL and HAUSKA_MCP_KEY
// (the Code Library's live-catalog read path). Mock mode is the default
// and boots clean with no env config. Same try/catch + process.exit(1)
// pattern as above because pino + the background sweepers are already
// running.
try {
  validateHauskaSubstrateEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "Hauska substrate env validation failed — refusing to start",
  );
  process.exit(1);
}

try {
  validateEngineSpineEnvAtBoot();
} catch (err) {
  logger.error(
    { err },
    "Engine spine env validation failed — refusing to start",
  );
  process.exit(1);
}

// Empressa atom framework: register every catalog atom this artifact owns
// and run the registry's composition validator. This is a hard boot gate
// per `lib/empressa-atom/README.md` — a dangling composition reference
// here would otherwise surface only at the first chat turn that touched
// the broken atom, hours after deploy.
bootstrapAtomRegistry(logger);

// Boot-time autopilot reconciliation runs *before* the HTTP listener
// comes up so the dashboard can never observe a phantom in-flight run
// after a server restart. Reconciliation errors are logged but
// non-fatal — the API surface should still come up so an operator can
// debug from the UI.
async function bootAndListen(): Promise<void> {
  try {
    const reconciled = await reconcileOrphanedAutopilotRuns();
    if (reconciled > 0) {
      logger.warn(
        { count: reconciled },
        "autopilot: reconciled orphaned runs at boot",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "autopilot: boot-time reconciliation failed — continuing",
    );
  }

  try {
    await ensureBrokerageFederalDataFromGcs(logger);
  } catch (err) {
    logger.warn(
      { err },
      "brokerage federal data: GCS bootstrap failed — using image fixtures",
    );
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

void bootAndListen();
