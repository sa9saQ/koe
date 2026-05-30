import { describe, expect, it } from "vitest";
import { nanodollarsToUsdDisplay } from "./utils";

describe("nanodollarsToUsdDisplay", () => {
  it("converts 1 USD worth of nanodollars to 1.0", () => {
    expect(nanodollarsToUsdDisplay(1_000_000_000)).toBe(1.0);
  });

  it("converts 10 USD worth", () => {
    expect(nanodollarsToUsdDisplay(10_000_000_000)).toBe(10.0);
  });

  it("converts 0 to 0", () => {
    expect(nanodollarsToUsdDisplay(0)).toBe(0);
  });
});
