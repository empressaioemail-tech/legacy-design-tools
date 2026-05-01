/**
 * Pluggable {@link MnmlClient} factory + lazy process-wide singleton +
 * test-override hooks. Mirrors the converter-client lifecycle in
 * `artifacts/api-server/src/lib/converterClient.ts:430-500`:
 *
 *   - {@link createMnmlClient}            — env-driven constructor (mode = mock | http)
 *   - {@link getMnmlClient}               — lazy singleton accessor
 *   - {@link setMnmlClient}               — test-override (pass `null` to reset)
 *   - {@link validateMnmlEnvAtBoot}       — fail-fast at boot when http mode is missing secrets
 *   - {@link __mnmlClientIsFromEnvForTests} — test inspector
 *
 * Env contract:
 *   - `MNML_RENDER_MODE`  default `"mock"`. `"http"` selects {@link HttpMnmlClient}.
 *   - `MNML_API_URL`      required when mode === `"http"`.
 *   - `MNML_API_KEY`      required when mode === `"http"`.
 *
 * The two http-mode secrets are configured in GCP Secret Manager and
 * surfaced to Cloud Run via the standard env-binding path. See
 * `docs/wave-2/02-mnml-secrets-handoff.md` for Empressa's desktop-side
 * configuration steps.
 */

import { HttpMnmlClient } from "./httpClient";
import { MockMnmlClient } from "./mockClient";
import {
  type MnmlClient,
  type MnmlLogger,
} from "./types";

export type MnmlRenderMode = "mock" | "http";

export interface CreateMnmlClientOptions {
  /**
   * Test-injectable fetch impl forwarded to {@link HttpMnmlClient}.
   * Ignored in mock mode. Mirrors {@link createAnthropicClient}'s
   * fetcher convention.
   */
  fetcher?: typeof fetch;
  /** Optional structured logger forwarded to {@link HttpMnmlClient}. */
  logger?: MnmlLogger;
}

/** Read + normalize the env mode flag. Default `"mock"`. */
export function resolveMnmlRenderMode(): MnmlRenderMode {
  const raw = (process.env.MNML_RENDER_MODE ?? "mock").toLowerCase();
  return raw === "http" ? "http" : "mock";
}

/**
 * Construct a fresh {@link MnmlClient} from env. Each call reads env
 * anew, so callers wanting the cached process-wide singleton should
 * use {@link getMnmlClient} instead.
 *
 * Throws (with a human-readable message naming the missing secret(s))
 * when mode === `"http"` and either `MNML_API_URL` or `MNML_API_KEY`
 * is absent.
 */
export function createMnmlClient(
  opts: CreateMnmlClientOptions = {},
): MnmlClient {
  const mode = resolveMnmlRenderMode();
  if (mode === "http") {
    const url = process.env.MNML_API_URL;
    const key = process.env.MNML_API_KEY;
    if (!url || !key) {
      throw new Error(missingSecretsMessage(url, key));
    }
    return new HttpMnmlClient({
      baseUrl: url,
      apiKey: key,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }
  return new MockMnmlClient();
}

let cached: MnmlClient | null = null;
let cachedFromEnv = true;

/** Lazily-resolved process-wide singleton; tests override via {@link setMnmlClient}. */
export function getMnmlClient(): MnmlClient {
  if (cached) return cached;
  cached = createMnmlClient();
  cachedFromEnv = true;
  return cached;
}

/**
 * Test-override: pass a fake client to pin the singleton, or `null`
 * to reset the cache (the next {@link getMnmlClient} call re-reads
 * `MNML_RENDER_MODE`).
 */
export function setMnmlClient(client: MnmlClient | null): void {
  cached = client;
  cachedFromEnv = client === null;
}

/**
 * Boot-time fail-fast: refuse to start when mode === `"http"` and
 * either secret is missing. Called from
 * `artifacts/api-server/src/index.ts` alongside
 * {@link validateConverterEnvAtBoot} so misconfiguration surfaces at
 * boot rather than at the first render attempt.
 */
export function validateMnmlEnvAtBoot(): void {
  const mode = resolveMnmlRenderMode();
  if (mode !== "http") return;
  const url = process.env.MNML_API_URL;
  const key = process.env.MNML_API_KEY;
  if (!url || !key) {
    throw new Error(missingSecretsMessage(url, key));
  }
}

/** Test-only: reports whether the cached client came from the env factory. */
export function __mnmlClientIsFromEnvForTests(): boolean {
  return cachedFromEnv;
}

function missingSecretsMessage(
  url: string | undefined,
  key: string | undefined,
): string {
  const missing: string[] = [];
  if (!url) missing.push("MNML_API_URL");
  if (!key) missing.push("MNML_API_KEY");
  return `MNML_RENDER_MODE=http requires ${missing.join(" and ")} to be set`;
}
