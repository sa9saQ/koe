// Settings store — holds the persisted AppSettings and exposes actions to
// load / complete onboarding / save budget.
//
// Design notes:
//  - On load failure (IPC error), settings stays `null` and `loadError` is set.
//    The OnboardingGate renders an error+retry state — it must NOT fall through
//    to the app, as that would bypass onboarding.
//  - `set((s) => ...)` pattern throughout (mirrors activityStore.ts).

import { create } from "zustand";

import {
  completeOnboarding as ipcCompleteOnboarding,
  getAppSettings,
  saveBudgetConfig as ipcSaveBudgetConfig,
} from "../../lib/tauri/ipc";
import type { AppSettings } from "./types";

interface SettingsState {
  /** null until load() completes, or if load failed. */
  settings: AppSettings | null;
  /** True once the first load() call resolves (success or failure). */
  loaded: boolean;
  /** Fixed error message when load() failed; null otherwise. */
  loadError: string | null;

  load: () => Promise<void>;
  completeOnboarding: (
    enabled: boolean,
    monthlyLimitUsd: number | null,
    recorderAdapter: string,
  ) => Promise<void>;
  saveBudget: (enabled: boolean, monthlyLimitUsd: number | null) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      const settings = await getAppSettings();
      set((s) => ({ ...s, settings, loaded: true, loadError: null }));
    } catch {
      // Do NOT fall back to a fabricated default — that would bypass the
      // onboarding gate and potentially skip the budget cap setup.
      set((s) => ({
        ...s,
        settings: null,
        loaded: true,
        loadError: "設定の読み込みに失敗しました。",
      }));
    }
  },

  completeOnboarding: async (enabled, monthlyLimitUsd, recorderAdapter) => {
    await ipcCompleteOnboarding(enabled, monthlyLimitUsd, recorderAdapter);
    // Reload to get the authoritative persisted state.
    const settings = await getAppSettings();
    set((s) => ({ ...s, settings }));
  },

  saveBudget: async (enabled, monthlyLimitUsd) => {
    await ipcSaveBudgetConfig(enabled, monthlyLimitUsd);
    const settings = await getAppSettings();
    set((s) => ({ ...s, settings }));
  },
}));
