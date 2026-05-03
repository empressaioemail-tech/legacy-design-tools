/**
 * Task #481 — QA Dashboard API helpers.
 *
 * The QA Dashboard runs at `BASE_URL = "/qa/"`; the api-server is
 * mounted at the root path `/api/...` via the workspace proxy. We
 * therefore intentionally bypass the artifact base URL when talking
 * to the API by using absolute root-relative paths.
 *
 * `apiUrl` exists so SSE / EventSource (which the generated hooks
 * don't cover) lines up with the same convention.
 */

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiUrl: path must start with "/", got: ${path}`);
  }
  return path;
}
