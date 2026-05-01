# Wave 2 — mnml.ai Secrets Handoff

This is the desktop-side handoff note Empressa needs before
`MNML_RENDER_MODE=http` flips on. Until both secrets below are
configured, the api-server runs against the `MockMnmlClient` in
`@workspace/mnml-client` (the default for dev / CI).

DA-RP-INFRA (Task #327) plumbed the pluggable mnml.ai client and
wired boot-time validation; DA-RP-1 wires the trigger endpoint that
actually consumes the client.

## Secrets to configure in GCP Secret Manager

Two secret bindings, both surfaced to Cloud Run via the standard
env-binding path. Naming aligns with the existing
`CONVERTER_URL` / `CONVERTER_SHARED_SECRET` pattern (i.e. plain
upper-case identifiers, no nested namespaces).

| Env var         | Purpose                                                   | Example value                                         |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `MNML_API_URL`  | Base URL for the mnml.ai REST API (no trailing slash).    | `https://api.mnml.ai`                                 |
| `MNML_API_KEY`  | Bearer token sent on every request (`Authorization:` header). | (provisioned by mnml.ai; treat as opaque)         |

Plus the mode flag (set as a regular Cloud Run env var, not a
secret):

| Env var             | Required value | Purpose                                           |
| ------------------- | -------------- | ------------------------------------------------- |
| `MNML_RENDER_MODE`  | `http`         | Selects `HttpMnmlClient`. Defaults to `mock`.     |

When `MNML_RENDER_MODE=http` and either secret is missing, the
api-server entrypoint refuses to start with a clear error message
naming the missing secret(s). Source:
`artifacts/api-server/src/index.ts` → `validateMnmlEnvAtBoot()` →
`lib/mnml-client/src/factory.ts`.

## Order of operations at desktop

1. Provision the mnml.ai API key (Empressa-side; out of band of this repo).
2. Add `MNML_API_URL` + `MNML_API_KEY` to GCP Secret Manager.
3. Bind both secrets to the Cloud Run revision env.
4. Set `MNML_RENDER_MODE=http` in the same revision env.
5. Deploy. Boot logs should show the api-server starting clean. If
   they show `MNML_RENDER_MODE=http requires MNML_API_URL and
   MNML_API_KEY to be set`, the bindings did not propagate — repeat
   step 3.

## Pre-flip verification (mock mode default)

Until step 4 above, the api-server boots in mock mode and the mnml.ai
client is wired but inert (no route consumes it in v1). Confirming
the wiring locally:

- `pnpm --filter @workspace/mnml-client test` exercises the mock +
  http clients + the boot-validation paths.
- `pnpm run typecheck` confirms the singleton + validator are
  importable from `@workspace/mnml-client` and reachable from the
  api-server entrypoint.

## What flips http mode invokes

DA-RP-1 wires the trigger endpoint that calls `getMnmlClient()`. Once
that lands, flipping `MNML_RENDER_MODE=http` switches the singleton
factory to `HttpMnmlClient`, which speaks Spec 54 §5's
`POST /v1/renders` / `GET /v1/renders/{id}` / `DELETE /v1/renders/{id}`
contract against `MNML_API_URL` with the bearer key. No code change
is required to flip — only env config.
