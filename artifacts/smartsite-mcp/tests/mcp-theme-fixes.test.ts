/**
 * Smart Site MCP card: theme, phone board, wording, contract, plan refusal,
 * structuredContent, matched shape and diagnostics gate. One block per finding.
 */
import { describe, expect, it } from "vitest";
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  THEME_SCRIPT,
  buildThemeCss,
  type ThemeTokens,
} from "../src/card-theme.js";
import { boardPhoneCss, buildAppHtml, htmlContractViolations } from "../src/mcp-app.js";
import { RAILS } from "../src/card/panel-lib.js";
import { buildReadingLayoutText, listAnswerLine } from "../src/reading-layout.js";
import {
  cardContractSentence,
  cardViewFromToolPayload,
} from "../src/card-contract.js";
import {
  PLAN_REFUSAL_SENTENCE,
  applyPlanRefusalWording,
  withPlanRefusalWording,
} from "../src/plan-refusal.js";
import { ensureStructuredContent } from "../src/host-tier-result.js";
import { parcelIdsFromMatched } from "../src/map-tool-wire.js";

/* ---------- colour helpers ---------- */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function lum(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = [
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
];
const SURFACES = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--ss-raised",
];
const ACCENT_TEXT = [
  "--ss-blue",
  "--ss-gold",
  "--ss-atom",
  "--ss-slate",
  "--ss-warn",
  "--ss-amber",
  "--ss-brand-site",
];
const ON_ACCENT_BG = ["--ss-blue", "--ss-gold", "--ss-atom", "--ss-slate"];

/** Everything a palette must satisfy; returns the list of problems. */
function paletteProblems(tokens: ThemeTokens): string[] {
  const out: string[] = [];
  for (const key of Object.keys(DARK_TOKENS)) {
    if (!tokens[key]) out.push(`missing ${key}`);
  }
  for (const t of TEXT) {
    for (const s of SURFACES) {
      if (!tokens[t] || !tokens[s]) continue;
      if (contrast(tokens[t]!, tokens[s]!) < 4.5) out.push(`${t} on ${s}`);
    }
  }
  for (const t of ACCENT_TEXT) {
    for (const s of SURFACES.slice(0, 2)) {
      if (!tokens[t] || !tokens[s]) continue;
      if (contrast(tokens[t]!, tokens[s]!) < 4.5) out.push(`${t} on ${s}`);
    }
  }
  for (const bg of ON_ACCENT_BG) {
    if (!tokens["--ss-on-accent"] || !tokens[bg]) continue;
    if (contrast(tokens["--ss-on-accent"]!, tokens[bg]!) < 4.5) out.push(`on-accent on ${bg}`);
  }
  if (tokens["--color-text-inverse"] && tokens["--color-background-inverse"]) {
    if (contrast(tokens["--color-text-inverse"]!, tokens["--color-background-inverse"]!) < 4.5) {
      out.push("inverse pair");
    }
  }
  return out;
}

function styleOf(html: string): string {
  const a = html.indexOf("<style>") + 7;
  return html.slice(a, html.indexOf("</style>"));
}
/** Literal colours in a stylesheet once the token blocks are removed. */
function literalColours(css: string): string[] {
  let rest = css;
  for (const line of buildThemeCss().split("\n")) rest = rest.split(line).join("");
  return rest.match(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
}

describe("1. theme: one token set, both palettes", () => {
  it("dark and light palettes meet WCAG AA for every text and surface pair", () => {
    expect(paletteProblems(DARK_TOKENS)).toEqual([]);
    expect(paletteProblems(LIGHT_TOKENS)).toEqual([]);
  });

  it("FALSIFIER: a token removed from the light palette is caught", () => {
    const broken = { ...LIGHT_TOKENS };
    delete broken["--color-text-secondary"];
    expect(paletteProblems(broken)).toContain("missing --color-text-secondary");
  });

  it("FALSIFIER: a light token that is too pale is caught by the contrast check", () => {
    const pale = { ...LIGHT_TOKENS, "--color-text-tertiary": "#C9C6BA" };
    expect(paletteProblems(pale).some((p) => p.startsWith("--color-text-tertiary"))).toBe(true);
  });

  it("the served stylesheet has no literal colour outside the token blocks", () => {
    expect(literalColours(styleOf(buildAppHtml()))).toEqual([]);
  });

  it("FALSIFIER: a literal colour planted in a rule is caught", () => {
    const planted = styleOf(buildAppHtml()) + ".x{background:#323234}";
    expect(literalColours(planted)).toEqual(["#323234"]);
  });

  it("the light palette applies by host flag and by prefers-color-scheme, and dark is the default", () => {
    const css = buildThemeCss();
    expect(css).toContain(':root[data-scheme="light"]{');
    expect(css).toContain('@media (prefers-color-scheme:light){:root:not([data-scheme="dark"]){');
    expect(css.split("\n")[0]).toContain("--color-background-primary:#30302E");
    expect(css).toContain("--color-background-primary:#FFFFFF");
  });

  it("every surface reads the token, not a fallback literal", () => {
    const css = styleOf(buildAppHtml());
    expect(css).not.toMatch(/var\(--color-[a-z-]+,/);
  });

  it("the theme script is served after the card script and the card keeps the first message guard", () => {
    const html = buildAppHtml();
    expect(html.indexOf("host-context-changed")).toBeGreaterThan(html.indexOf("ui/initialize"));
    expect(htmlContractViolations(html)).toEqual([]);
  });
});

describe("1. theme: the script applies what the host sends", () => {
  function run() {
    const attrs: Record<string, string> = {};
    const style: Record<string, string> = {};
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const parent = { id: "host" };
    const win = {
      parent,
      CSS: { supports: () => true },
      addEventListener: (n: string, fn: (e: unknown) => void) => {
        (listeners[n] ??= []).push(fn);
      },
    } as Record<string, unknown>;
    const doc = {
      documentElement: {
        setAttribute: (k: string, v: string) => (attrs[k] = v),
        style: {
          setProperty: (k: string, v: string) => (style[k] = v),
          colorScheme: "",
        },
      },
    };
    new Function("window", "document", "CSS", THEME_SCRIPT)(win, doc, win.CSS);
    const send = (source: unknown, data: unknown) =>
      (listeners.message ?? []).forEach((fn) => fn({ source, data }));
    return { attrs, style, send, parent, doc };
  }

  const CORE = {
    "--color-background-primary": "#ffffff",
    "--color-text-primary": "#111111",
    "--color-text-secondary": "#444444",
  };

  it("takes the theme flag and the full variable set from the initialize reply", () => {
    const r = run();
    r.send(r.parent, { result: { hostContext: { theme: "light", styles: { variables: CORE } } } });
    expect(r.attrs["data-scheme"]).toBe("light");
    expect(r.style["--color-background-primary"]).toBe("#ffffff");
    expect(r.style["--color-background-secondary"]).toContain("color-mix");
  });

  it("follows a later host-context-changed", () => {
    const r = run();
    r.send(r.parent, { method: "ui/notifications/host-context-changed", params: { theme: "dark" } });
    expect(r.attrs["data-scheme"]).toBe("dark");
  });

  it("ignores a partial variable set, which would clash with the accents", () => {
    const r = run();
    r.send(r.parent, {
      result: { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fff" } } } },
    });
    expect(r.style["--color-text-primary"]).toBeUndefined();
    expect(r.attrs["data-scheme"]).toBe("dark");
  });

  it("ignores a message that is not from the host window, and names outside the colour and font set", () => {
    const r = run();
    r.send({ id: "other" }, { result: { hostContext: { theme: "light", styles: { variables: CORE } } } });
    expect(r.attrs["data-scheme"]).toBeUndefined();
    r.send(r.parent, {
      result: { hostContext: { styles: { variables: { ...CORE, "--evil": "x", "--color-x;y": "z" } } } },
    });
    expect(r.style["--evil"]).toBeUndefined();
    expect(Object.keys(r.style).some((k) => k.includes(";"))).toBe(false);
  });
});

describe("2. screening board at phone width", () => {
  it("stacks rows, hides the header row, and keeps Open full width and visible", () => {
    const css = boardPhoneCss();
    expect(css).toContain("@media (max-width:480px)");
    expect(css).toContain(".ss-board thead{display:none}");
    expect(css).toContain(".ss-board .well{overflow-x:visible}");
    expect(css).toContain(".ss-board tr.row td:last-child .btn{width:100%");
    expect(buildAppHtml()).toContain(css);
  });

  it("names every rail beside its cell, in plain words, in column order", () => {
    const css = boardPhoneCss();
    RAILS.forEach((_rail, i) => {
      expect(css).toContain(`td:nth-child(${i + 3})::before`);
    });
    expect(css).toContain('content:"Land use"');
    expect(css).not.toContain('content:"landUse"');
  });
});

describe("3. find_parcels reading text", () => {
  const body = {
    countyFips: "48021",
    matched: { count: 412, cap: 50, received: 50, truncated: true, parcels: [{ parcelNodeId: "48021:1" }] },
    excluded: { count: 89, byRail: { flood: 89 } },
    notEvaluated: { count: 1203, byRail: { flood: 1203 } },
    unmeasuredPctByRail: { flood: 76.3, landUse: 0.6 },
  };
  const link = { url: "https://x.test/c", expiresAt: "t", expiryReason: "r" };

  it("says all three sets and the truncation, and never 'this parcel'", () => {
    const text = buildReadingLayoutText(body, link);
    const first = text.split("\n")[0]!;
    expect(first).not.toContain("this parcel");
    expect(first).toContain("412 parcels match");
    expect(first).toContain("89 parcels were excluded");
    expect(first).toContain("1203 parcels were not checked");
    expect(first).toContain("Only the first 50 of 412");
    expect(first).toContain("flood 76.3%");
    expect(first).toContain("land use 0.6%");
  });

  it("handles the array shape and says a missing count is not on record", () => {
    const line = listAnswerLine({ matched: [{ parcelNodeId: "a" }, { parcelNodeId: "b" }] })!;
    expect(line).toContain("2 parcels match");
    expect(line).toContain("The number excluded is not on record.");
    expect(line).toContain("The number not checked is not on record.");
  });

  it("singular wording for one", () => {
    const line = listAnswerLine({ matched: { count: 1 }, excluded: { count: 1 }, notEvaluated: { count: 1 } })!;
    expect(line).toContain("1 parcel matches");
    expect(line).toContain("1 parcel was excluded because it fails");
  });

  it("a street or radius list says it is cut short", () => {
    const line = listAnswerLine({
      hits: [{ parcelNodeId: "a" }, { parcelNodeId: "b" }],
      truncated: true,
      cap: 2,
      received: 9,
    })!;
    expect(line).toContain("2 parcels found");
    expect(line).toContain("cut short");
    expect(line).toContain("showing 2 of 9");
  });

  it("a single parcel read keeps its old opening", () => {
    expect(listAnswerLine({ parcelNodeId: "48021:1" })).toBeNull();
  });
});

describe("4. card contract names the card the app paints", () => {
  const two = [{ parcelNodeId: "a" }, { parcelNodeId: "b" }];
  it("a miss is a one-line note", () => {
    expect(cardViewFromToolPayload("find_parcel", { hits: [] })).toBe("note");
    expect(cardViewFromToolPayload("find_parcels", { matched: { count: 0, parcels: [] } })).toBe("note");
    expect(cardContractSentence("note")).toMatch(/short note/);
    expect(cardContractSentence("note")).not.toMatch(/one parcel/);
  });
  it("street, radius, criteria and neighbour lists are the screening board", () => {
    expect(cardViewFromToolPayload("find_parcel", { hits: two, truncated: true })).toBe("screen-board");
    expect(cardViewFromToolPayload("find_parcels", { matched: { count: 5, parcels: two } })).toBe("screen-board");
    expect(cardViewFromToolPayload("find_parcels", { matched: { count: 40 } })).toBe("screen-board");
    expect(cardViewFromToolPayload("find_nearest_parcels", { nearestNeighbors: two })).toBe("screen-board");
    expect(cardContractSentence("screen-board")).toMatch(/one row per parcel/);
    expect(cardContractSentence("screen-board")).not.toMatch(/empty board/);
  });
  it("one hit is the single parcel card; a refusal is a note", () => {
    expect(cardViewFromToolPayload("find_parcel", { hits: [{ parcelNodeId: "a" }] })).toBe("single-parcel");
    expect(cardViewFromToolPayload("find_parcel", { status: "refused", reason: "radius_exceeds_max" })).toBe("note");
  });
});

describe("5. one plan-refusal wording", () => {
  const url = "https://smartsite.cloud/?plans=1";
  it("get_smart_site, create_screen and the find_parcel map panel say the same sentence with the same link", () => {
    const parcel = withPlanRefusalWording({
      parcels: [],
      notFound: [],
      refused: [{ parcelNodeId: "48021:1", reason: "upgrade_required" }],
    })!;
    const screen = withPlanRefusalWording({
      status: "upgrade_required",
      reason: "studio_screens",
      message: "Studio or Team is required to build a screen.",
    })!;
    const map = withPlanRefusalWording({
      hits: [],
      mapPanelReason: "map_upgrade_required",
      mapPanelNote: "The map panel is not included in this plan for this parcel; a plan upgrade or a 30-day unlock on the parcel opens it.",
    })!;
    for (const b of [parcel, screen, map]) {
      expect(b.reasonDisplayText).toBe(PLAN_REFUSAL_SENTENCE);
      expect(b.plansUrl).toBe(url);
    }
    expect(map.mapPanelNote).toBe(PLAN_REFUSAL_SENTENCE);
    expect((parcel.refused as Array<Record<string, unknown>>)[0]!.reasonDisplayText).toBe(PLAN_REFUSAL_SENTENCE);
    expect(screen.message).toBe("Studio or Team is required to build a screen.");
  });
  it("leaves other bodies alone, and rewrites structuredContent too", () => {
    expect(withPlanRefusalWording({ hits: [] })).toBeNull();
    const r = applyPlanRefusalWording({
      content: [{ type: "text", text: JSON.stringify({ status: "upgrade_required" }) }],
      structuredContent: { status: "upgrade_required" },
      isError: true,
    });
    expect(JSON.parse((r.content[0] as { text: string }).text).plansUrl).toBe(url);
    expect(r.structuredContent?.reasonDisplayText).toBe(PLAN_REFUSAL_SENTENCE);
  });
});

describe("6. structuredContent on every result", () => {
  const vocab = JSON.stringify({ smartSiteVocabulary: [] });
  it("uses the tool body, skipping the standing vocabulary block", () => {
    const r = ensureStructuredContent(
      { content: [{ type: "text", text: vocab }, { type: "text", text: JSON.stringify({ hits: [] }) }] },
      [vocab],
    );
    expect(r.structuredContent).toEqual({ hits: [] });
  });
  it("keeps one that is already there", () => {
    const r = ensureStructuredContent({ content: [{ type: "text", text: "{}" }], structuredContent: { a: 1 } });
    expect(r.structuredContent).toEqual({ a: 1 });
  });
  it("wraps a bare list and plain text so the field is always an object", () => {
    expect(ensureStructuredContent({ content: [{ type: "text", text: "[1,2]" }] }).structuredContent).toEqual({ items: [1, 2] });
    expect(ensureStructuredContent({ content: [{ type: "text", text: "no json" }] }).structuredContent).toEqual({ text: "no json" });
  });
  it("errors and refusals carry it too", () => {
    const r = ensureStructuredContent({
      content: [{ type: "text", text: JSON.stringify({ status: "degraded", reason: "upstream_timeout" }) }],
      isError: true,
    });
    expect(r.structuredContent).toMatchObject({ status: "degraded" });
  });
});

describe("7. find_parcels matched in either shape", () => {
  const rows = [{ parcelNodeId: "48021:1" }, { parcelNodeId: "48021:2" }];
  it("reads the array shape", () => {
    expect(parcelIdsFromMatched(rows)).toEqual(["48021:1", "48021:2"]);
  });
  it("FALSIFIER: reads the object shape (an array-only reader returns nothing here)", () => {
    expect(parcelIdsFromMatched({ count: 2, cap: 50, received: 2, truncated: false, parcels: rows })).toEqual([
      "48021:1",
      "48021:2",
    ]);
  });
  it("an empty or missing set is empty, not an error", () => {
    expect(parcelIdsFromMatched({ count: 0, parcels: [] })).toEqual([]);
    expect(parcelIdsFromMatched(undefined)).toEqual([]);
  });
});

describe("8. card diagnostics are off unless asked for", () => {
  it("a normal load carries no probe targets; the render report stays, documented", () => {
    const html = buildAppHtml();
    expect(html).toContain('"probeNet":[]');
    expect(html).toContain("MAP_RENDER_REPORT_URL=");
    expect(html).not.toContain("api.mapbox.com/v4/mapbox.satellite/0/0/0.jpg90");
  });
  it("the switch turns the probes back on", () => {
    process.env.SMARTSITE_CARD_DIAGNOSTICS = "1";
    try {
      expect(buildAppHtml()).toContain("api.mapbox.com/v4/mapbox.satellite/0/0/0.jpg90");
    } finally {
      delete process.env.SMARTSITE_CARD_DIAGNOSTICS;
    }
  });
});
