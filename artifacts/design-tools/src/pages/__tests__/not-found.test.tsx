/**
 * not-found — wired into the design-tools router as the catch-all
 * route (replacing the prior `<Redirect to="/" />`, which swallowed
 * unknown URLs silently). The dispatch's test plan calls for the 404
 * page to render rather than a blank page; the back-to-projects link
 * is the recovery path so the operator isn't stranded.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import NotFound from "../not-found";

describe("NotFound page", () => {
  it("renders the 404 heading and a Back-to-projects link to '/'", () => {
    const { hook } = memoryLocation({ path: "/some-unknown-url" });
    render(
      <Router hook={hook}>
        <NotFound />
      </Router>,
    );

    expect(screen.getByTestId("not-found-page")).toBeInTheDocument();
    expect(screen.getByRole("heading")).toHaveTextContent(/404/);

    const backLink = screen.getByTestId("not-found-back-home");
    expect(backLink).toBeInTheDocument();
    // The Button is wrapped in a wouter <Link href="/"> — assert the
    // closest anchor points home rather than poking at the button itself.
    expect(backLink.closest("a")).toHaveAttribute("href", "/");
  });
});
