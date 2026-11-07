import { describe, expect, it } from "vitest";
import {
  hashEmail,
  metaCapiConfigFromEnv,
  sendMetaCapiEvent,
} from "./peMetaCapi";

describe("Meta Conversions API", () => {
  it("hashes email and sends CompleteRegistration with the event_id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    };
    const result = await sendMetaCapiEvent(
      {
        event: "e1_account_created",
        eventId: "evt-1",
        email: "Ad@Example.COM",
      },
      {
        fetchImpl,
        config: { pixelId: "px_1", accessToken: "tok_1" },
      },
    );
    expect(result).toEqual({ ok: true, eventName: "CompleteRegistration" });
    expect(hashEmail("Ad@Example.COM")).toBe(hashEmail("ad@example.com"));
    const payload = calls[0]!.body as {
      data: Array<{ event_name: string; event_id: string; user_data: { em: string[] } }>;
    };
    expect(payload.data[0]!.event_name).toBe("CompleteRegistration");
    expect(payload.data[0]!.event_id).toBe("evt-1");
    expect(payload.data[0]!.user_data.em[0]).toBe(hashEmail("ad@example.com"));
    expect(JSON.stringify(payload)).not.toMatch(/Ad@Example/);
  });

  it("Purchase carries value and currency and no personal custom params", async () => {
    const calls: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    await sendMetaCapiEvent(
      {
        event: "e4_unlock_bought",
        eventId: "evt-p",
        email: "p@example.com",
        value: 15,
        currency: "USD",
      },
      { fetchImpl, config: { pixelId: "px", accessToken: "tok" } },
    );
    const json = JSON.stringify(calls[0]);
    expect(json).toContain('"value":15');
    expect(json).toContain("USD");
    expect(json).not.toMatch(/note|ownerName|parcelNodeId/);
  });

  it("refuses by name when the token is absent — never a placeholder send", async () => {
    const fetchImpl = async () => {
      throw new Error("must not send");
    };
    const result = await sendMetaCapiEvent(
      { event: "e1_account_created", eventId: "x", email: "a@b.com" },
      { fetchImpl, config: { refused: "meta_capi_token_absent" } },
    );
    expect(result).toEqual({ ok: false, error: "meta_capi_token_absent" });
    expect(metaCapiConfigFromEnv({})).toEqual({ refused: "meta_pixel_id_absent" });
    expect(
      metaCapiConfigFromEnv({
        META_PIXEL_ID: "px",
        META_CAPI_ACCESS_TOKEN: "placeholder",
      }),
    ).toEqual({ refused: "meta_capi_token_placeholder" });
  });
});
