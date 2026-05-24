import { describe, expect, it } from "vitest";
import { zipStore } from "../zipStore";

describe("zipStore", () => {
  it("emits a valid PK local file header", () => {
    const archive = zipStore([
      { name: "hello.txt", data: new TextEncoder().encode("hi") },
    ]);
    expect(archive[0]).toBe(0x50);
    expect(archive[1]).toBe(0x4b);
    expect(archive[2]).toBe(0x03);
    expect(archive[3]).toBe(0x04);
  });
});
