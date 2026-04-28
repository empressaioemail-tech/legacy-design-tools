/**
 * Direct Node HTTP client against api.municode.com.
 *
 * Replaces the originally-spec'd Skatterbrainz/MunicipalMCP Python subprocess.
 * Same JSON endpoints, no protocol wrapping, no language-runtime drift.
 *
 * Politeness layer (single global queue):
 *   - p-queue concurrency = 1
 *   - minimum 1.5s delay between requests + 0–1s jitter
 *   - daily cap, default 500 (env: MUNICODE_DAILY_REQUEST_CAP)
 *   - retry 429 / 5xx with exponential backoff (1s, 2s, 4s)
 *   - no retry on other 4xx; throws MunicodeError with status + body
 *   - User-Agent: "Hauska-CodeAtoms/0.1 (+nick@hauska.io)" (env override:
 *     MUNICODE_USER_AGENT)
 */

import PQueue from "p-queue";
import { MUNICODE_API_BASE, ENDPOINTS } from "./endpoints";

export class MunicodeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "MunicodeError";
  }
}

export class MunicodeDailyCapExceeded extends Error {
  constructor(public readonly cap: number, public readonly used: number) {
    super(
      `Municode daily request cap exceeded: ${used}/${cap}. ` +
        `Resets at next UTC midnight. Set MUNICODE_DAILY_REQUEST_CAP to raise.`,
    );
    this.name = "MunicodeDailyCapExceeded";
  }
}

const userAgent =
  process.env.MUNICODE_USER_AGENT ?? "Hauska-CodeAtoms/0.1 (+nick@hauska.io)";
const dailyCap = Number(process.env.MUNICODE_DAILY_REQUEST_CAP ?? "500");

const queue = new PQueue({ concurrency: 1 });

let lastRequestTs = 0;
let dailyUsed = 0;
let dailyResetTs = nextUtcMidnight();

function nextUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  return next.getTime();
}

function rollDailyCounter() {
  if (Date.now() >= dailyResetTs) {
    dailyUsed = 0;
    dailyResetTs = nextUtcMidnight();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawRequest {
  path: string;
  params: Readonly<Record<string, string | number | boolean | undefined>>;
}

function buildUrl(req: RawRequest): string {
  const url = new URL(MUNICODE_API_BASE + req.path);
  for (const [k, v] of Object.entries(req.params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function performOnce(req: RawRequest): Promise<unknown> {
  // Spacing: 1.5s minimum + 0..1s jitter from the previous successful start.
  const minGapMs = 1500;
  const jitter = Math.floor(Math.random() * 1000);
  const wait = Math.max(0, lastRequestTs + minGapMs + jitter - Date.now());
  if (wait > 0) await delay(wait);

  rollDailyCounter();
  if (dailyUsed >= dailyCap) {
    throw new MunicodeDailyCapExceeded(dailyCap, dailyUsed);
  }

  const url = buildUrl(req);
  lastRequestTs = Date.now();
  dailyUsed += 1;

  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 204) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new MunicodeError(
      `Municode ${req.path} -> HTTP ${res.status}`,
      res.status,
      body.slice(0, 500),
    );
    throw err;
  }
  return await res.json();
}

async function performWithRetry(req: RawRequest): Promise<unknown> {
  const backoffs = [1000, 2000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await performOnce(req);
    } catch (err) {
      lastErr = err;
      const status = err instanceof MunicodeError ? err.status : 0;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === backoffs.length) {
        throw err;
      }
      await delay(backoffs[attempt]);
    }
  }
  throw lastErr;
}

export async function municodeGet<T = unknown>(req: RawRequest): Promise<T> {
  const result = await queue.add(() => performWithRetry(req));
  return result as T;
}

export interface MunicodeStats {
  dailyUsed: number;
  dailyCap: number;
  dailyResetIso: string;
  userAgent: string;
}

export function municodeStats(): MunicodeStats {
  rollDailyCounter();
  return {
    dailyUsed,
    dailyCap,
    dailyResetIso: new Date(dailyResetTs).toISOString(),
    userAgent,
  };
}

// High-level typed wrappers ---------------------------------------------------

export interface MunicodeClientInfo {
  ClientID: number;
  ClientName: string;
  City?: string;
  ZipCode?: number | string;
  Website?: string;
}

export interface MunicodeCodeProduct {
  productName: string;
  productId: number;
  publicationId?: number;
  latestUpdatedDate?: string;
}

export interface MunicodeJob {
  Id: number;
  Name: string;
  ProductId: number;
}

export interface MunicodeTocNode {
  Id: string;
  Heading: string;
  ParentId: string;
  NodeDepth: number;
  HasChildren: boolean;
  DocOrderId: number;
}

export interface MunicodeDoc {
  Id: string;
  Title: string;
  Content: string | null;
  NodeDepth: number;
  DocOrderId: number;
  TitleHtml: string | null;
  IsAmended: boolean;
  IsUpdated: boolean;
}

export interface MunicodeContentEnvelope {
  Docs: MunicodeDoc[];
  PdfUrl: string | null;
  ShowToc: boolean;
}

export async function getClientByName(
  clientName: string,
  stateAbbr: string,
): Promise<MunicodeClientInfo | null> {
  const data = await municodeGet<MunicodeClientInfo | null>(
    ENDPOINTS.clientByName(clientName, stateAbbr),
  );
  return data && typeof data === "object" && "ClientID" in data ? data : null;
}

export async function getClientContent(
  clientId: number,
): Promise<{ codes: MunicodeCodeProduct[] }> {
  return await municodeGet<{ codes: MunicodeCodeProduct[] }>(
    ENDPOINTS.clientContent(clientId),
  );
}

export async function getLatestJob(productId: number): Promise<MunicodeJob | null> {
  return await municodeGet<MunicodeJob | null>(ENDPOINTS.jobsLatest(productId));
}

export async function getTocChildren(
  jobId: number,
  productId: number,
  nodeId?: string,
): Promise<MunicodeTocNode[]> {
  const data = await municodeGet<MunicodeTocNode[]>(
    ENDPOINTS.codesTocChildren(jobId, productId, nodeId),
  );
  return Array.isArray(data) ? data : [];
}

export async function getCodesContent(
  jobId: number,
  productId: number,
  nodeId: string,
): Promise<MunicodeContentEnvelope> {
  return await municodeGet<MunicodeContentEnvelope>(
    ENDPOINTS.codesContent(jobId, productId, nodeId),
  );
}
