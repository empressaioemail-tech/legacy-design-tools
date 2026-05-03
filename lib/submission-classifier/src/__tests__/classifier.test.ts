/**
 * `parseClassificationResponse` — pure-unit tests for the model-
 * response parser. Moved verbatim from api-server's
 * `submission-classification.test.ts` as part of the
 * `@workspace/submission-classifier` extraction.
 *
 * These cases are the contract between the model's JSON output and
 * the `ClassificationResult` shape downstream consumers (the row
 * insert, the FE wire) rely on. Each case pins one piece of the
 * "tolerance" surface (prose tolerance, closed-set discriminator
 * filter, range clamp on confidence, JSON-error fallback).
 */

import { describe, it, expect } from "vitest";
import { parseClassificationResponse } from "../classifier";
import type { ClassifierLogger } from "../types";

function fakeLogger(): ClassifierLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("parseClassificationResponse", () => {
  const log = fakeLogger();

  it("parses a minimal valid response", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "residential-addition",
        disciplines: ["building", "residential"],
        applicableCodeBooks: ["IRC 2021"],
        confidence: 0.81,
      }),
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: "residential-addition",
      disciplines: ["building", "residential"],
      applicableCodeBooks: ["IRC 2021"],
      confidence: 0.81,
    });
  });

  it("tolerates leading/trailing prose around the JSON object", () => {
    const result = parseClassificationResponse(
      `Here is your classification:\n\n${JSON.stringify({
        projectType: "x",
        disciplines: ["building"],
        applicableCodeBooks: [],
        confidence: 0.5,
      })}\n\nThanks!`,
      log,
      "sub-1",
    );
    expect(result.projectType).toBe("x");
    expect(result.disciplines).toEqual(["building"]);
    expect(result.confidence).toBe(0.5);
  });

  it("drops unknown discipline values silently", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "x",
        disciplines: ["building", "not-a-discipline", "fire-life-safety"],
        applicableCodeBooks: [],
        confidence: 0.7,
      }),
      log,
      "sub-1",
    );
    expect(result.disciplines).toEqual(["building", "fire-life-safety"]);
  });

  it("nulls out-of-range confidence", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "x",
        disciplines: [],
        applicableCodeBooks: [],
        confidence: 1.5,
      }),
      log,
      "sub-1",
    );
    expect(result.confidence).toBeNull();
  });

  it("returns the empty result on a non-JSON response", () => {
    const result = parseClassificationResponse(
      "I'm sorry, I can't classify this.",
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: null,
      disciplines: [],
      applicableCodeBooks: [],
      confidence: null,
    });
  });

  it("returns the empty result on malformed JSON inside braces", () => {
    const result = parseClassificationResponse(
      "{ definitely not json }",
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: null,
      disciplines: [],
      applicableCodeBooks: [],
      confidence: null,
    });
  });
});
