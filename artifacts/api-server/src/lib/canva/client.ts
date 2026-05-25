import { CANVA_API_BASE } from "./config";
import { refreshAccessToken } from "./oauth";
import type { CanvaBrandTemplate, CanvaTemplateSlot } from "./wireTypes";
import { FALLBACK_BRAND_TEMPLATES } from "./catalog";

export type CanvaConnectionRow = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  displayName: string;
  avatarUrl: string | null;
};

export async function canvaFetch(
  connection: CanvaConnectionRow,
  path: string,
  init?: RequestInit,
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<Response> {
  let token = connection.accessToken;
  if (connection.expiresAt.getTime() <= Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(connection.refreshToken);
    token = refreshed.access_token;
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await onTokensRefreshed?.({
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt,
    });
    connection.accessToken = refreshed.access_token;
    connection.refreshToken = refreshed.refresh_token;
    connection.expiresAt = expiresAt;
  }
  const url = path.startsWith("http") ? path : `${CANVA_API_BASE}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

export async function fetchCanvaProfile(
  connection: CanvaConnectionRow,
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<{ displayName: string; avatarUrl?: string }> {
  const res = await canvaFetch(connection, "/users/me", {}, onTokensRefreshed);
  if (!res.ok) {
    return { displayName: "Canva user" };
  }
  const data = (await res.json()) as {
    profile?: { display_name?: string; avatar_url?: string };
  };
  return {
    displayName: data.profile?.display_name ?? "Canva user",
    avatarUrl: data.profile?.avatar_url,
  };
}

type CanvaBrandTemplateItem = {
  id: string;
  name: string;
  thumbnail?: { url?: string };
  page_count?: number;
};

function mapDatasetToSlots(
  dataset: Record<string, { type?: string; label?: string }> | undefined,
): CanvaTemplateSlot[] {
  if (!dataset) return [];
  return Object.entries(dataset).map(([key, field]) => {
    if (field.type === "text") {
      return { key, type: "text" as const, label: field.label ?? key };
    }
    return {
      key,
      type: "image" as const,
      label: field.label ?? key,
      accepts: ["render", "floorplan", "sheet", "site-context"] as const,
    };
  });
}

export async function listBrandTemplatesFromCanva(
  connection: CanvaConnectionRow,
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<CanvaBrandTemplate[] | "enterprise_required"> {
  const res = await canvaFetch(
    connection,
    "/brand-templates?dataset_filter=non_empty",
    {},
    onTokensRefreshed,
  );
  if (res.status === 403 || res.status === 404) {
    return "enterprise_required";
  }
  if (!res.ok) {
    return "enterprise_required";
  }
  const body = (await res.json()) as { items?: CanvaBrandTemplateItem[] };
  const items = body.items ?? [];
  if (items.length === 0) {
    return "enterprise_required";
  }
  const templates: CanvaBrandTemplate[] = [];
  for (const item of items.slice(0, 24)) {
    let slots: CanvaTemplateSlot[] = [];
    try {
      const dsRes = await canvaFetch(
        connection,
        `/brand-templates/${item.id}/dataset`,
        {},
        onTokensRefreshed,
      );
      if (dsRes.ok) {
        const dsBody = (await dsRes.json()) as {
          dataset?: Record<string, { type?: string; label?: string }>;
        };
        slots = mapDatasetToSlots(dsBody.dataset);
      }
    } catch {
      /* best-effort slots */
    }
    templates.push({
      id: item.id,
      name: item.name,
      thumbnailUrl: item.thumbnail?.url ?? FALLBACK_BRAND_TEMPLATES[0]!.thumbnailUrl,
      tags: [],
      pageCount: item.page_count ?? 1,
      slots,
    });
  }
  return templates;
}

export async function uploadAssetFromUrl(
  connection: CanvaConnectionRow,
  name: string,
  imageUrl: string,
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<string> {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to fetch asset bytes: ${imageUrl}`);
  }
  const blob = await imgRes.blob();
  const contentType = imgRes.headers.get("content-type") ?? "image/png";
  const form = new FormData();
  form.append("asset", new Blob([await blob.arrayBuffer()], { type: contentType }), name);
  const res = await canvaFetch(
    connection,
    "/assets",
    { method: "POST", body: form },
    onTokensRefreshed,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva asset upload failed: ${text}`);
  }
  const data = (await res.json()) as { asset?: { id?: string } };
  const assetId = data.asset?.id;
  if (!assetId) {
    throw new Error("Canva asset upload missing asset id");
  }
  return assetId;
}

export async function createAutofillJob(
  connection: CanvaConnectionRow,
  params: {
    brandTemplateId: string;
    title: string;
    data: Record<string, unknown>;
  },
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<string> {
  const res = await canvaFetch(
    connection,
    "/autofills",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand_template_id: params.brandTemplateId,
        title: params.title,
        data: params.data,
      }),
    },
    onTokensRefreshed,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva autofill create failed: ${text}`);
  }
  const body = (await res.json()) as { job?: { id?: string } };
  const jobId = body.job?.id;
  if (!jobId) {
    throw new Error("Canva autofill missing job id");
  }
  return jobId;
}

export async function getAutofillJob(
  connection: CanvaConnectionRow,
  jobId: string,
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => Promise<void>,
): Promise<{
  status: string;
  designUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}> {
  const res = await canvaFetch(
    connection,
    `/autofills/${jobId}`,
    {},
    onTokensRefreshed,
  );
  if (!res.ok) {
    return { status: "failed", error: await res.text() };
  }
  const body = (await res.json()) as {
    job?: {
      status?: string;
      result?: {
        design?: { urls?: { edit_url?: string; view_url?: string }; thumbnail?: { url?: string } };
      };
      error?: { message?: string };
    };
  };
  const job = body.job;
  const status = job?.status ?? "in_progress";
  if (status === "success" && job?.result?.design) {
    return {
      status: "success",
      designUrl:
        job.result.design.urls?.edit_url ??
        job.result.design.urls?.view_url,
      thumbnailUrl: job.result.design.thumbnail?.url,
    };
  }
  if (status === "failed") {
    return { status: "failed", error: job?.error?.message ?? "Autofill failed" };
  }
  return { status };
}
