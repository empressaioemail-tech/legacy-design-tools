import { PLACID_API_BASE, placidApiToken, placidTestMode } from "./config";

export type PlacidPdfPage = {
  template_uuid: string;
  layers: Record<
    string,
    { text?: string; image?: string } | { text: string } | { image: string }
  >;
};

export type PlacidPdfCreateResponse = {
  id: number | string;
  status: string;
  pdf_url?: string | null;
  polling_url?: string;
  error?: string;
};

const RATE_LIMIT_MS = 1_100;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function placidFetch(
  path: string,
  init?: RequestInit,
  attempt = 0,
): Promise<Response> {
  const token = placidApiToken();
  if (!token) throw new Error("PLACID_API_TOKEN not configured");
  await throttle();
  const res = await fetch(`${PLACID_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "2");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return placidFetch(path, init, attempt + 1);
  }
  return res;
}

export async function createPlacidPdf(params: {
  pages: PlacidPdfPage[];
  passthrough?: string;
}): Promise<PlacidPdfCreateResponse> {
  const body: Record<string, unknown> = {
    pages: params.pages,
  };
  if (params.passthrough) body.passthrough = params.passthrough;
  if (placidTestMode()) body.test = true;

  const res = await placidFetch("/pdfs", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as PlacidPdfCreateResponse & {
    message?: string;
  };
  if (!res.ok) {
    throw new Error(json.message ?? json.error ?? `Placid POST failed (${res.status})`);
  }
  return json;
}

export async function getPlacidPdf(
  pdfId: string | number,
): Promise<PlacidPdfCreateResponse> {
  const res = await placidFetch(`/pdfs/${pdfId}`);
  const json = (await res.json()) as PlacidPdfCreateResponse & { message?: string };
  if (!res.ok) {
    throw new Error(json.message ?? json.error ?? `Placid GET failed (${res.status})`);
  }
  return json;
}
