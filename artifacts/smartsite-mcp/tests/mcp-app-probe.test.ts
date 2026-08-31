/* p559 probe cut: the boot strip measures net, gl, and bridge for the map-ground
 * decision (v3 scoping measurement 6). These tests pin the served markers, the
 * probe resource registration, and the declared CSP domains. */
import { describe, expect, it } from "vitest";
import {
  APP_MIME,
  APP_RESOURCE_URI,
  PROBE_CSP_DOMAINS,
  PROBE_NET_TARGETS,
  PROBE_RESOURCE_TEXT,
  PROBE_RESOURCE_URI,
  buildAppHtml,
  htmlContractViolations,
  registerMcpApp,
} from "../src/mcp-app.js";

describe("p559 probe vs the direct_network contract", () => {
  const html = buildAppHtml();

  it("the clean page passes, with exactly one marked probe block", () => {
    expect(htmlContractViolations(html)).toEqual([]);
    expect(html.split("/*P559_PROBE_BEGIN*/").length - 1).toBe(1);
    expect(html.split("/*P559_PROBE_END*/").length - 1).toBe(1);
  });

  it("fetch OUTSIDE the markers still fires direct_network", () => {
    const planted = html.replace(
      "var esc=escapeHtml;",
      'var esc=escapeHtml;fetch("https://x.example/");',
    );
    expect(planted).not.toBe(html);
    expect(htmlContractViolations(planted)).toContain("direct_network");
  });

  it("a second probe block fires probe_block_malformed and restores the full scan", () => {
    const dup = html + "\n/*P559_PROBE_BEGIN*/ /*P559_PROBE_END*/";
    const v = htmlContractViolations(dup);
    expect(v).toContain("probe_block_malformed");
    expect(v).toContain("direct_network");
  });
});

describe("p559 probe constants", () => {
  it("pins the p559 URIs", () => {
    expect(APP_RESOURCE_URI).toBe("ui://smartsite/app-p561.html");
    expect(PROBE_RESOURCE_URI).toBe("ui://smartsite/probe-p559.txt");
  });

  it("declares every probe target origin in the CSP domains (derived, not copied)", () => {
    for (const t of PROBE_NET_TARGETS) {
      const origin = new URL(t.url).origin;
      expect(PROBE_CSP_DOMAINS, `origin ${origin} for key ${t.key}`).toContain(origin);
    }
  });

  it("probes four distinct origins including our own", () => {
    const origins = new Set(PROBE_NET_TARGETS.map((t) => new URL(t.url).origin));
    expect(origins.size).toBe(4);
    expect(origins).toContain("https://mcp.smartsite.cloud");
  });
});

describe("p559 probe in the served page", () => {
  const html = buildAppHtml();

  it("starts every channel at unread and paints them into the strip", () => {
    expect(html).toContain('var netText="net=unread"');
    expect(html).toContain('var glText="gl=unread"');
    expect(html).toContain('var bridgeText="bridge=unread"');
    expect(html).toContain('"data-net"');
    expect(html).toContain('"data-gl"');
    expect(html).toContain('"data-bridge"');
    expect(html).toContain(",netText,glText,bridgeText].join");
  });

  it("carries each probe URL verbatim", () => {
    for (const t of PROBE_NET_TARGETS) {
      expect(html).toContain(t.url);
    }
  });

  it("distinguishes blocked from cors-less reachability (no-cors fallback present)", () => {
    expect(html).toContain('{mode:"cors"}');
    expect(html).toContain('{mode:"no-cors"}');
    expect(html).toContain('"opq"');
    expect(html).toContain('"blk"');
  });

  it("checks webgl2 before webgl1 and has a none state", () => {
    const i2 = html.indexOf('getContext("webgl2")');
    const i1 = html.indexOf('getContext("webgl")');
    expect(i2).toBeGreaterThan(-1);
    expect(i1).toBeGreaterThan(i2);
    expect(html).toContain('"gl=none"');
  });

  it("bridge probe reads the probe resource through the host rpc and cannot run twice", () => {
    expect(html).toContain('method:"resources/read"');
    expect(html).toContain(JSON.stringify(PROBE_RESOURCE_URI));
    expect(html).toContain('if(bridgeText!=="bridge=unread") return;');
    expect(html).toContain('"bridge=nohost"');
    expect(html).toContain('"bridge=timeout"');
  });
});

describe("p559 registration", () => {
  it("registers the board and the probe resource, with the domains declared on the board", async () => {
    const calls: Array<{ name: string; uri: string; config: Record<string, unknown> }> = [];
    let boardMeta: Record<string, unknown> | undefined;
    let probeText: string | undefined;
    const server = {
      registerResource: (
        name: string,
        uri: string,
        config: Record<string, unknown>,
        handler: (u: { href: string }) => Promise<{
          contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }>;
        }>,
      ) => {
        calls.push({ name, uri, config });
        void handler({ href: uri }).then((r) => {
          if (uri === APP_RESOURCE_URI) boardMeta = r.contents[0]?._meta;
          if (uri === PROBE_RESOURCE_URI) probeText = r.contents[0]?.text;
        });
      },
    };
    registerMcpApp(server);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.uri)).toEqual([APP_RESOURCE_URI, PROBE_RESOURCE_URI]);
    expect(calls[0].config.mimeType).toBe(APP_MIME);
    expect(calls[1].config.mimeType).toBe("text/plain");
    const ui = (boardMeta as { ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } } })?.ui;
    expect(ui?.csp?.connectDomains).toEqual([...PROBE_CSP_DOMAINS]);
    expect(ui?.csp?.resourceDomains).toEqual([...PROBE_CSP_DOMAINS]);
    expect(probeText).toBe(PROBE_RESOURCE_TEXT);
  });
});
