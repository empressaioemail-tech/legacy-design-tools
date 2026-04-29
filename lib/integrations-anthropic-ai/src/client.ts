import Anthropic from "@anthropic-ai/sdk";

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_BASE_URL must be set. Did you forget to provision the Anthropic AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_API_KEY must be set. Did you forget to provision the Anthropic AI integration?",
  );
}

/**
 * Options for {@link createAnthropicClient}.
 *
 * @property apiKey   Override the env-derived key (rarely needed).
 * @property baseURL  Override the env-derived base URL (rarely needed).
 * @property fetcher  TEST-ONLY. When provided, the SDK will use this instead
 *                    of the global `fetch` for outbound HTTP. Production code
 *                    must NOT pass this — use the `anthropic` singleton or
 *                    call `createAnthropicClient()` with no args.
 */
export interface CreateAnthropicClientOptions {
  apiKey?: string;
  baseURL?: string;
  /** TEST-ONLY: substitute fetch implementation for deterministic test runs. */
  fetcher?: typeof fetch;
}

/**
 * Construct a fresh Anthropic SDK client. The default (no-args) call is
 * equivalent to importing the `anthropic` singleton — same env-derived
 * apiKey and baseURL.
 *
 * Pass `fetcher` ONLY in tests. The Anthropic SDK accepts a `fetch` option
 * with the standard fetch signature; tests can supply a stub that returns
 * canned `Response` objects (including streaming bodies) so the route under
 * test doesn't reach the real network. See artifacts/api-server's chat route
 * tests for an example.
 */
export function createAnthropicClient(
  opts: CreateAnthropicClientOptions = {},
): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
    baseURL: opts.baseURL ?? process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!,
    ...(opts.fetcher ? { fetch: opts.fetcher } : {}),
  });
}

/**
 * Process-wide singleton, retained for backward compatibility with the many
 * callers that imported `anthropic` directly. New code may use either form;
 * tests that need to inject a custom fetch should construct a fresh client
 * via {@link createAnthropicClient} or (more commonly) `vi.mock` this module.
 */
export const anthropic: Anthropic = createAnthropicClient();
