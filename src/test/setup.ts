// Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.) with
// Vitest's `expect`, and auto-cleans the DOM between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
