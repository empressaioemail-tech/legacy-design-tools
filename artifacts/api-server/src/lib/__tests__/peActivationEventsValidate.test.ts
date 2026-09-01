/**
 * P-98 activation-event validator — VIOLATION FIRST.
 *
 * These run without a database (the validator imports none), which is why
 * the refusal evidence for this lane lives here rather than only in the
 * route suites: the 163 DB-backed api-server files cannot execute on a
 * machine without DATABASE_URL, and refusal evidence that only CI can run is
 * evidence nobody looked at before merging.
 *
 * Every closed-set case is asserted in BOTH directions: the accepted value
 * passes AND a neighbouring value is refused. A test that only ever sees the
 * accept side cannot distinguish a working validator from one that returns
 * ok unconditionally, which is exactly the vacuous-predicate failure this
 * program keeps finding.
 */

import { describe, it, expect } from "vitest";
import {
  PE_ACTIVATION_ACTION_IDS,
  PE_ACTIVATION_EVENT_TYPES,
  parseActivationEvent,
} from "../peActivationEventsValidate";

const VALID = { event_type: "shown", action_id: "connect_claude" };

describe("PE activation event validator", () => {
  describe("the vocabularies are frozen", () => {
    // If either list changes, the client half's emitted strings and the
    // server's accepted strings have drifted apart and every event 400s.
    // That is a coordination break, so it fails a test rather than passing
    // quietly.
    it("event_type is exactly shown and acted", () => {
      expect([...PE_ACTIVATION_EVENT_TYPES]).toEqual(["shown", "acted"]);
    });

    it("action_id is exactly the five ladder-v1 rungs", () => {
      expect([...PE_ACTIVATION_ACTION_IDS]).toEqual([
        "connect_claude",
        "unlock_expiring",
        "property_unlock",
        "annual_upgrade",
        "team_invite",
      ]);
    });
  });

  describe("the validator is not vacuous", () => {
    // The guard against a parse that returns ok for everything. If this
    // fails, every other refusal assertion below is meaningless.
    it("refuses an empty body", () => {
      expect(parseActivationEvent({}).ok).toBe(false);
    });

    it("refuses undefined and null bodies", () => {
      expect(parseActivationEvent(undefined).ok).toBe(false);
      expect(parseActivationEvent(null).ok).toBe(false);
    });
  });

  describe("event_type, both directions", () => {
    it.each([...PE_ACTIVATION_EVENT_TYPES])("accepts %s", (eventType) => {
      const parsed = parseActivationEvent({ ...VALID, event_type: eventType });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.eventType).toBe(eventType);
    });

    it.each([
      ["an unknown verb", "clicked"],
      ["a near miss on an accepted value", "show"],
      ["a case variant", "Shown"],
      ["whitespace padding", " shown "],
      ["the empty string", ""],
      ["a truthy non-string", 1],
      ["an object", { event_type: "shown" }],
      ["an array", ["shown"]],
      ["explicit null", null],
    ])("refuses %s", (_label, eventType) => {
      const parsed = parseActivationEvent({ ...VALID, event_type: eventType });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.refusal.error).toBe("invalid_event_type");
        // The refusal names the vocabulary so a drifted client can read why.
        expect(parsed.refusal.allowed).toEqual(PE_ACTIVATION_EVENT_TYPES);
      }
    });

    it("refuses an ABSENT event_type rather than defaulting to shown", () => {
      const parsed = parseActivationEvent({ action_id: "connect_claude" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.refusal.error).toBe("invalid_event_type");
    });

    it("does not accept camelCase eventType as a substitute", () => {
      // One contract. Silently reading a second field name is how a body
      // half-lands and a fabricated value fills the gap.
      const parsed = parseActivationEvent({
        eventType: "shown",
        action_id: "connect_claude",
      });
      expect(parsed.ok).toBe(false);
    });
  });

  describe("action_id, both directions", () => {
    it.each([...PE_ACTIVATION_ACTION_IDS])("accepts %s", (actionId) => {
      const parsed = parseActivationEvent({ ...VALID, action_id: actionId });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.actionId).toBe(actionId);
    });

    it.each([
      ["an invented rung", "buy_now"],
      ["a plausible-looking near miss", "connect-claude"],
      ["a case variant", "Connect_Claude"],
      ["whitespace padding", " connect_claude "],
      ["the empty string", ""],
      ["a placeholder", "unknown"],
      ["a number", 42],
      ["explicit null", null],
    ])("refuses %s", (_label, actionId) => {
      const parsed = parseActivationEvent({ ...VALID, action_id: actionId });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.refusal.error).toBe("invalid_action_id");
        expect(parsed.refusal.allowed).toEqual(PE_ACTIVATION_ACTION_IDS);
      }
    });

    it("refuses an ABSENT action_id rather than writing a placeholder", () => {
      // An invented action id pollutes the only activation measurement that
      // will exist, and is indistinguishable from a real row afterwards.
      const parsed = parseActivationEvent({ event_type: "shown" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.refusal.error).toBe("invalid_action_id");
    });
  });

  describe("event_type is checked before action_id", () => {
    it("reports the event_type refusal when BOTH are invalid", () => {
      // Deterministic error reporting: a caller fixing one field at a time
      // gets a stable sequence rather than an order that depends on key
      // iteration.
      const parsed = parseActivationEvent({
        event_type: "clicked",
        action_id: "buy_now",
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.refusal.error).toBe("invalid_event_type");
    });
  });

  describe("surface: absent is unmeasured, never defaulted", () => {
    it("writes null when surface is absent", () => {
      const parsed = parseActivationEvent(VALID);
      expect(parsed.ok).toBe(true);
      // NOT "api", NOT "" — gtm_events defaults source_surface to 'api',
      // which invents an attribution. Absent must stay absent.
      if (parsed.ok) expect(parsed.value.surface).toBeNull();
    });

    it("writes null when surface is explicitly null", () => {
      const parsed = parseActivationEvent({ ...VALID, surface: null });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.surface).toBeNull();
    });

    it("keeps a real surface, trimmed", () => {
      const parsed = parseActivationEvent({
        ...VALID,
        surface: "  settings_modal  ",
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.surface).toBe("settings_modal");
    });

    it.each([
      ["the empty string", ""],
      ["whitespace only", "   "],
      ["a number", 7],
      ["an object", {}],
    ])("refuses %s rather than coercing it to null", (_label, surface) => {
      // Coercing a malformed surface to null would turn a client bug into
      // an honest-looking absence, and absence is a claim on this table.
      const parsed = parseActivationEvent({ ...VALID, surface });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.refusal.error).toBe("invalid_surface");
    });
  });

  describe("unknown fields are ignored, not written", () => {
    it("accepts a body with extra keys and carries none of them", () => {
      const parsed = parseActivationEvent({
        ...VALID,
        surface: "settings_modal",
        parcel_node_id: "48021:34137",
        revenue: 15,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Object.keys(parsed.value).sort()).toEqual([
          "actionId",
          "eventType",
          "surface",
        ]);
      }
    });
  });
});
