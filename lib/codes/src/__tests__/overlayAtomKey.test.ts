/**
 * Canonical overlay atom-id key — namespace normalization for arrow-two.
 */

import { describe, it, expect } from "vitest";
import {
  HAUSKA_CODE_SECTION_DID_PREFIX,
  canonicalOverlayAtomKey,
  canonicalOverlayKeyFromCodeToken,
  isReasoningOverlayAtomId,
  overlayAtomLookupKey,
  toHauskaCodeSectionDid,
} from "../overlayAtomKey";

const CORPUS_UUID = "550E8400-E29B-41D4-A716-446655440000";
const CORPUS_UUID_LOWER = CORPUS_UUID.toLowerCase();

describe("canonicalOverlayAtomKey", () => {
  it("collapses bare UUID and did:hauska:code-section DID to the same key", () => {
    const did = `${HAUSKA_CODE_SECTION_DID_PREFIX}${CORPUS_UUID}`;
    expect(canonicalOverlayAtomKey(CORPUS_UUID)).toBe(CORPUS_UUID_LOWER);
    expect(canonicalOverlayAtomKey(did)).toBe(CORPUS_UUID_LOWER);
    expect(canonicalOverlayAtomKey(CORPUS_UUID_LOWER)).toBe(CORPUS_UUID_LOWER);
  });

  it("round-trips reasoning ids without collapsing into corpus keys", () => {
    const reasoningId = "reasoning:fbc-2023:fbc-m601-6";
    expect(canonicalOverlayAtomKey(reasoningId)).toBe(reasoningId);
    expect(isReasoningOverlayAtomId(reasoningId)).toBe(true);
    expect(canonicalOverlayAtomKey(reasoningId)).not.toBe(CORPUS_UUID_LOWER);
  });

  it("round-trips websearch ids without collapsing into corpus keys", () => {
    const webId = "websearch:fbc-2023:fbc-m601-6";
    expect(canonicalOverlayAtomKey(webId)).toBe(webId);
    expect(isReasoningOverlayAtomId(webId)).toBe(true);
  });

  it("keystone structured ref resolves to expected overlay key", () => {
    const token = "[[CODE:reasoning:fbc-2023:fbc-m601-6]]";
    expect(canonicalOverlayKeyFromCodeToken(token)).toBe(
      "reasoning:fbc-2023:fbc-m601-6",
    );
    expect(
      overlayAtomLookupKey({
        jurisdictionTenant: "miami_beach_fl",
        atomId: "reasoning:fbc-2023:fbc-m601-6",
      }),
    ).toBe("miami_beach_fl\0reasoning:fbc-2023:fbc-m601-6");
  });

  it("UUID and DID citations share one overlay lookup key", () => {
    const tenant = "bastrop_tx";
    const fromUuid = overlayAtomLookupKey({
      jurisdictionTenant: tenant,
      atomId: CORPUS_UUID,
    });
    const fromDid = overlayAtomLookupKey({
      jurisdictionTenant: tenant,
      atomId: `${HAUSKA_CODE_SECTION_DID_PREFIX}${CORPUS_UUID}`,
    });
    expect(fromUuid).toBe(fromDid);
  });
});

describe("toHauskaCodeSectionDid", () => {
  it("builds DID from UUID and normalizes casing", () => {
    expect(toHauskaCodeSectionDid(CORPUS_UUID)).toBe(
      `${HAUSKA_CODE_SECTION_DID_PREFIX}${CORPUS_UUID_LOWER}`,
    );
  });

  it("passes reasoning ids through unchanged", () => {
    const reasoningId = "reasoning:fbc-2023:fbc-m601-6";
    expect(toHauskaCodeSectionDid(reasoningId)).toBe(reasoningId);
  });
});
