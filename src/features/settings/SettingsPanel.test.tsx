// TDD tests for SettingsPanel component.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppSettings = vi.fn();
const saveBudgetConfig = vi.fn();
const setOpenaiApiKey = vi.fn();
const hasOpenaiApiKey = vi.fn();
const deleteOpenaiApiKey = vi.fn();

vi.mock("../../lib/tauri/ipc", () => ({
  getAppSettings: (...args: unknown[]) => getAppSettings(...args),
  saveBudgetConfig: (...args: unknown[]) => saveBudgetConfig(...args),
  setOpenaiApiKey: (...args: unknown[]) => setOpenaiApiKey(...args),
  hasOpenaiApiKey: (...args: unknown[]) => hasOpenaiApiKey(...args),
  deleteOpenaiApiKey: (...args: unknown[]) => deleteOpenaiApiKey(...args),
  completeOnboarding: vi.fn(),
  setRecorderAdapter: vi.fn(),
}));

import { useSettingsStore } from "./settingsStore";
import { SettingsPanel } from "./SettingsPanel";

const completedSettings = {
  onboarding_completed: true,
  budget: { enabled: true, monthly_limit_nanodollars: 10_000_000_000 },
  recorder_adapter: "sqlite",
};

beforeEach(() => {
  getAppSettings.mockReset();
  saveBudgetConfig.mockReset();
  setOpenaiApiKey.mockReset();
  hasOpenaiApiKey.mockReset();
  deleteOpenaiApiKey.mockReset();
  getAppSettings.mockResolvedValue(completedSettings);
  saveBudgetConfig.mockResolvedValue(undefined);
  setOpenaiApiKey.mockResolvedValue(undefined);
  hasOpenaiApiKey.mockResolvedValue(true);
  deleteOpenaiApiKey.mockResolvedValue(undefined);
  useSettingsStore.setState({
    settings: completedSettings,
    loaded: true,
    loadError: null,
  });
});

describe("SettingsPanel", () => {
  it("renders without crashing when settings are loaded", () => {
    render(<SettingsPanel />);
    // Panel heading visible
    expect(screen.getByRole("region", { name: "設定" })).toBeInTheDocument();
  });

  it("shows the ApiKeyInput component", () => {
    render(<SettingsPanel />);
    expect(document.querySelector("input")).not.toBeNull();
  });

  it("allows closing the panel via onClose callback", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: /閉じる|close/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });
    expect(onClose).toHaveBeenCalled();
  });
});
