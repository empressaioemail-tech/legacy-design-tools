import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkByHeader, MAX_CHARS_PER_CHUNK } from "./parser";

const iwuicText = readFileSync(
  join(__dirname, "__fixtures__/iwuic-extracted-text.txt"),
  "utf8",
);

describe("chunkByHeader: edge cases", () => {
  it("returns [] for empty input", () => {
    expect(chunkByHeader("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(chunkByHeader("   \n\n   \n")).toEqual([]);
  });

  it("returns one ref-less chunk for plain text with no headers", () => {
    const out = chunkByHeader("hello world\nthis is just text\nno headers here");
    expect(out).toHaveLength(1);
    expect(out[0].ref).toBeNull();
    expect(out[0].title).toBeNull();
    expect(out[0].body).toContain("hello world");
  });

  it("recognizes 'CHAPTER N' headers", () => {
    const out = chunkByHeader(
      "CHAPTER 4\nbody one\nbody two\nCHAPTER 5\nbody three",
    );
    const refs = out.map((c) => c.ref);
    expect(refs).toEqual(["CHAPTER 4", "CHAPTER 5"]);
  });

  it("recognizes 'CHAPTER N - TITLE' headers and pulls the title", () => {
    const out = chunkByHeader("CHAPTER 4 - SPECIAL OCCUPANCIES\nbody\n");
    expect(out[0].ref).toBe("CHAPTER 4");
    expect(out[0].title).toBe("SPECIAL OCCUPANCIES");
  });

  it("recognizes 'SECTION NNN' headers", () => {
    const out = chunkByHeader(
      "SECTION 401\nbody one\nSECTION 402 - SCOPE\nbody two",
    );
    expect(out.map((c) => c.ref)).toEqual(["SECTION 401", "SECTION 402"]);
    expect(out[1].title).toBe("SCOPE");
  });

  it("recognizes subsection headers like '401.1 General.'", () => {
    const out = chunkByHeader("401.1 General.\nThis is the body of 401.1.\n");
    expect(out[0].ref).toBe("401.1");
    expect(out[0].title).toBe("General.");
    expect(out[0].body).toContain("This is the body of 401.1.");
  });

  it("splits chunks larger than MAX_CHARS_PER_CHUNK into #partN with parallel title suffix", () => {
    expect(MAX_CHARS_PER_CHUNK).toBe(4000);
    const big = "x".repeat(MAX_CHARS_PER_CHUNK * 2 + 100);
    const out = chunkByHeader(`SECTION 999 - HUGE\n${big}`);
    // body length is MAX*2+100 → 3 parts: 4000, 4000, 100
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.map((c) => c.ref)).toEqual([
      "SECTION 999#part1",
      "SECTION 999#part2",
      "SECTION 999#part3",
    ]);
    expect(out[0].title).toBe("HUGE (part 1)");
    expect(out[0].body.length).toBe(MAX_CHARS_PER_CHUNK);
    expect(out[1].body.length).toBe(MAX_CHARS_PER_CHUNK);
    expect(out[2].body.length).toBe(100);
  });

  it("handles the IWUIC PDF fixture: produces multiple CHAPTER and SECTION chunks", () => {
    const out = chunkByHeader(iwuicText);
    expect(out.length).toBeGreaterThan(20);
    const chapters = out.filter((c) => c.ref?.startsWith("CHAPTER "));
    const sections = out.filter((c) => c.ref?.startsWith("SECTION "));
    expect(chapters.length).toBeGreaterThanOrEqual(5);
    expect(sections.length).toBeGreaterThanOrEqual(10);
    // Every chunk must respect the size cap.
    for (const c of out) {
      expect(c.body.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
  });

  it("IWUIC fixture: at least one section was split into #part chunks", () => {
    const out = chunkByHeader(iwuicText);
    const split = out.filter((c) => /#part\d+$/.test(c.ref ?? ""));
    expect(split.length).toBeGreaterThanOrEqual(1);
  });
});
