// Post-onboarding settings panel. Allows re-editing budget and re-entering
// or clearing the API key.

import { useEffect, useRef, useState } from "react";

import { hasOpenaiApiKey } from "../../lib/tauri/ipc";
import { useSettingsStore } from "./settingsStore";
import { ApiKeyInput } from "./ApiKeyInput";
import { nanodollarsToUsdDisplay } from "./utils";

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { settings, saveBudget } = useSettingsStore();
  const [hasKey, setHasKey] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [newLimitStr, setNewLimitStr] = useState(
    settings?.budget.enabled
      ? String(nanodollarsToUsdDisplay(settings.budget.monthly_limit_nanodollars))
      : "",
  );
  const [budgetEnabled, setBudgetEnabled] = useState(settings?.budget.enabled ?? false);
  // Re-entrancy guard: prevents double-submit if the button state lags a render.
  const inFlightBudget = useRef(false);

  // Check the real stored-key state on open so the delete button / "✓ saved"
  // indicator reflects the vault (not just what was saved in this session).
  useEffect(() => {
    void hasOpenaiApiKey()
      .then(setHasKey)
      .catch(() => {
        /* best-effort; failure just leaves the indicator absent */
      });
  }, []);

  async function handleSaveBudget() {
    if (inFlightBudget.current || savingBudget) return;
    inFlightBudget.current = true;
    setSavingBudget(true);
    setBudgetError(null);
    try {
      const limit = budgetEnabled ? parseFloat(newLimitStr) : null;
      if (budgetEnabled && (!isFinite(limit!) || limit! <= 0 || limit! > 1_000_000)) {
        setBudgetError("有効な金額を入力してください（0〜1,000,000 USD）。");
        return;
      }
      await saveBudget(budgetEnabled, limit);
    } catch {
      setBudgetError("予算の保存に失敗しました。もう一度お試しください。");
    } finally {
      inFlightBudget.current = false;
      setSavingBudget(false);
    }
  }

  return (
    <div className="koe-settings-panel" role="region" aria-label="設定">
      <div className="koe-settings-header">
        <h2 className="koe-settings-title">設定</h2>
        <button
          type="button"
          onClick={onClose}
          className="koe-btn koe-btn-icon"
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>

      <section className="koe-settings-section">
        <h3>APIキー</h3>
        <ApiKeyInput hasKey={hasKey} onKeyStatusChange={setHasKey} />
      </section>

      <section className="koe-settings-section">
        <h3>月次予算</h3>

        <label className="koe-budget-option">
          <input
            type="checkbox"
            checked={budgetEnabled}
            onChange={(e) => setBudgetEnabled(e.target.checked)}
            disabled={savingBudget}
          />
          <span>上限を有効にする</span>
        </label>

        {budgetEnabled && (
          <div className="koe-budget-amount">
            <label htmlFor="koe-settings-budget-input">月額上限（USD）</label>
            <input
              id="koe-settings-budget-input"
              type="number"
              min="0.01"
              max="1000000"
              step="0.01"
              value={newLimitStr}
              onChange={(e) => setNewLimitStr(e.target.value)}
              disabled={savingBudget}
              className="koe-input"
            />
          </div>
        )}

        {budgetError && (
          <p role="alert" className="koe-settings-error">
            {budgetError}
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleSaveBudget()}
          disabled={savingBudget}
          className="koe-btn koe-btn-primary"
        >
          {savingBudget ? "保存中…" : "予算を保存"}
        </button>
      </section>
    </div>
  );
}
