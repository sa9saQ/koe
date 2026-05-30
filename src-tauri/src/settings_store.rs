//! App settings persistence — Rust-owned JSON at `app_local_data_dir/koe-settings.json`.
//!
//! # Design
//! - Settings are stored as JSON in the per-user app data dir. No WebView SQL
//!   or plugin surface exists (same posture as `secret_store.rs` / `adapter.rs`).
//! - [`SettingsError`]'s `Display` returns **fixed** strings; no path, value, or
//!   OS detail can leak to the WebView (mirrors `RecorderError` / `SecretError`).
//! - `load` when the file is absent → [`AppSettings::default()`] (first run).
//! - `load` when the file is present but corrupt → **Err (fail-closed)**.
//!   Silently resetting to default would erase a user's budget cap.
//! - `save` is **atomic**: write to `<path>.tmp`, then `fs::rename` over the
//!   target (rename is atomic on the same filesystem; partial writes never replace
//!   the live file).
//!
//! transaction N/A · idempotency_key N/A (local settings file, not billing)

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::cost_tracker::{usd_to_nanodollars, BudgetConfig};
use crate::secret_store::{ManagedSecretStore, OPENAI_KEY_NAME};

// ---------------------------------------------------------------------------
// AppSettings
// ---------------------------------------------------------------------------

/// Persisted application settings. Serialised as JSON to
/// `app_local_data_dir/koe-settings.json` via [`JsonSettingsStore`].
///
/// Non-safety fields carry serde defaults (so a future-added field does not fail
/// an older file), but [`budget`](AppSettings::budget) is **required** — it is a
/// safety control, and silently defaulting a missing `budget` to "unlimited"
/// would erase a user's cap. A file missing `budget` therefore fails to
/// deserialise → [`SettingsError::Corrupt`] (fail-closed), not a silent reset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSettings {
    /// Whether the user has completed first-run onboarding (budget choice +
    /// API key entry). The UI gate blocks the activity console until this is
    /// `true`. Backend enforcement is `session_manager`'s responsibility
    /// (koe-e3m — deliberate seam, not skeleton). Defaults to `false`
    /// (fail-closed: a missing flag means "not onboarded").
    #[serde(default)]
    pub onboarding_completed: bool,

    /// Budget configuration. `enabled = false` means the user explicitly chose
    /// unlimited; `true` with a non-zero limit means a hard cap is active.
    /// **Required** (no serde default) — see the type doc above.
    pub budget: BudgetConfig,

    /// Which recorder backend to use. M1 only supports `"sqlite"`.
    #[serde(default = "default_recorder_adapter")]
    pub recorder_adapter: String,
}

fn default_recorder_adapter() -> String {
    "sqlite".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            onboarding_completed: false,
            budget: BudgetConfig::default(),
            recorder_adapter: default_recorder_adapter(),
        }
    }
}

// ---------------------------------------------------------------------------
// Errors — fixed messages only, never echo the underlying cause.
// ---------------------------------------------------------------------------

/// Error returned by the settings store. `Display` returns a **fixed** message
/// per variant so no path, JSON detail, or OS error leaks to the WebView.
#[derive(Debug, PartialEq, Eq)]
pub enum SettingsError {
    /// The data directory is unavailable (permissions, out-of-space, …).
    Unavailable,
    /// The settings file exists but its contents cannot be deserialised (corrupt
    /// or incompatible format). **Fail-closed** — callers must not silently
    /// fall back to defaults, as that would erase a budget cap.
    Corrupt,
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            SettingsError::Unavailable => "settings storage is unavailable",
            SettingsError::Corrupt => "settings file is corrupt",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for SettingsError {}

// ---------------------------------------------------------------------------
// SettingsStore trait
// ---------------------------------------------------------------------------

/// Abstraction over the settings backend. M1 uses [`JsonSettingsStore`].
pub trait SettingsStore: Send + Sync {
    fn load(&self) -> Result<AppSettings, SettingsError>;
    fn save(&self, settings: &AppSettings) -> Result<(), SettingsError>;
}

// ---------------------------------------------------------------------------
// JsonSettingsStore — the real M1 implementation.
// ---------------------------------------------------------------------------

/// Persists settings as a JSON file at `path`. Saves write a `.tmp` sibling then
/// `rename` over the target — an atomic swap on the same filesystem, so a
/// **process** crash mid-save never leaves a partially-written live file.
///
/// NOTE: this is not full power-loss durability — there is no `fsync` of the
/// temp file or the parent directory, so a power cut could still lose the most
/// recent write. Acceptable for M1 settings (low-write, user-recoverable);
/// fsync + a save mutex are a tracked follow-up.
pub struct JsonSettingsStore {
    pub path: PathBuf,
}

impl JsonSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SettingsStore for JsonSettingsStore {
    fn load(&self) -> Result<AppSettings, SettingsError> {
        if !self.path.exists() {
            return Ok(AppSettings::default());
        }
        let bytes = std::fs::read(&self.path).map_err(|_| SettingsError::Unavailable)?;
        let settings: AppSettings =
            serde_json::from_slice(&bytes).map_err(|_| SettingsError::Corrupt)?;
        // A valid-JSON-but-out-of-range file (hand-edited / tampered, e.g. a huge
        // monthly_limit_nanodollars or enabled=false with a non-zero limit) must
        // fail closed on the READ path too — the save-path bound alone would let
        // such a file load with an effectively-unlimited cap and pass the gate.
        validate_app_settings(&settings)?;
        Ok(settings)
    }

    fn save(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        // Create parent directory if needed (first run before the data dir exists).
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| SettingsError::Unavailable)?;
        }

        let tmp_path = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(settings).map_err(|_| SettingsError::Unavailable)?;

        // Write to the temp file first.
        std::fs::write(&tmp_path, &json).map_err(|_| SettingsError::Unavailable)?;

        // Atomic rename: on the same filesystem this is crash-safe.
        std::fs::rename(&tmp_path, &self.path).map_err(|_| SettingsError::Unavailable)?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Managed state + Tauri commands (WebView surface).
// ---------------------------------------------------------------------------

/// Tauri managed-state wrapper around the active [`SettingsStore`].
///
/// M1: single-writer UI; compound load-modify-write in the settings commands
/// is not lock-guarded — the UI serialises saves and `set_recorder_adapter` has
/// no concurrent caller. Revisit if concurrent settings writers are added.
pub struct ManagedSettings(pub Arc<dyn SettingsStore>);

/// Returns the current app settings. Contains **no** secret values; safe for
/// the WebView.
#[tauri::command]
pub async fn get_app_settings(
    settings: tauri::State<'_, ManagedSettings>,
) -> Result<AppSettings, String> {
    settings.0.load().map_err(|e| e.to_string())
}

/// Called once during first-run onboarding. Persists the budget choice (a hard
/// cap **or** explicit unlimited) together with the chosen recorder adapter, and
/// flips `onboarding_completed` to `true`.
///
/// Validation:
/// - A BYOK key must already be stored (`has_api_key`) — onboarding is only
///   "complete" with a key, so neither the UI flow nor a direct IPC call can
///   leave the console reachable keyless. (Deleting the key *after* onboarding
///   is handled by the session-start gate in koe-e3m.)
/// - `recorder_adapter` must be `"sqlite"` (M1 only).
/// - If `enabled`, `monthly_limit_usd` must be `Some`, `> 0`, and `<= 1_000_000`.
/// - If `!enabled` (explicit unlimited), the limit is stored as `0`.
#[tauri::command]
pub async fn complete_onboarding(
    enabled: bool,
    monthly_limit_usd: Option<f64>,
    recorder_adapter: String,
    settings: tauri::State<'_, ManagedSettings>,
    secret: tauri::State<'_, ManagedSecretStore>,
) -> Result<(), String> {
    validate_recorder_adapter(&recorder_adapter)?;

    // Fail-closed: an Err (locked / corrupt vault) is treated as "no key",
    // never as "key present".
    if !secret
        .0
        .has_api_key(OPENAI_KEY_NAME)
        .map_err(|e| e.to_string())?
    {
        return Err("an API key must be stored before completing onboarding".to_string());
    }

    let budget = build_budget_config(enabled, monthly_limit_usd)?;

    let new_settings = AppSettings {
        onboarding_completed: true,
        budget,
        recorder_adapter,
    };

    settings.0.save(&new_settings).map_err(|e| e.to_string())
}

/// Updates the budget configuration after onboarding. Preserves the existing
/// `onboarding_completed` and `recorder_adapter` values.
#[tauri::command]
pub async fn save_budget_config(
    enabled: bool,
    monthly_limit_usd: Option<f64>,
    settings: tauri::State<'_, ManagedSettings>,
) -> Result<(), String> {
    let budget = build_budget_config(enabled, monthly_limit_usd)?;

    let mut current = settings.0.load().map_err(|e| e.to_string())?;
    current.budget = budget;
    settings.0.save(&current).map_err(|e| e.to_string())
}

/// Updates the recorder adapter. M1 only accepts `"sqlite"`.
#[tauri::command]
pub async fn set_recorder_adapter(
    name: String,
    settings: tauri::State<'_, ManagedSettings>,
) -> Result<(), String> {
    validate_recorder_adapter(&name)?;

    let mut current = settings.0.load().map_err(|e| e.to_string())?;
    current.recorder_adapter = name;
    settings.0.save(&current).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn validate_recorder_adapter(name: &str) -> Result<(), String> {
    if name == "sqlite" {
        Ok(())
    } else {
        Err("unsupported recorder adapter".into())
    }
}

/// Authoritative upper bound on an enabled monthly cap (USD). The UI also caps
/// input, but a direct IPC call must not be able to persist a near-unlimited
/// "limited" budget (e.g. 1e10 USD), so the Rust side is the source of truth.
const MAX_MONTHLY_LIMIT_USD: f64 = 1_000_000.0;

/// The same ceiling expressed in nanodollars, for validating a *loaded* budget
/// (which is already stored as integer nanodollars). 1_000_000 USD * 1e9 = 1e15,
/// well within u64.
const MAX_MONTHLY_LIMIT_NANODOLLARS: u64 = 1_000_000 * crate::cost_tracker::NANODOLLARS_PER_USD;

/// Validates a deserialized [`AppSettings`] against the SAME invariants the write
/// path enforces, so a hand-edited / tampered file (valid JSON, out-of-range
/// values) fails closed on load rather than silently disabling or inflating the
/// budget safety control:
/// - `recorder_adapter` must be the only M1-supported backend (`"sqlite"`).
/// - an **enabled** budget must have `0 < limit <= MAX_MONTHLY_LIMIT_NANODOLLARS`.
/// - a **disabled** (explicit-unlimited) budget must have a zero limit.
fn validate_app_settings(s: &AppSettings) -> Result<(), SettingsError> {
    if s.recorder_adapter != "sqlite" {
        return Err(SettingsError::Corrupt);
    }
    if s.budget.enabled {
        let n = s.budget.monthly_limit_nanodollars;
        if !(n > 0 && n <= MAX_MONTHLY_LIMIT_NANODOLLARS) {
            return Err(SettingsError::Corrupt);
        }
    } else if s.budget.monthly_limit_nanodollars != 0 {
        return Err(SettingsError::Corrupt);
    }
    Ok(())
}

fn build_budget_config(enabled: bool, monthly_limit_usd: Option<f64>) -> Result<BudgetConfig, String> {
    let monthly_limit_nanodollars = if enabled {
        let usd = monthly_limit_usd.ok_or("invalid budget amount")?;
        // One check rejects NaN (any comparison with NaN is false), <= 0, Inf,
        // and anything above the authoritative ceiling.
        if !(usd > 0.0 && usd <= MAX_MONTHLY_LIMIT_USD) {
            return Err("invalid budget amount".to_string());
        }
        usd_to_nanodollars(usd).ok_or("invalid budget amount")?
    } else {
        0
    };
    Ok(BudgetConfig {
        enabled,
        monthly_limit_nanodollars,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (JsonSettingsStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("koe-settings.json");
        (JsonSettingsStore::new(path), dir)
    }

    // ---- SettingsError fixed messages -------------------------------------

    #[test]
    fn settings_error_messages_are_fixed_and_leak_free() {
        for e in [SettingsError::Unavailable, SettingsError::Corrupt] {
            let msg = e.to_string();
            // No path separators
            assert!(!msg.contains('/'), "message contains '/': {msg}");
            assert!(!msg.contains('\\'), "message contains '\\': {msg}");
            // No digits that could carry specifics
            assert!(
                !msg.chars().any(|c| c.is_ascii_digit()),
                "message contains a digit: {msg}"
            );
        }
        assert_eq!(
            SettingsError::Unavailable.to_string(),
            "settings storage is unavailable"
        );
        assert_eq!(SettingsError::Corrupt.to_string(), "settings file is corrupt");
    }

    #[test]
    fn settings_error_is_std_error() {
        let _boxed: Box<dyn std::error::Error> = Box::new(SettingsError::Unavailable);
        let _as_ref: &dyn std::error::Error = &SettingsError::Corrupt;
    }

    // ---- Default ----------------------------------------------------------

    #[test]
    fn default_settings_are_sane() {
        let s = AppSettings::default();
        assert!(!s.onboarding_completed);
        assert!(!s.budget.enabled);
        assert_eq!(s.budget.monthly_limit_nanodollars, 0);
        assert_eq!(s.recorder_adapter, "sqlite");
    }

    // ---- Load absent → default --------------------------------------------

    #[test]
    fn load_absent_returns_default() {
        let (store, _dir) = temp_store();
        let settings = store.load().expect("load absent");
        assert_eq!(settings, AppSettings::default());
    }

    // ---- Save → load round-trip -------------------------------------------

    #[test]
    fn save_load_round_trips() {
        let (store, _dir) = temp_store();
        let original = AppSettings {
            onboarding_completed: true,
            budget: BudgetConfig {
                enabled: true,
                monthly_limit_nanodollars: 50_000_000_000,
            },
            recorder_adapter: "sqlite".into(),
        };
        store.save(&original).expect("save");
        let loaded = store.load().expect("load");
        assert_eq!(loaded, original);
    }

    // ---- Corrupt JSON → Err (fail-closed) ---------------------------------

    #[test]
    fn corrupt_json_returns_err_not_default() {
        let (store, _dir) = temp_store();
        // Write syntactically invalid JSON.
        std::fs::write(&store.path, b"not json at all {{{ broken").expect("seed corrupt file");
        match store.load() {
            Err(SettingsError::Corrupt) => {} // correct
            other => panic!("expected Err(Corrupt), got {other:?}"),
        }
    }

    #[test]
    fn wrong_type_json_returns_corrupt_not_default() {
        // Syntactically valid JSON but with wrong types for the fields.
        // serde_json rejects type mismatches → must return Err(Corrupt),
        // never silently fall back to Default (which would erase a budget cap).
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed": "yes", "budget": 5, "recorder_adapter": true}"#,
        )
        .expect("seed wrong-type file");
        match store.load() {
            Err(SettingsError::Corrupt) => {} // correct
            other => panic!("expected Err(Corrupt) for wrong-type JSON, got {other:?}"),
        }
    }

    #[test]
    fn missing_budget_field_returns_corrupt_not_unlimited() {
        // `budget` is a safety control with NO serde default: a file that omits
        // it (manual edit / tamper / bad migration) must fail closed, NOT load as
        // a silent "unlimited" budget that still passes the onboarding gate.
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed": true, "recorder_adapter": "sqlite"}"#,
        )
        .expect("seed budget-less file");
        match store.load() {
            Err(SettingsError::Corrupt) => {} // correct: missing budget → fail-closed
            other => panic!("expected Err(Corrupt) for a file missing budget, got {other:?}"),
        }
    }

    // ---- Load-path semantic validation (tampered but valid-JSON files) ----

    #[test]
    fn load_rejects_out_of_range_enabled_budget() {
        // enabled=true with a u64::MAX limit (hand-edited) must fail closed — the
        // save-path bound alone would let this load as a near-unlimited cap.
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed":true,"budget":{"enabled":true,"monthly_limit_nanodollars":18446744073709551615},"recorder_adapter":"sqlite"}"#,
        )
        .expect("seed");
        assert!(matches!(store.load(), Err(SettingsError::Corrupt)));
    }

    #[test]
    fn load_rejects_disabled_budget_with_nonzero_limit() {
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed":true,"budget":{"enabled":false,"monthly_limit_nanodollars":999},"recorder_adapter":"sqlite"}"#,
        )
        .expect("seed");
        assert!(matches!(store.load(), Err(SettingsError::Corrupt)));
    }

    #[test]
    fn load_rejects_unknown_recorder_adapter() {
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed":true,"budget":{"enabled":false,"monthly_limit_nanodollars":0},"recorder_adapter":"obsidian"}"#,
        )
        .expect("seed");
        assert!(matches!(store.load(), Err(SettingsError::Corrupt)));
    }

    #[test]
    fn load_accepts_in_range_enabled_budget() {
        // $500 = 500e9 nano, enabled, sqlite → within bounds, loads fine.
        let (store, _dir) = temp_store();
        std::fs::write(
            &store.path,
            br#"{"onboarding_completed":true,"budget":{"enabled":true,"monthly_limit_nanodollars":500000000000},"recorder_adapter":"sqlite"}"#,
        )
        .expect("seed");
        let s = store.load().expect("valid in-range file loads");
        assert!(s.budget.enabled && s.onboarding_completed);
    }

    // ---- Atomic write leaves no partial file ------------------------------

    #[test]
    fn atomic_save_no_tmp_file_remains() {
        let (store, _dir) = temp_store();
        let settings = AppSettings::default();
        store.save(&settings).expect("save");

        // After a successful save, the .tmp sibling must not exist.
        let tmp = store.path.with_extension("json.tmp");
        assert!(
            !tmp.exists(),
            "tmp file should be renamed away after atomic save"
        );

        // The real file must exist.
        assert!(store.path.exists(), "settings file should exist after save");
    }

    // ---- Budget validation (build_budget_config) --------------------------

    #[test]
    fn budget_enabled_with_valid_usd_stores_nanodollars() {
        let config = build_budget_config(true, Some(10.0)).expect("valid");
        assert!(config.enabled);
        assert_eq!(config.monthly_limit_nanodollars, 10 * crate::cost_tracker::NANODOLLARS_PER_USD);
    }

    #[test]
    fn budget_enabled_none_usd_is_err() {
        assert!(build_budget_config(true, None).is_err());
    }

    #[test]
    fn budget_enabled_nan_is_err() {
        assert!(build_budget_config(true, Some(f64::NAN)).is_err());
    }

    #[test]
    fn budget_enabled_negative_is_err() {
        assert!(build_budget_config(true, Some(-1.0)).is_err());
    }

    #[test]
    fn budget_enabled_overflow_is_err() {
        assert!(build_budget_config(true, Some(1.0e30)).is_err());
    }

    #[test]
    fn budget_enabled_above_max_is_err() {
        // The Rust ceiling is authoritative — a direct IPC bypassing the UI's
        // <=1_000_000 guard must still be rejected.
        assert!(build_budget_config(true, Some(MAX_MONTHLY_LIMIT_USD + 1.0)).is_err());
        assert!(build_budget_config(true, Some(1.0e10)).is_err());
        // The boundary value itself is accepted.
        assert!(build_budget_config(true, Some(MAX_MONTHLY_LIMIT_USD)).is_ok());
    }

    #[test]
    fn budget_enabled_zero_or_negative_is_err() {
        // An enabled cap of 0 is degenerate (blocks everything immediately) and
        // is rejected; the UI requires > 0 too.
        assert!(build_budget_config(true, Some(0.0)).is_err());
        assert!(build_budget_config(true, Some(-5.0)).is_err());
    }

    #[test]
    fn budget_disabled_stores_unlimited() {
        let config = build_budget_config(false, None).expect("disabled unlimited");
        assert!(!config.enabled);
        assert_eq!(config.monthly_limit_nanodollars, 0);
    }

    #[test]
    fn budget_disabled_ignores_usd_value() {
        // When !enabled, the USD value is ignored (not validated).
        let config = build_budget_config(false, Some(99.0)).expect("disabled with value ignored");
        assert!(!config.enabled);
    }

    // ---- Adapter validation -----------------------------------------------

    #[test]
    fn validate_sqlite_adapter_ok() {
        assert!(validate_recorder_adapter("sqlite").is_ok());
    }

    #[test]
    fn validate_unknown_adapter_err() {
        assert!(validate_recorder_adapter("obsidian").is_err());
        assert!(validate_recorder_adapter("").is_err());
    }

    // ---- Structural guard: settings commands are registered in lib.rs ------

    fn lib_rs_code_only() -> String {
        include_str!("lib.rs")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn lib_rs_registers_settings_commands() {
        let code = lib_rs_code_only();
        for cmd in [
            "get_app_settings",
            "complete_onboarding",
            "save_budget_config",
            "set_recorder_adapter",
        ] {
            assert!(
                code.contains(cmd),
                "lib.rs must register command '{cmd}' in invoke_handler"
            );
        }
    }

    #[test]
    fn lib_rs_does_not_contain_greet() {
        let code = lib_rs_code_only();
        assert!(
            !code.contains("greet"),
            "greet scaffold command must be removed from lib.rs"
        );
    }
}
