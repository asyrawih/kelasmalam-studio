import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerPage } from "./ComposerPage";

afterEach(cleanup);
it("shares notes between rack and piano and undoes both views", () => {
  render(<ComposerPage onOpenStudio={vi.fn()} onOpenDj={vi.fn()} />);
  const step = screen.getByLabelText("Kick step 2");
  const note = screen.getByLabelText("Note 0 step 2");
  const previous = step.getAttribute("aria-pressed");
  fireEvent.click(step);
  expect(note.getAttribute("aria-pressed")).not.toBe(previous);
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  expect(step.getAttribute("aria-pressed")).toBe(previous);
  expect(note.getAttribute("aria-pressed")).toBe(previous);
});
it("creates an independent pattern and places or erases it without altering other clips", () => {
  render(<ComposerPage onOpenStudio={vi.fn()} onOpenDj={vi.fn()} />);
  fireEvent.click(
    screen.getByRole("button", { name: "+ Pattern" }),
  );
  expect(
    screen.getByLabelText("Kick step 1").getAttribute("aria-pressed"),
  ).toBe("false");
  fireEvent.click(screen.getByLabelText("Place pattern track 2 bar 1"));
  expect(
    screen.getByLabelText("Place pattern track 2 bar 1").textContent,
  ).toContain("Pattern 2");
  expect(
    screen.getByLabelText("Place pattern track 1 bar 1").textContent,
  ).toContain("Main groove");
  fireEvent.click(screen.getByRole("button", { name: "Erase" }));
  fireEvent.click(screen.getByLabelText("Erase pattern track 2 bar 1"));
  expect(screen.getByLabelText("Erase pattern track 2 bar 1").textContent).toBe(
    "",
  );
});
it("keeps audio controls disabled and provides navigation without creating audio", () => {
  const studio = vi.fn();
  render(<ComposerPage onOpenStudio={studio} onOpenDj={vi.fn()} />);
  expect(screen.getByLabelText("Play unavailable").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Studio" }));
  expect(studio).toHaveBeenCalledOnce();
});
