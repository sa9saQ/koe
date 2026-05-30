// Settings feature — TypeScript contract for the Rust settings_store types.
//
// Rust uses plain `#[derive(Serialize, Deserialize)]` with no serde rename
// attributes, so all field names are serialised as-is (snake_case) over the
// Tauri IPC bridge. The TypeScript types below use the exact keys that the
// backend emits.

/**
 * Budget configuration. Mirrors `cost_tracker::BudgetConfig` (Rust).
 * - `enabled = false` → explicit unlimited (user's deliberate choice).
 * - `enabled = true` → hard cap at `monthly_limit_nanodollars`.
 */
export interface BudgetConfig {
  enabled: boolean;
  /** Limit in nanodollars (1 USD = 1,000,000,000). Arithmetic is done in Rust. */
  monthly_limit_nanodollars: number;
}

/**
 * Application settings. Mirrors `settings_store::AppSettings` (Rust).
 * All field names are snake_case to match the JSON the backend emits.
 */
export interface AppSettings {
  onboarding_completed: boolean;
  budget: BudgetConfig;
  /** Recorder adapter name. M1 only supports `"sqlite"`. */
  recorder_adapter: string;
}

/**
 * The UI-side choice the user makes during onboarding.
 * Kept separate from `BudgetConfig` so the form can represent the
 * "not yet chosen" state (neither enabled nor explicitly unlimited).
 */
export type BudgetChoice =
  | { kind: "limited"; monthlyLimitUsd: number }
  | { kind: "unlimited" }
  | { kind: "pending" };
