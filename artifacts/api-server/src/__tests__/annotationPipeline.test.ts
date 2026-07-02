/**
 * Unit tests for the AI-vision coordinate extractor. Only the `anthropic`
 * singleton is mocked (no network); the parsing / validation / robustness
 * logic in `extractAnnotationCoordinates` is what is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create } },
}));

const { extractAnnotationCoordinates } = await import(
  "../lib/annotationPipeline"
);

const finding = {
  findingId: "f-1",
  codeSection: "IBC 1006.2",
  description: "egress width insufficient",
};

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("extractAnnotationCoordinates", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("parses a clean JSON bbox", async () => {
    create.mockResolvedValueOnce(
      textResponse(JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })),
    );
    const box = await extractAnnotationCoordinates("imgb64", finding);
    expect(box).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it("strips markdown code fences", async () => {
    create.mockResolvedValueOnce(
      textResponse(
        '```json\n{"x":0.1,"y":0.1,"width":0.2,"height":0.2}\n```',
      ),
    );
    const box = await extractAnnotationCoordinates("imgb64", finding);
    expect(box).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  });

  it("returns null on notFound", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ notFound: true })));
    expect(await extractAnnotationCoordinates("imgb64", finding)).toBeNull();
  });

  it("returns null on prose (unparseable)", async () => {
    create.mockResolvedValueOnce(
      textResponse("I could not confidently locate the element."),
    );
    expect(await extractAnnotationCoordinates("imgb64", finding)).toBeNull();
  });

  it("returns null on out-of-range coordinates", async () => {
    create.mockResolvedValueOnce(
      textResponse(JSON.stringify({ x: 1.5, y: 0.2, width: 0.3, height: 0.4 })),
    );
    expect(await extractAnnotationCoordinates("imgb64", finding)).toBeNull();
  });

  it("returns null on non-text block", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "tool_use" }] });
    expect(await extractAnnotationCoordinates("imgb64", finding)).toBeNull();
  });

  it("never throws when the client rejects", async () => {
    create.mockRejectedValueOnce(new Error("network down"));
    await expect(
      extractAnnotationCoordinates("imgb64", finding),
    ).resolves.toBeNull();
  });
});
