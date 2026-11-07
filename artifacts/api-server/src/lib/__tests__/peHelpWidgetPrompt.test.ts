/**
 * P-118 — the Help widget's system prompt. Pure content assertions, no DB,
 * no network: the honesty discipline and the "adapt, never paste" rule are
 * properties of the STRING itself, so they're testable directly.
 */

import { describe, expect, it } from "vitest";
import { PE_HELP_WIDGET_SYSTEM_PROMPT } from "../peHelpWidgetPrompt";

describe("P-118: Help widget system prompt — honesty discipline", () => {
  it("never claims to be a valuation tool", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/valuation tool/i);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/deliberately is not one/i);
  });

  it("instructs an honest 'I don't have that' rather than a guess", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/don't have that information|say plainly that you don't have/i);
  });

  it("refuses to assert coverage for a specific place", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/never claim or imply coverage/i);
  });

  it("never claims a citation or confidence mechanism this widget doesn't have", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/never fabricate a citation/i);
  });

  it("scopes itself away from property-specific questions and points at the other tool", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/you have no access to any parcel/i);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/its own AI chat/i);
  });
});

describe("P-118: Help widget system prompt — the competitor rule is adapted, not pasted", () => {
  it("carries the BEHAVIOR (never name a competitor) as an instruction to the assistant", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/never name, criticize, or compare/i);
  });

  it("does NOT paste the source doc's literal meta-instruction verbatim", () => {
    // The FAQ master's actual line is a parenthetical aimed at a human rep:
    // "(Reminder: never attack a competitor by name in customer material...)"
    // That sentence is a rule ABOUT the assistant's behavior, not something
    // the assistant should ever say aloud — so it must not appear in the
    // prompt as quoted/spoken text.
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).not.toMatch(/Reminder: never attack a competitor by name/i);
  });

  it("does not paste the FAQ's raw Q&A heading format", () => {
    // The source doc is literally structured as "**Question?**\nAnswer."
    // Markdown Q&A headers. The adapted prompt is prose instruction, not a
    // pasted FAQ — bold-question markdown should not survive the adaptation.
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).not.toMatch(/\*\*"I already have/);
  });
});

describe("P-118: Help widget system prompt — pricing facts are exact, not paraphrased away", () => {
  it("carries every tier's real price", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/\$49\/month/);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/\$129\/month/);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/\$299\/month/);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/\$25 per additional seat/);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/\$15 for 30 days/);
  });

  it("never invents a sales-call path — the product is the demo", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/no sales team and no demo call/i);
  });

  it("keeps the funnel instruction — proactive next steps, not a passive FAQ box", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/name the concrete next step/i);
  });
});
