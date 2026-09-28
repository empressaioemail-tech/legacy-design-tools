import { describe, expect, it, afterEach } from "vitest";
import {
  loadGhlCatalog,
  resetGhlCatalogCache,
  type GhlConfig,
} from "./peGhlCatalog";
import { PIPELINE_NAME, REQUIRED_FIELDS, REQUIRED_TAGS, STAGES } from "./peLifecycleTypes";

const CONFIG: GhlConfig = { apiKey: "test_key", locationId: "loc_1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function completeGhlCatalogBodies() {
  return {
    pipelines: [
      {
        id: "pipe_ss",
        name: PIPELINE_NAME,
        stages: STAGES.map((name, i) => ({ id: `stage_${i}`, name })),
      },
    ],
    tags: REQUIRED_TAGS.map((name, i) => ({ id: `tag_${i}`, name })),
    customFields: REQUIRED_FIELDS.map((name, i) => ({ id: `field_${i}`, name })),
  };
}

export function mockGhlFetch(opts?: {
  catalog?: ReturnType<typeof completeGhlCatalogBodies>;
  upsert?: Record<string, unknown>;
  opportunityStatus?: number;
  failCatalogPath?: string;
  /** Tags already on the contact before lifecycle runs (manual / workflow tags). */
  seedContactTags?: string[];
  contactId?: string;
}): {
  fetchImpl: typeof fetch;
  calls: { url: string; method: string; body: unknown }[];
  contactTags: () => string[];
} {
  const catalog = opts?.catalog ?? completeGhlCatalogBodies();
  const calls: { url: string; method: string; body: unknown }[] = [];
  const contactId = opts?.contactId ?? "ghl_c1";
  let contactTags = [...(opts?.seedContactTags ?? [])];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (opts?.failCatalogPath && url.includes(opts.failCatalogPath)) {
      return jsonResponse({ message: "missing" }, 404);
    }
    if (url.includes("/opportunities/pipelines")) {
      return jsonResponse({ pipelines: catalog.pipelines });
    }
    if (url.includes("/locations/") && url.includes("/tags")) {
      return jsonResponse({ tags: catalog.tags });
    }
    if (url.includes("/customFields")) {
      return jsonResponse({ customFields: catalog.customFields });
    }
    const contactTagPath = url.match(/\/contacts\/([^/]+)\/tags$/);
    if (contactTagPath) {
      const listed = body?.tags;
      const names = Array.isArray(listed)
        ? listed.filter((t): t is string => typeof t === "string")
        : [];
      if (method === "POST") {
        for (const name of names) {
          if (!contactTags.includes(name)) contactTags.push(name);
        }
      } else if (method === "DELETE") {
        const drop = new Set(names);
        contactTags = contactTags.filter((t) => !drop.has(t));
      }
      return jsonResponse({ tags: [...contactTags] });
    }
    if (url.includes("/contacts/upsert")) {
      if (Array.isArray(body?.tags)) {
        throw new Error("mockGhlFetch: upsert must not send tags");
      }
      return jsonResponse(
        opts?.upsert ?? { new: true, contact: { id: contactId } },
        201,
      );
    }
    if (url.includes("/opportunities")) {
      return jsonResponse({ opportunity: { id: "opp_1" } }, opts?.opportunityStatus ?? 201);
    }
    return jsonResponse({ message: "unexpected" }, 500);
  };
  return { fetchImpl, calls, contactTags: () => [...contactTags] };
}

afterEach(() => {
  resetGhlCatalogCache();
});

describe("loadGhlCatalog", () => {
  it("resolves pipeline, stages, tags and fields by name", async () => {
    const { fetchImpl } = mockGhlFetch();
    const result = await loadGhlCatalog(CONFIG, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.pipelineId).toBe("pipe_ss");
    expect(result.catalog.stages.Explorer).toBe("stage_0");
    expect(result.catalog.stages.Team).toBe("stage_5");
    expect(result.catalog.tags["ss_src_ad"]).toBeTruthy();
    expect(result.catalog.fields["SS Plan"]).toBeTruthy();
    expect(result.catalog.fields["utm_source"]).toBeTruthy();
  });

  it("fails loudly when a required name is missing — no guessed id", async () => {
    const catalog = completeGhlCatalogBodies();
    catalog.tags = catalog.tags.filter((t) => t.name !== "ss_src_ad");
    const { fetchImpl } = mockGhlFetch({ catalog });
    const result = await loadGhlCatalog(CONFIG, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("tag:ss_src_ad");
    expect(result.error).toBe("ghl_catalog_incomplete");
  });

  it("fails loudly when the Self Serve pipeline is absent", async () => {
    const catalog = completeGhlCatalogBodies();
    catalog.pipelines = [{ id: "old", name: "Smart Site Signups", stages: [] }];
    const { fetchImpl } = mockGhlFetch({ catalog });
    const result = await loadGhlCatalog(CONFIG, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain(`pipeline:${PIPELINE_NAME}`);
  });
});
