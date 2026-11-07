/**
 * Fetch a staged TxGIO release zip by URL and prove its bytes (2026-11-06).
 *
 * The cluster Job for parcel-release-cli has no local file: integration stages each release
 * (CC0) as a public object and gives the Job its URL and sha256. This downloads it into the
 * Job's scratch dir, hashes what arrived, and refuses a mismatch (deleting the file), so a
 * truncated, swapped or stale object is never loaded. https only. Retries a failed or timed-out
 * fetch: the 2026-11-05 addressRanges Job's first fetch hit a connect timeout on a node that had
 * been up for seconds.
 */
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RELEASE_SHA256_MISMATCH = "RELEASE_SHA256_MISMATCH";
export const RELEASE_FETCH_FAILED = "RELEASE_FETCH_FAILED";
export const RELEASE_URL_REFUSED = "RELEASE_URL_REFUSED";

export class ReleaseFetchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export type ReleaseInput = { kind: "file"; file: string } | { kind: "url"; url: string; sha256: string };

/** Exactly one input: a local --file, or a staged --url with its --sha256. Throws on anything else. */
export function releaseInputFrom(values: { file?: string; url?: string; sha256?: string }): ReleaseInput {
  const hasFile = values.file !== undefined;
  const hasUrl = values.url !== undefined || values.sha256 !== undefined;
  if (hasFile && hasUrl) throw new ReleaseFetchError(RELEASE_URL_REFUSED, "pass --file OR --url with --sha256, not both");
  if (hasUrl) {
    if (!values.url || !values.sha256) throw new ReleaseFetchError(RELEASE_URL_REFUSED, "--url and --sha256 go together");
    return { kind: "url", url: values.url, sha256: values.sha256 };
  }
  if (!hasFile) {
    throw new ReleaseFetchError(
      RELEASE_URL_REFUSED,
      "--file=<local release zip or dir>, or --url=<https .zip> with --sha256=<hex>, is required (the TxGIO host refuses non-browser downloads)",
    );
  }
  return { kind: "file", file: values.file! };
}

export interface FetchVerifiedReleaseOptions {
  url: string;
  sha256: string;
  dir: string;
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Validate the URL and digest, download with retries, write to `dir`, and return the path. */
export async function fetchVerifiedRelease(opts: FetchVerifiedReleaseOptions): Promise<{ path: string; bytes: number; sha256: string }> {
  const { dir, attempts = 8, timeoutMs = 120_000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  const want = String(opts.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new ReleaseFetchError(RELEASE_URL_REFUSED, "--sha256 must be 64 hex characters");
  let u: URL;
  try {
    u = new URL(String(opts.url ?? "").trim());
  } catch {
    throw new ReleaseFetchError(RELEASE_URL_REFUSED, "--url is not a URL");
  }
  if (u.protocol !== "https:") throw new ReleaseFetchError(RELEASE_URL_REFUSED, "--url must be https");
  const name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(name)) throw new ReleaseFetchError(RELEASE_URL_REFUSED, `--url must name a .zip file, got "${name}"`);

  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha256").update(buf).digest("hex");
      const path = join(dir, name);
      if (got !== want) {
        await rm(path, { force: true });
        throw new ReleaseFetchError(RELEASE_SHA256_MISMATCH, `${name}: sha256 ${got} != expected ${want}`);
      }
      await writeFile(path, buf);
      return { path, bytes: buf.length, sha256: got };
    } catch (e) {
      if (e instanceof ReleaseFetchError) throw e; // a wrong digest is not retried
      lastError = (e as Error).message;
      if (i < attempts) await sleep(Math.min(30_000, 2_000 * i));
    }
  }
  throw new ReleaseFetchError(RELEASE_FETCH_FAILED, `${name}: ${attempts} attempts failed; last: ${lastError}`);
}
