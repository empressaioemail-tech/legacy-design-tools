/**
 * parcel-release-cli: a staged release by --url + --sha256, and pnpm's literal "--" (2026-11-06).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RELEASE_FETCH_FAILED,
  RELEASE_SHA256_MISMATCH,
  RELEASE_URL_REFUSED,
  fetchVerifiedRelease,
  releaseInputFrom,
} from "../txgio/release-fetch";

const BYTES = Buffer.from("PK\u0003\u0004 not a real zip, just bytes to hash");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const URL_OK = "https://hauska-artifacts.nyc3.digitaloceanspaces.com/inputs/txgio-parcels-48021/stratmap22-landparcels_48021_lp.zip";
const okFetch = (async () => new Response(BYTES)) as unknown as typeof fetch;
const noSleep = async () => {};

describe("fetchVerifiedRelease", () => {
  it("FALSIFIER: writes the zip only when its sha256 matches, under its own name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    const got = await fetchVerifiedRelease({ url: URL_OK, sha256: SHA.toUpperCase(), dir, fetchImpl: okFetch, sleep: noSleep });
    expect(got).toEqual({ path: join(dir, "stratmap22-landparcels_48021_lp.zip"), bytes: BYTES.length, sha256: SHA });
    expect(await readFile(got.path)).toEqual(BYTES);
  });

  it("refuses a digest mismatch without retrying and leaves no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    let calls = 0;
    const f = (async () => (calls++, new Response(BYTES))) as unknown as typeof fetch;
    await expect(fetchVerifiedRelease({ url: URL_OK, sha256: "0".repeat(64), dir, fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({ code: RELEASE_SHA256_MISMATCH });
    expect(calls).toBe(1);
    await expect(readFile(join(dir, "stratmap22-landparcels_48021_lp.zip"))).rejects.toThrow();
  });

  it("retries a failed fetch, then succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls < 3) throw new Error("connect timeout");
      return new Response(BYTES);
    }) as unknown as typeof fetch;
    await fetchVerifiedRelease({ url: URL_OK, sha256: SHA, dir, fetchImpl: f, sleep: noSleep });
    expect(calls).toBe(3);
  });

  it("gives up after the attempts, naming the last error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    const f = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchVerifiedRelease({ url: URL_OK, sha256: SHA, dir, fetchImpl: f, sleep: noSleep, attempts: 2 })).rejects.toMatchObject({ code: RELEASE_FETCH_FAILED, message: expect.stringContaining("HTTP 403") });
  });

  it("refuses http, a non-zip name and a malformed digest before fetching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    for (const [url, sha] of [[URL_OK.replace("https:", "http:"), SHA], [URL_OK.replace(".zip", ".exe"), SHA], [URL_OK, "abc"]] as const) {
      await expect(fetchVerifiedRelease({ url, sha256: sha, dir, fetchImpl: okFetch, sleep: noSleep })).rejects.toMatchObject({ code: RELEASE_URL_REFUSED });
    }
  });
});

describe("releaseInputFrom", () => {
  it("takes exactly one input", () => {
    expect(releaseInputFrom({ file: "a.zip" })).toEqual({ kind: "file", file: "a.zip" });
    expect(releaseInputFrom({ url: URL_OK, sha256: SHA })).toEqual({ kind: "url", url: URL_OK, sha256: SHA });
    expect(() => releaseInputFrom({ file: "a.zip", url: URL_OK, sha256: SHA })).toThrow(/not both/);
    expect(() => releaseInputFrom({ url: URL_OK })).toThrow(/go together/);
    expect(() => releaseInputFrom({})).toThrow(/is required/);
  });
});

describe("parcel-release-cli argv", () => {
  it("FALSIFIER: a leading \"--\" (pnpm 10 pass-through) is ignored, not a parse error", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = join(here, "..", "txgio", "parcel-release-cli.ts");
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    const r = spawnSync(process.execPath, [tsxCli, cli, "--", "--county=48021"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "" } });
    expect(r.stderr).not.toContain("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
    expect(r.stderr).toContain("is required");
    expect(r.status).toBe(1);
  }, 90_000);
});
