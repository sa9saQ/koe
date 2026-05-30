// Utility helpers for the settings feature.

const NANODOLLARS_PER_USD = 1_000_000_000;

/**
 * Converts nanodollars to a USD number for display only.
 * Arithmetic and comparisons must use the nanodollar integer value in Rust.
 */
export function nanodollarsToUsdDisplay(nanodollars: number): number {
  return nanodollars / NANODOLLARS_PER_USD;
}
