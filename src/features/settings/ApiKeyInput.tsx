// API key input for BYOK. The key is never returned from the backend after save;
// this component only writes to it (set / has / delete).
//
// Safety contract:
//  - Input is cleared immediately after a successful save. The key must not
//    linger in React state or the DOM.
//  - Errors show a fixed JP message via role="alert". Raw backend errors (which
//    may carry paths / PII) are never surfaced to the user.

import { useRef, useState } from "react";

import { deleteOpenaiApiKey, hasOpenaiApiKey, setOpenaiApiKey } from "../../lib/tauri/ipc";

interface ApiKeyInputProps {
  /** Whether a key is currently stored in the vault (controlled from outside). */
  hasKey?: boolean;
  /** Called after a successful save or delete so the parent can re-check. */
  onKeyStatusChange?: (hasKey: boolean) => void;
}

export function ApiKeyInput({ hasKey = false, onKeyStatusChange }: ApiKeyInputProps) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightSave = useRef(false);
  const inFlightDelete = useRef(false);

  async function handleSave() {
    if (inFlightSave.current || !value.trim()) return;
    inFlightSave.current = true;
    setSaving(true);
    setError(null);
    try {
      await setOpenaiApiKey(value);
      // Clear the input immediately — the key must not linger in React state or DOM.
      setValue("");
      setShow(false);
      // Confirm presence via has (not by returning the key value).
      const confirmed = await hasOpenaiApiKey();
      onKeyStatusChange?.(confirmed);
    } catch {
      // Do NOT surface the raw backend error — it may carry a path / PII.
      setError("APIキーの保存に失敗しました。もう一度お試しください。");
    } finally {
      inFlightSave.current = false;
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (inFlightDelete.current) return;
    inFlightDelete.current = true;
    setDeleting(true);
    setError(null);
    try {
      await deleteOpenaiApiKey();
      onKeyStatusChange?.(false);
    } catch {
      setError("APIキーの削除に失敗しました。もう一度お試しください。");
    } finally {
      inFlightDelete.current = false;
      setDeleting(false);
    }
  }

  return (
    <div className="koe-api-key-input">
      <label htmlFor="koe-api-key-field" className="koe-label">
        OpenAI APIキー
      </label>

      {hasKey && (
        <p className="koe-api-key-status">
          ✓ APIキーが保存されています
        </p>
      )}

      <div className="koe-api-key-row">
        <input
          id="koe-api-key-field"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          disabled={saving}
          className="koe-input"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "非表示" : "表示"}
          disabled={saving}
          className="koe-btn koe-btn-icon"
        >
          {show ? "非表示" : "表示"}
        </button>
      </div>

      {error && (
        <p className="koe-api-key-error" role="alert">
          {error}
        </p>
      )}

      <div className="koe-api-key-actions">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !value.trim()}
          className="koe-btn koe-btn-primary"
        >
          {saving ? "保存中…" : "保存"}
        </button>

        {hasKey && (
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="koe-btn koe-btn-danger"
            aria-label="削除"
          >
            {deleting ? "削除中…" : "削除"}
          </button>
        )}
      </div>
    </div>
  );
}
