import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DragDropUpload } from "../DragDropUpload";

afterEach(() => cleanup());

describe("DragDropUpload", () => {
  it("accepts a file via the hidden input", () => {
    const onFileChange = vi.fn();
    render(
      <DragDropUpload
        file={null}
        onFileChange={onFileChange}
        accept="image/png"
        testId="upload"
      />,
    );
    const input = screen.getByTestId("upload-input");
    const file = new File(["x"], "test.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileChange).toHaveBeenCalledWith(file);
  });

  it("rejects oversize files", () => {
    const onFileChange = vi.fn();
    render(
      <DragDropUpload
        file={null}
        onFileChange={onFileChange}
        maxBytes={10}
        testId="upload"
      />,
    );
    const input = screen.getByTestId("upload-input");
    const file = new File([new Uint8Array(20)], "big.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileChange).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("upload-error")).toBeInTheDocument();
  });
});
