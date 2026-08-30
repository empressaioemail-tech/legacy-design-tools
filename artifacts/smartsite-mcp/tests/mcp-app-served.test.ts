/**
 * P-91: the SERVED iframe script under test.
 *
 * Extracts the <script> from buildAppHtml(), runs it under node:vm with a fake
 * DOM, fake timers, and a captured parent.postMessage, then drives it with
 * recorded host messages. Every sentence in the build plan's 4.4 table is
 * asserted on the painted root.innerHTML. Promoted from the two deep-dive
 * harnesses in doc_repo _inbox (2026-08-29_p91_iframe_instrument.mjs and
 * 2026-08-29_p91_iframe_harness.mts). The exported twin is never rendered here.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import * as app from "../src/mcp-app.js";

/*
 * Plan 4.4 sentences, literal on purpose. Two derivations: the plan text here,
 * the module constants there. A constant edited to other words fails here.
 */
const COPY = {
  dead: "Open did not reach me",
  sent: "Sent to chat. Press Send to open.",
  absent: (county: string) => `Not on file in ${county}`,
  absentPrefix: "Not on file in",
  unbaked: (id: string) => `No baked snapshot yet for ${id}`,
  unbakedPrefix: "No baked snapshot yet for",
  refused: "Upgrade to open this parcel",
  unreadable: "Result not readable",
  empty: "No screen yet",
  nothingToOpen: "Nothing to open until this resolves",
  nodeUnresolved: "node unresolved",
  railsPartlyUnread: "Some rails on this screen were not read",
};
const OPEN_DEAD_MS = 12000;
const ALL_SENTENCES = [
  COPY.dead,
  COPY.sent,
  COPY.absentPrefix,
  COPY.unbakedPrefix,
  COPY.refused,
  COPY.unreadable,
  COPY.empty,
];

const GOLD = {
  parcelNodeId: "48021:34137",
  draw: {
    label: "908 PINE , BASTROP, TX 78602",
    ring: [
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ],
    edges: [{ i: 1, role: "side", ft: 167.99, neighbor: "48021:34169" }],
    overlays: [
      { id: "flood", state: "present", label: "Zone X" },
      { id: "envelope", state: "refused", reason: "atom_path_pending", label: "Buildable envelope not computed" },
    ],
  },
};
const STUB_SIX = {
  situs: "present",
  zoning: "present",
  landUse: "absent",
  flood: "present",
  drainage: "unknown",
  envelope: "refused",
};
const STUB_SIX_GLYPHS = ["present", "present", "absent-verified", "present", "unknown", "refused"];
const ALL_UNREAD = ["unread", "unread", "unread", "unread", "unread", "unread"];
const BOARD = {
  id: "screen-1",
  stubsDegraded: true,
  rows: [
    { query: "908 Pine, Bastrop TX", parcelNodeId: "48021:34137", resolution: "resolved", stub: STUB_SIX, stubRead: "ok" },
    { query: "111 Rainmaker Cv, Bastrop TX", parcelNodeId: "48021:34169", resolution: "resolved", stubRead: "skipped" },
    { query: "zzzz-not-a-situs-99999", parcelNodeId: null, resolution: "unresolved" },
  ],
};
const MISS_ABSENT = { parcels: [], notFound: ["48021:900099"], reason: "parcel_not_found", parcelExists: false };
const MISS_UNBAKED = { parcels: [], notFound: ["48021:900099"], reason: "baked_snapshot_not_found", parcelExists: true };
const REFUSED = { parcels: [], notFound: [], refused: [{ parcelNodeId: "48021:34137", reason: "upgrade_required" }] };
const BATCH = {
  parcels: [
    {
      parcelNodeId: "48021:34137",
      label: "908 PINE , BASTROP, TX 78602",
      url: "https://smartsite.cloud/p/48021:34137",
      stub: STUB_SIX,
    },
  ],
  notFound: ["48021:900099"],
};

/* The ten divergence fixtures from the deep-dive harness plus the new kinds. */
const PARITY: Record<string, unknown> = {
  legacyMiss: { parcels: [], notFound: ["48021:900099"] },
  idFallback: { rows: [{ query: "a", id: "48021:1" }] },
  absentState: { rows: [{ query: "a", parcelNodeId: "48021:1", stub: { situs: "absent" } }] },
  emptyRow: { rows: [{}] },
  capsResolution: { rows: [{ query: "q", parcelNodeId: "48021:1", resolution: "Resolved" }] },
  junkState: { rows: [{ query: "q", parcelNodeId: "48021:1", stub: { situs: "pending" } }] },
  stringStub: { rows: [{ query: "q", parcelNodeId: "48021:1", stub: "present" }] },
  nanRing: { parcelNodeId: "48021:1", draw: { ring: [[1, 2], [NaN, 3], [4, 5]], overlays: [] } },
  numericId: { id: 7, rows: [{ query: "q", parcelNodeId: "48021:1" }] },
  overlayNoLabel: { parcelNodeId: "48021:1", draw: { overlays: [{ id: 5, state: 3 }] } },
  gold: GOLD,
  board: BOARD,
  missAbsent: MISS_ABSENT,
  missUnbaked: MISS_UNBAKED,
  missUnmeasured: { ...MISS_UNBAKED, parcelExists: "unmeasured" },
  missUnstated: { parcels: [], notFound: ["48021:1"], reason: "something_else" },
  refused: REFUSED,
  refusedOther: { parcels: [], refused: [{ parcelNodeId: "48021:1", reason: "quota" }, { nope: 1 }] },
  batch: BATCH,
  garbage: "not json",
  jsonArray: "[1,2]",
  jsonNull: "null",
  rowsNotArray: { rows: "abc" },
  overlaysNotArray: { parcelNodeId: "48021:1", draw: { ring: [[0, 0], [1, 0], [1, 1]], overlays: "x" } },
  savedOnly: { savedProperties: [{ id: "x", parcelNodeId: "48021:34137", label: "gold" }] },
  screensOnly: { screens: [{ id: "s1" }] },
  emptyBatch: { parcels: [], notFound: [] },
  screenWrapped: { screen: { id: "s2", stubsDegraded: false, rows: [{ query: "q", parcelNodeId: "48021:2", resolution: "ambiguous" }] } },
};

type FakeEl = {
  attrs: Record<string, string>;
  style: Record<string, string>;
  innerHTML: string;
  textContent: string;
  className: string;
  scrollHeight: number;
  disabled: boolean;
  setAttribute(k: string, v: unknown): void;
  getAttribute(k: string): string | null;
  querySelector(): null;
  addEventListener(): void;
  appendChild(): void;
  closest(): null;
};

function el(): FakeEl {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    style: {},
    innerHTML: "",
    textContent: "",
    className: "",
    scrollHeight: 500,
    disabled: false,
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in attrs ? (attrs[k] as string) : null;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    appendChild() {},
    closest() {
      return null;
    },
  };
}

export function extractServedScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  if (start < 0 || end < 0 || end < start) throw new Error("served html has no script block");
  return html.slice(start + "<script>".length, end);
}

type Posted = Record<string, unknown> & { method?: string; id?: unknown };
type Listener = (ev: { data: unknown; source: unknown }) => void;

function fresh() {
  const script = extractServedScript(app.buildAppHtml());
  const boot = el();
  const root = el();
  const body = el();
  const docEl = el();
  let listener: Listener | null = null;
  const posted: Posted[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let tid = 0;
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === "boot" ? boot : id === "root" ? root : null),
      body,
      documentElement: docEl,
      createElement: () => el(),
    },
    parent: {
      postMessage: (m: Posted) => {
        posted.push(m);
      },
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++tid;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    addEventListener: (type: string, fn: Listener) => {
      if (type === "message") listener = fn;
    },
    console,
  };
  /* window === the sandbox global, so window.parent is the capture above. */
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const host = sandbox.parent;
  const deliver = (data: unknown, source: unknown = host) => {
    if (!listener) throw new Error("no message listener bound");
    listener({ data, source });
  };
  const fire = (ms: number) => {
    let n = 0;
    for (const [id, t] of [...timers]) {
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
        n += 1;
      }
    }
    return n;
  };
  const armed = (ms: number) => [...timers.values()].filter((t) => t.ms === ms).length;
  const text = () => root.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const init = () =>
    deliver({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2026-01-26", hostCapabilities: { message: {}, serverTools: {} } },
    });
  const toolResult = (payload: unknown, content?: unknown[]) =>
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: content ?? [
          { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
        ],
      },
    });
  const open = (node: string): Posted | undefined => {
    const ss = sandbox.__ss as { open: (btn: unknown) => void };
    ss.open({ getAttribute: (k: string) => (k === "data-node" ? node : null) });
    return posted.filter((m) => m.method === "ui/message").pop();
  };
  const openButtons = () => (root.innerHTML.match(/data-act="open"/g) ?? []).length;
  return { boot, root, posted, deliver, fire, armed, text, init, toolResult, open, openButtons, sandbox };
}

function rowGlyphs(html: string, needle: string): string[] {
  const row = html
    .split("<tr")
    .map((seg) => seg.split("</tr>")[0] ?? "")
    .find((seg) => seg.includes(needle));
  if (!row) throw new Error(`no table row containing ${needle}`);
  return [...row.matchAll(/class="g g-([a-z-]+)"/g)].map((m) => m[1] ?? "");
}

describe("served iframe script", () => {
  it("positive control: gold paints the ring, the human envelope reason, and script-ran in the header", () => {
    const f = fresh();
    f.init();
    f.toolResult(GOLD);
    expect(f.root.innerHTML).toContain('aria-label="parcel ring"');
    expect(f.text()).toContain("48021:34137");
    expect(f.text()).toContain("908 PINE");
    expect(f.text()).toContain("Withheld, setbacks unruled");
    expect(f.root.innerHTML).not.toContain("atom_path_pending");
    expect(f.root.innerHTML).toContain('<span data-script="ran">script-ran</span>');
    expect(f.boot.textContent).toContain("script-ran");
    expect(f.boot.textContent).toContain("handshake=ready");
    expect(f.boot.textContent).toContain("caps=serverTools");
    expect(f.boot.textContent).toContain("message=yes");
    expect(f.boot.textContent).toContain("reply=none");
    expect(f.boot.textContent).toContain("foreign=0");
    for (const s of ALL_SENTENCES) expect(f.text(), s).not.toContain(s);
  });

  it("not vacuous: garbage text paints Result not readable, none of the other sentences, and no ring", () => {
    const f = fresh();
    f.init();
    f.toolResult("not json");
    expect(f.text()).toContain(COPY.unreadable);
    for (const s of ALL_SENTENCES.filter((x) => x !== COPY.unreadable)) {
      expect(f.text(), s).not.toContain(s);
    }
    expect(f.root.innerHTML).not.toContain("parcel ring");
    expect(f.openButtons()).toBe(0);
  });

  it("miss absent: Not on file in the id's county, never a county the prefix does not map to", () => {
    const f = fresh();
    f.init();
    f.toolResult(MISS_ABSENT);
    expect(f.text()).toContain(COPY.absent("Bastrop"));
    expect(f.text()).toContain("48021:900099");
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.openButtons()).toBe(0);

    const t = fresh();
    t.init();
    t.toolResult({ ...MISS_ABSENT, notFound: ["48453:1"] });
    expect(t.text()).toContain(COPY.absent("Travis"));
    expect(t.text()).not.toContain("Bastrop");

    const u = fresh();
    u.init();
    u.toolResult({ ...MISS_ABSENT, notFound: ["99999:1"] });
    expect(u.text()).toContain(COPY.absent("this county"));
    expect(u.text()).not.toMatch(/Bastrop|Caldwell|Hays|Travis|Williamson/);
  });

  it("miss unbaked: No baked snapshot yet for the id when it exists or existence is unmeasured; parcelExists false wins as absent", () => {
    for (const exists of [true, "unmeasured"]) {
      const f = fresh();
      f.init();
      f.toolResult({ ...MISS_UNBAKED, parcelExists: exists });
      expect(f.text(), String(exists)).toContain(COPY.unbaked("48021:900099"));
      expect(f.text(), String(exists)).not.toContain(COPY.absentPrefix);
      expect(f.text(), String(exists)).not.toContain(COPY.dead);
      expect(f.text(), String(exists)).not.toContain(COPY.empty);
    }
    const g = fresh();
    g.init();
    g.toolResult({ ...MISS_UNBAKED, parcelExists: false });
    expect(g.text()).toContain(COPY.absent("Bastrop"));
    expect(g.text()).not.toContain(COPY.unbakedPrefix);
  });

  it("refused: Upgrade to open this parcel plus the node id, no Open control", () => {
    const f = fresh();
    f.init();
    f.toolResult(REFUSED);
    expect(f.text()).toContain(COPY.refused);
    expect(f.text()).toContain("48021:34137");
    expect(f.openButtons()).toBe(0);
    expect(f.text()).not.toContain(COPY.absentPrefix);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.empty);
  });

  it("unreadable: a missing text part paints Result not readable; a later text part is found by scanning", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.toolResult(null, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(f.text()).toContain(COPY.unreadable);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.openButtons()).toBe(0);

    const g = fresh();
    g.init();
    g.toolResult(null, [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: JSON.stringify(GOLD) },
    ]);
    expect(g.root.innerHTML).toContain('aria-label="parcel ring"');

    const h = fresh();
    h.init();
    h.toolResult(null, []);
    expect(h.text()).toContain(COPY.unreadable);
  });

  it("batch stub: a board with one resolved row per parcel (query = label, rails from stub) and one unresolved row per notFound id", () => {
    const f = fresh();
    f.init();
    f.toolResult(BATCH);
    expect(f.openButtons()).toBe(1);
    expect(f.text()).toContain("908 PINE , BASTROP, TX 78602");
    expect(f.text()).toContain(COPY.nodeUnresolved);
    expect(f.text()).toContain("48021:900099");
    expect(f.text()).toContain(COPY.nothingToOpen);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, "48021:900099")).toEqual(ALL_UNREAD);
    expect(f.text()).not.toContain(COPY.empty);
    expect(f.text()).not.toContain(COPY.absentPrefix);
    expect(f.root.innerHTML).not.toContain("smartsite.cloud");
  });

  it("screen: resolved rows carry rails from stub at first paint; a skipped read stays unread; stubsDegraded is declared", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    expect(f.openButtons()).toBe(2);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34137"')).toEqual(STUB_SIX_GLYPHS);
    expect(rowGlyphs(f.root.innerHTML, 'data-node="48021:34169"')).toEqual(ALL_UNREAD);
    expect(f.text()).toContain("situs unresolved");
    expect(f.text()).toContain(COPY.railsPartlyUnread);
    const g = fresh();
    g.init();
    g.toolResult({ ...BOARD, stubsDegraded: false });
    expect(g.text()).not.toContain(COPY.railsPartlyUnread);
  });

  it("board: a {} reply to ui/message paints Sent, clears the 12s timer, keeps the rows; a later result clears the line", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const msg = f.open("48021:34137");
    expect(msg?.method).toBe("ui/message");
    expect(f.armed(OPEN_DEAD_MS)).toBe(1);
    f.deliver({ jsonrpc: "2.0", id: msg?.id, result: {} });
    expect(f.boot.textContent).toContain("reply=ok");
    expect(f.text()).toContain(COPY.sent);
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.openButtons()).toBe(2);
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.fire(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);
    f.toolResult(BOARD);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.openButtons()).toBe(2);
  });

  it("board: dead only when the host never replies within 12s or replies with a JSON-RPC error", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.open("48021:34137");
    expect(f.text()).not.toContain(COPY.dead);
    expect(f.fire(OPEN_DEAD_MS)).toBe(1);
    expect(f.text()).toContain(COPY.dead);
    expect(f.text()).not.toContain(COPY.sent);
    expect(f.openButtons()).toBe(2);

    const g = fresh();
    g.init();
    g.toolResult(BOARD);
    const m2 = g.open("48021:34137");
    g.deliver({ jsonrpc: "2.0", id: m2?.id, error: { code: -32600, message: "nope" } });
    expect(g.text()).toContain(COPY.dead);
    expect(g.text()).not.toContain(COPY.sent);
    expect(g.armed(OPEN_DEAD_MS)).toBe(0);
    expect(g.boot.textContent).toContain("reply=-32600");
  });

  it("listener: a foreign source is refused and counted; a bare result.content from the parent is ignored; a prototype key is not a reply", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    const before = f.root.innerHTML;
    f.deliver(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } },
      {},
    );
    expect(f.root.innerHTML).toBe(before);
    expect(f.boot.textContent).toContain("foreign=1");
    f.deliver({ result: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } });
    expect(f.root.innerHTML).toBe(before);
    f.deliver({ jsonrpc: "2.0", id: "constructor", result: { content: [{ type: "text", text: JSON.stringify(GOLD) }] } });
    expect(f.root.innerHTML).toBe(before);
    expect(f.boot.textContent).not.toContain("reply=ok");
    f.toolResult(GOLD);
    expect(f.root.innerHTML).toContain("parcel ring");
    expect(f.boot.textContent).toContain("foreign=1");
  });

  it("sticky: a delivered result never ends as dead-Open, even when rows or overlays are not arrays; a later result clears a dead line", () => {
    const f = fresh();
    f.init();
    f.toolResult(BOARD);
    f.open("48021:34137");
    expect(() => f.toolResult({ rows: "abc" })).not.toThrow();
    expect(f.armed(OPEN_DEAD_MS)).toBe(0);
    expect(f.fire(OPEN_DEAD_MS)).toBe(0);
    expect(f.text()).not.toContain(COPY.dead);

    const g = fresh();
    g.init();
    g.toolResult(BOARD);
    g.open("48021:34137");
    expect(() =>
      g.toolResult({ parcelNodeId: "48021:34137", draw: { ring: [[0, 0], [1, 0], [1, 1]], overlays: "x" } }),
    ).not.toThrow();
    expect(g.armed(OPEN_DEAD_MS)).toBe(0);
    expect(g.root.innerHTML).toContain("parcel ring");

    const h = fresh();
    h.init();
    h.toolResult(BOARD);
    h.open("48021:34137");
    h.fire(OPEN_DEAD_MS);
    expect(h.text()).toContain(COPY.dead);
    h.toolResult(BOARD);
    expect(h.text()).not.toContain(COPY.dead);
    expect(h.text()).not.toContain(COPY.absentPrefix);
  });

  it("escaping: quotes in ids and rail states cannot leave their attribute; unknown states fall to unread", () => {
    const f = fresh();
    f.init();
    f.toolResult({
      id: "s",
      rows: [
        {
          query: "q",
          parcelNodeId: '48021:x" data-pwn="1',
          resolution: "resolved",
          stub: { situs: 'present" onmouseover="alert(1)', zoning: "pending", flood: 7 },
        },
      ],
    });
    expect(f.root.innerHTML).not.toContain('data-pwn="1"');
    expect(f.root.innerHTML).not.toContain('onmouseover="alert(1)"');
    expect(f.root.innerHTML).toContain('data-node="48021:x&quot; data-pwn=&quot;1"');
    expect(f.root.innerHTML).not.toContain("g-pending");
    expect(f.root.innerHTML).not.toContain("g-7");
    expect(rowGlyphs(f.root.innerHTML, "48021:x")).toEqual(ALL_UNREAD);
  });

  it("one parser: the served parse agrees with the exported parseToolResult on every fixture, exported semantics as authority", () => {
    const f = fresh();
    const ss = f.sandbox.__ss as { parse?: (t: string) => unknown } | undefined;
    const served = ss?.parse;
    expect(typeof served).toBe("function");
    const diffs: string[] = [];
    for (const [name, fx] of Object.entries(PARITY)) {
      const text = typeof fx === "string" ? fx : JSON.stringify(fx);
      const a = JSON.stringify(served!(text));
      const b = JSON.stringify(app.parseToolResult(text));
      if (a !== b) diffs.push(`${name}\n  served:   ${a}\n  exported: ${b}`);
    }
    expect(diffs).toEqual([]);
    const junk = app.parseToolResult(JSON.stringify(PARITY.junkState));
    expect(junk.rows[0]?.rails.situs).toBe("unread");
    const absent = app.parseToolResult(JSON.stringify(PARITY.absentState));
    expect(absent.rows[0]?.rails.situs).toBe("absent-verified");
    const caps = app.parseToolResult(JSON.stringify(PARITY.capsResolution));
    expect(caps.rows[0]?.resolution).toBe("resolved");
    const numericId = app.parseToolResult(JSON.stringify(PARITY.numericId));
    expect(numericId.screenId).toBeUndefined();
    const idFallback = app.parseToolResult(JSON.stringify(PARITY.idFallback));
    expect(idFallback.rows[0]?.parcelNodeId).toBe("48021:1");
    const stringStub = app.parseToolResult(JSON.stringify(PARITY.stringStub));
    expect(stringStub.rows[0]?.rails.situs).toBe("unread");
  });

  it("htmlContractViolations: origin_unchecked and miss_copy_unbound fire on violated copies of the served html", () => {
    const clean = app.buildAppHtml();
    expect(app.htmlContractViolations(clean)).toEqual([]);
    expect(app.htmlContractViolations(clean.replace("if(ev.source!==window.parent)", "if(false)"))).toContain(
      "origin_unchecked",
    );
    for (const s of [COPY.dead, COPY.sent, COPY.absentPrefix, COPY.unbakedPrefix, COPY.refused, COPY.unreadable]) {
      expect(app.htmlContractViolations(clean.split(s).join("")), s).toContain("miss_copy_unbound");
    }
  });
});
