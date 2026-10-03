import { describe, expect, it } from "vitest";
import {
  resendLifecycleConfigFromEnv,
  sendLifecycleToResend,
  type ResendSubject,
} from "./peResendLifecycle";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function fakeFetch(opts: { contactExists?: boolean; failOn?: string } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (opts.failOn && url.endsWith(opts.failOn)) {
      return json(422, { name: "validation_error", message: "bad payload" });
    }
    if (method === "PATCH") {
      return opts.contactExists ? json(200, { object: "contact", id: "c1" }) : json(404, { name: "not_found" });
    }
    return json(200, { object: "x", id: "c1" });
  }) as typeof fetch;
  return { calls, impl };
}

const CONFIG = { apiKey: "re_test", ssSegmentId: "seg_ss", affiliateSegmentId: "seg_aff" };

const SS: ResendSubject = {
  kind: "smart_site",
  email: "a@example.com",
  firstName: "Ada",
  properties: { ss_stage: "Explorer", ss_source: "ad", ss_quiet: "false" },
  inSegment: false,
};

describe("configuration refuses by name, no default", () => {
  it("RESEND_API_KEY unset", () => {
    expect(resendLifecycleConfigFromEnv({})).toEqual({ refused: "resend_api_key_unset" });
  });

  it("segment ids unset refuse at send time with their names, before any request", async () => {
    const f = fakeFetch();
    const ss = await sendLifecycleToResend(
      { subject: SS, event: "ss.lot_saved", eventPayload: null },
      { fetchImpl: f.impl, config: { apiKey: "k", ssSegmentId: null, affiliateSegmentId: null }, minIntervalMs: 0 },
    );
    expect(ss).toEqual({ ok: false, error: "resend_ss_segment_id_unset" });
    const aff = await sendLifecycleToResend(
      { subject: { ...SS, kind: "affiliate", properties: {} }, event: "affiliate.applied", eventPayload: null },
      { fetchImpl: f.impl, config: { apiKey: "k", ssSegmentId: "s", affiliateSegmentId: null }, minIntervalMs: 0 },
    );
    expect(aff).toEqual({ ok: false, error: "resend_affiliate_segment_id_unset" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("contact upsert then event", () => {
  it("unknown contact: PATCH 404, then create in the segment, then the event", async () => {
    const f = fakeFetch();
    const r = await sendLifecycleToResend(
      { subject: SS, event: "ss.account_created", eventPayload: null },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(r).toEqual({ ok: true, addedToSegment: true });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH https://api.resend.com/contacts/a%40example.com",
      "POST https://api.resend.com/contacts",
      "POST https://api.resend.com/events/send",
    ]);
    expect(f.calls[1]!.body).toEqual({
      email: "a@example.com",
      first_name: "Ada",
      properties: { ss_stage: "Explorer", ss_source: "ad", ss_quiet: "false" },
      segments: [{ id: "seg_ss" }],
    });
    expect(f.calls[2]!.body).toEqual({ event: "ss.account_created", email: "a@example.com" });
  });

  it("existing contact not yet in the segment is added; one already in it is not", async () => {
    const f = fakeFetch({ contactExists: true });
    await sendLifecycleToResend(
      { subject: SS, event: "ss.lot_saved", eventPayload: null },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(f.calls.map((c) => c.url)).toContain(
      "https://api.resend.com/contacts/a%40example.com/segments/seg_ss",
    );
    const g = fakeFetch({ contactExists: true });
    const r = await sendLifecycleToResend(
      { subject: { ...SS, inSegment: true }, event: "ss.lot_saved", eventPayload: null },
      { fetchImpl: g.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(r).toEqual({ ok: true, addedToSegment: false });
    expect(g.calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
  });

  it("E6 (event null) updates the contact and sends no event", async () => {
    const f = fakeFetch({ contactExists: true });
    await sendLifecycleToResend(
      { subject: { ...SS, inSegment: true }, event: null, eventPayload: null },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(f.calls.some((c) => c.url.endsWith("/events/send"))).toBe(false);
  });

  it("previous_plan travels as event payload", async () => {
    const f = fakeFetch({ contactExists: true });
    await sendLifecycleToResend(
      { subject: { ...SS, inSegment: true }, event: "ss.plan_started", eventPayload: { previous_plan: "unlock" } },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(f.calls.at(-1)!.body).toEqual({
      event: "ss.plan_started",
      email: "a@example.com",
      payload: { previous_plan: "unlock" },
    });
  });

  it("a failing step reports Resend's own error by name", async () => {
    const f = fakeFetch({ contactExists: true, failOn: "/events/send" });
    const r = await sendLifecycleToResend(
      { subject: { ...SS, inSegment: true }, event: "ss.lot_saved", eventPayload: null },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(r).toEqual({
      ok: false,
      error: "resend_event_send_http_422:validation_error:bad payload",
    });
  });

  it("an affiliate carries first name and email only, into the affiliate segment", async () => {
    const f = fakeFetch();
    await sendLifecycleToResend(
      {
        subject: { kind: "affiliate", email: "aff@example.com", firstName: "Bo", properties: {}, inSegment: false },
        event: "affiliate.applied",
        eventPayload: null,
      },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(f.calls[1]!.body).toEqual({
      email: "aff@example.com",
      first_name: "Bo",
      segments: [{ id: "seg_aff" }],
    });
  });

  it("refuses to send a parcel-shaped property even if a caller built one", async () => {
    const f = fakeFetch({ contactExists: true });
    const r = await sendLifecycleToResend(
      { subject: { ...SS, properties: { apn: "R12345" } }, event: null, eventPayload: null },
      { fetchImpl: f.impl, config: CONFIG, minIntervalMs: 0 },
    );
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
