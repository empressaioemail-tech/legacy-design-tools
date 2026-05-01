/**
 * /api/chat — full round-trip from the design-tools picker UI through the
 * api-server chat route, the mocked Anthropic SDK, the SSE response, the
 * store's stream parser, and the chip renderer.
 *
 * Why this lives here (not in design-tools): the round-trip needs an
 * in-process Express app + the per-file PG schema lifecycle + Anthropic
 * mocking infrastructure that already lives under
 * `artifacts/api-server/src/__tests__/`. To still exercise the *real*
 * client-side flow it imports the design-tools store and chip renderer
 * via runtime path strings — pure dev-only test wiring, never reached by
 * the api-server runtime. The path strings are deliberately not literal
 * imports so tsc does not recurse into the design-tools tree (which
 * targets the Vite/DOM environment, not this server's Node tsconfig).
 *
 * What this test catches that the existing layered tests miss:
 *   - id casing or shape regressions in how the store packs the picker's
 *     selected snapshot ids into the `/api/chat` request body
 *     (`snapshotFocusIds` field name, UUID lowercase, array shape)
 *   - validator drift in `chat.ts` Zod schema (e.g. requiring 1+, denying
 *     empty arrays, capping at MAX_FOCUS_SNAPSHOTS)
 *   - snapshot lookup regressions (engagement-scoped query, missing rows
 *     dropping into `<snapshot_focus snapshot_id="…">` blocks)
 *   - SSE framing changes that break the store's `data: {…}\n\n` parser
 *   - chip rendering regex drift on the client side
 *     (`{{atom|snapshot|<id>|focus}}` → `data-testid="snapshot-citation-<id>"`)
 *
 * The single combined test mirrors what a Playwright run against the
 * live preview would do (open the picker, tick two snapshots, send,
 * assert chips), but with a mocked Anthropic so the assistant reply is
 * deterministic and the test passes in CI without an outbound LLM call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ctx } from "./test-context";

interface FakeStreamEvent {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
}

const anthropicMocks = vi.hoisted(() => ({
  events: null as null | Iterable<FakeStreamEvent>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastArgs: null as any,
}));

// Each /api/chat body the design-tools store sends through the fetch
// shim is appended here, so a test can assert what the picker actually
// posted (independent of how the route then handled it).
const chatRequestBodies: unknown[] = [];

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("chat-roundtrip.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream: (args: any) => {
        anthropicMocks.lastArgs = args;
        const events = anthropicMocks.events ?? [];
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const e of events) {
              await Promise.resolve();
              yield e;
            }
          },
        };
      },
    },
  },
}));

const { setupRouteTests } = await import("./setup");
const { engagements, snapshots } = await import("@workspace/db");

// Cross-artifact relative imports — paths are runtime strings so tsc
// does not statically follow them. At test time vite resolves the
// modules and runs them through the React plugin.
interface ChatMessageShape {
  role: "user" | "assistant";
  content: string;
}
interface EngagementsStoreShape {
  selectedSnapshotIdByEngagement: Record<string, string | null>;
  messagesByEngagement: Record<string, ChatMessageShape[]>;
  attachedSheetsByEngagement: Record<string, unknown[]>;
  pendingChatInputByEngagement: Record<string, string>;
  focusSnapshotIdsByEngagement: Record<string, string[]>;
  streaming: boolean;
  toggleFocusSnapshot: (engagementId: string, snapshotId: string) => void;
  sendMessage: (
    engagementId: string,
    question: string,
    options?: { snapshotFocus?: boolean; snapshotFocusIds?: string[] },
  ) => Promise<void>;
}
interface EngagementsStoreModule {
  useEngagementsStore: {
    getState: () => EngagementsStoreShape;
    setState: (partial: Partial<EngagementsStoreShape>) => void;
  };
}
interface AtomChipsModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderWithAtomChips: (children: any) => any;
}

const STORE_PATH = "../../../design-tools/src/store/engagements";
const CHIPS_PATH = "../../../design-tools/src/components/atomChips";
const { useEngagementsStore } = (await import(
  /* @vite-ignore */ STORE_PATH
)) as unknown as EngagementsStoreModule;
const { renderWithAtomChips } = (await import(
  /* @vite-ignore */ CHIPS_PATH
)) as unknown as AtomChipsModule;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  // Zustand stores are module-singletons. Without an explicit reset, the
  // previous test's messagesByEngagement / focusSnapshotIds would leak
  // across tests in this file.
  useEngagementsStore.setState({
    selectedSnapshotIdByEngagement: {},
    messagesByEngagement: {},
    attachedSheetsByEngagement: {},
    pendingChatInputByEngagement: {},
    focusSnapshotIdsByEngagement: {},
    streaming: false,
  });
  chatRequestBodies.length = 0;
  anthropicMocks.events = null;
  anthropicMocks.lastArgs = null;
});

/**
 * Replace `globalThis.fetch` so the design-tools store's
 * `${BASE_URL}api/chat` POST is dispatched into the in-process Express
 * app via supertest. Returns a Web-spec `Response` whose body is a
 * `ReadableStream<Uint8Array>` — that is exactly what the store's
 * `res.body.getReader()` + TextDecoder + `data: {…}\n\n` frame loop
 * expects, so the real SSE parser runs end-to-end.
 *
 * Typed loosely (`any`) at the boundary because the api-server's
 * tsconfig intentionally omits the DOM lib — at runtime under Node 18+
 * the global `Response` and `ReadableStream` constructors are present.
 */
function installFetchShim(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shim = async (input: any, init?: any): Promise<any> => {
    const url =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : String(input);
    if (!url.endsWith("/api/chat")) {
      throw new Error(`fetch shim: unexpected URL ${url}`);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    chatRequestBodies.push(body);
    const res = await request(getApp())
      .post("/api/chat")
      .set("Content-Type", "application/json")
      .send(body);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const HeadersCtor: any = (globalThis as any).Headers;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ReadableStreamCtor: any = (globalThis as any).ReadableStream;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ResponseCtor: any = (globalThis as any).Response;

    const headers = new HeadersCtor();
    for (const [k, v] of Object.entries(res.headers)) {
      headers.set(k, String(v));
    }
    // supertest collapses the SSE response into one `res.text` blob.
    // Re-emitting it as a single ReadableStream chunk still drives the
    // store's frame parser correctly because the parser splits on
    // `\n\n` boundaries — chunk size is irrelevant to that loop.
    const encoded = new TextEncoder().encode(res.text);
    const stream = new ReadableStreamCtor({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      start(controller: any) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    return new ResponseCtor(stream, {
      status: res.status,
      headers,
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = shim;
}

describe("chat round-trip: picker → /api/chat → store → snapshot citation chips", () => {
  it("two snapshots staged in the picker stream back as `{{atom|snapshot|<id>|focus}}` markers and render as citation chips", async () => {
    if (!ctx.schema) throw new Error("schema not ready");

    // Seed: one engagement + two snapshots, both inserts return real
    // server-generated UUIDs so the test exercises the real lookup path
    // with no hard-coded ids.
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Round-trip Engagement",
        nameLower: `roundtrip-${Math.random().toString(36).slice(2)}`,
        jurisdiction: "Moab, UT",
        address: "123 Main St",
      })
      .returning({ id: engagements.id });
    const [older] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Older Project",
        payload: { rooms: [{ number: "204", areaSqft: 300 }] },
        sheetCount: 0,
        roomCount: 1,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });
    const [newer] = await ctx.schema.db
      .insert(snapshots)
      .values({
        engagementId: eng.id,
        projectName: "Newer Project",
        payload: { rooms: [{ number: "204", areaSqft: 312 }] },
        sheetCount: 0,
        roomCount: 1,
        levelCount: 0,
        wallCount: 0,
        receivedAt: new Date("2026-05-01T00:00:00.000Z"),
      })
      .returning({ id: snapshots.id });

    // Anthropic stub: split the citation response across two SSE deltas
    // so the store's incremental `content + parsed.text` accumulation is
    // exercised on top of the marker-preservation invariant.
    anthropicMocks.events = [
      {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: `Older push: {{atom|snapshot|${older.id}|focus}} `,
        },
      },
      {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: `vs newer push: {{atom|snapshot|${newer.id}|focus}}.`,
        },
      },
    ];
    installFetchShim();

    // Drive the picker UI exactly like the user does — toggling each
    // snapshot row checkbox calls `toggleFocusSnapshot` on the store.
    // The order of the resulting array IS the order ClaudeChat reads
    // when calling `sendMessage`, so we assert it explicitly.
    const store = useEngagementsStore.getState();
    store.toggleFocusSnapshot(eng.id, older.id);
    store.toggleFocusSnapshot(eng.id, newer.id);
    expect(
      useEngagementsStore.getState().focusSnapshotIdsByEngagement[eng.id],
    ).toEqual([older.id, newer.id]);

    // `ClaudeChat.handleSend` pulls the staged ids out of the store and
    // hands them to `sendMessage`. We mirror that exactly — re-reading
    // from the store rather than reusing the local `[older.id, newer.id]`
    // array makes the test fail loudly if `toggleFocusSnapshot` ever
    // starts losing or reordering entries.
    const stagedIds =
      useEngagementsStore.getState().focusSnapshotIdsByEngagement[eng.id];
    await useEngagementsStore
      .getState()
      .sendMessage(
        eng.id,
        "how did the room schedule change between these two pushes?",
        { snapshotFocusIds: stagedIds },
      );

    // (1) Picker auto-clears after a successful send (one-shot
    //     semantics from `sendMessage` — guards the UX invariant that
    //     follow-up turns don't accidentally keep paying the focus cost).
    expect(
      useEngagementsStore.getState().focusSnapshotIdsByEngagement[eng.id],
    ).toEqual([]);

    // (2) The exact request body the store posted carries the right
    //     field name + array shape + ids. This is the layer where an id
    //     casing change or a renamed field would silently regress.
    expect(chatRequestBodies).toHaveLength(1);
    const body = chatRequestBodies[0] as {
      engagementId: string;
      question: string;
      snapshotFocusIds?: string[];
    };
    expect(body.engagementId).toBe(eng.id);
    expect(body.snapshotFocusIds).toEqual([older.id, newer.id]);

    // (3) The route validated and looked up both snapshots — the system
    //     prompt sent to the SDK carries one `<snapshot_focus>` block
    //     per id. A validator change that drops empty/unknown ids OR a
    //     query change that loses the older snapshot would break this.
    const system = String(anthropicMocks.lastArgs.system);
    expect(system).toContain(`<snapshot_focus snapshot_id="${older.id}">`);
    expect(system).toContain(`<snapshot_focus snapshot_id="${newer.id}">`);

    // (4) The streamed assistant message — accumulated by the store's
    //     SSE parser — round-tripped both focus markers byte-for-byte.
    //     This is the half of the assertion that catches SSE framing
    //     drift or store parser regressions.
    const msgs =
      useEngagementsStore.getState().messagesByEngagement[eng.id] ?? [];
    const assistant = msgs.at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toContain(
      `{{atom|snapshot|${older.id}|focus}}`,
    );
    expect(assistant?.content).toContain(
      `{{atom|snapshot|${newer.id}|focus}}`,
    );

    // (5) `renderWithAtomChips` rewrites those markers into snapshot
    //     citation chip elements (`data-testid="snapshot-citation-<id>"`).
    //     Rendering through `react-dom/server` is enough to assert the
    //     chip output without standing up a full happy-dom mount, and
    //     keeps this test in the api-server's `node` vitest environment.
    const html = renderToStaticMarkup(
      createElement("div", null, renderWithAtomChips(assistant!.content)),
    );
    expect(html).toContain(`data-testid="snapshot-citation-${older.id}"`);
    expect(html).toContain(`data-testid="snapshot-citation-${newer.id}"`);
    // Sanity: the chip glyph's short-id label still renders so the
    // visual regression of "snapshot id was lower-cased on the way out"
    // would also surface here.
    expect(html).toContain(`SNAP·${older.id.slice(0, 8)}`);
    expect(html).toContain(`SNAP·${newer.id.slice(0, 8)}`);
  });
});
