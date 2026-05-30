// TDD stub — will be filled after implementation is in place.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppSettings = vi.fn();
const completeOnboarding = vi.fn();
const saveBudgetConfig = vi.fn();

vi.mock("../../lib/tauri/ipc", () => ({
  getAppSettings: (...args: unknown[]) => getAppSettings(...args),
  completeOnboarding: (...args: unknown[]) => completeOnboarding(...args),
  saveBudgetConfig: (...args: unknown[]) => saveBudgetConfig(...args),
  hasOpenaiApiKey: vi.fn(),
  setOpenaiApiKey: vi.fn(),
  deleteOpenaiApiKey: vi.fn(),
}));

import { useSettingsStore } from "./settingsStore";
import type { AppSettings } from "./types";

const defaultSettings: AppSettings = {
  onboarding_completed: false,
  budget: { enabled: false, monthly_limit_nanodollars: 0 },
  recorder_adapter: "sqlite",
};

const completedSettings: AppSettings = {
  onboarding_completed: true,
  budget: { enabled: true, monthly_limit_nanodollars: 10_000_000_000 },
  recorder_adapter: "sqlite",
};

beforeEach(() => {
  getAppSettings.mockReset();
  completeOnboarding.mockReset();
  saveBudgetConfig.mockReset();
  // Reset zustand store
  useSettingsStore.setState({
    settings: null,
    loaded: false,
    loadError: null,
  });
});

describe("settingsStore.load", () => {
  it("populates settings on success", async () => {
    getAppSettings.mockResolvedValue(defaultSettings);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toEqual(defaultSettings);
    expect(useSettingsStore.getState().loaded).toBe(true);
    expect(useSettingsStore.getState().loadError).toBeNull();
  });

  it("sets loadError and keeps settings null on failure", async () => {
    getAppSettings.mockRejectedValue(new Error("ipc failed"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toBeNull();
    expect(useSettingsStore.getState().loaded).toBe(true);
    expect(useSettingsStore.getState().loadError).toBeTruthy();
  });

  it("does not fabricate a default on failure (fail-closed)", async () => {
    getAppSettings.mockRejectedValue(new Error("ipc failed"));
    await useSettingsStore.getState().load();
    // settings must be null, not a fabricated default
    expect(useSettingsStore.getState().settings).toBeNull();
  });

  it("loadError is the fixed JP string and does not leak the raw error", async () => {
    getAppSettings.mockRejectedValue(new Error("secret/path/leaked details"));
    await useSettingsStore.getState().load();

    const { loadError, settings } = useSettingsStore.getState();
    // Gate must stay closed
    expect(settings).toBeNull();
    // Fixed JP message (not the raw error)
    expect(loadError).toBe("設定の読み込みに失敗しました。");
    expect(loadError).not.toContain("secret");
    expect(loadError).not.toContain("path");
  });
});

describe("settingsStore.completeOnboarding", () => {
  it("calls completeOnboarding IPC with correct args and reloads", async () => {
    completeOnboarding.mockResolvedValue(undefined);
    getAppSettings.mockResolvedValue(completedSettings);

    await useSettingsStore.getState().completeOnboarding(true, 10.0, "sqlite");

    expect(completeOnboarding).toHaveBeenCalledWith(true, 10.0, "sqlite");
    expect(useSettingsStore.getState().settings).toEqual(completedSettings);
  });

  it("propagates IPC errors (does not silently swallow)", async () => {
    completeOnboarding.mockRejectedValue(new Error("invalid budget amount"));
    await expect(
      useSettingsStore.getState().completeOnboarding(true, -1, "sqlite"),
    ).rejects.toThrow();
  });
});

describe("settingsStore.saveBudget", () => {
  it("calls saveBudgetConfig IPC and reloads", async () => {
    saveBudgetConfig.mockResolvedValue(undefined);
    const updated: AppSettings = {
      ...completedSettings,
      budget: { enabled: false, monthly_limit_nanodollars: 0 },
    };
    getAppSettings.mockResolvedValue(updated);

    await useSettingsStore.getState().saveBudget(false, null);

    expect(saveBudgetConfig).toHaveBeenCalledWith(false, null);
    expect(useSettingsStore.getState().settings?.budget.enabled).toBe(false);
  });
});
