import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppSettings = vi.fn();

// App mounts useActivityEvents (subscribes via ipc) and OnboardingGate (loads
// settings). Mock all ipc functions so no real Tauri runtime is required.
vi.mock("./lib/tauri/ipc", () => ({
  onToolEvent: vi.fn().mockResolvedValue(() => {}),
  onApprovalRequired: vi.fn().mockResolvedValue(() => {}),
  onSessionStatus: vi.fn().mockResolvedValue(() => {}),
  resolveToolApproval: vi.fn().mockResolvedValue(undefined),
  getAppSettings: (...args: unknown[]) => getAppSettings(...args),
  completeOnboarding: vi.fn().mockResolvedValue(undefined),
  saveBudgetConfig: vi.fn().mockResolvedValue(undefined),
  setRecorderAdapter: vi.fn().mockResolvedValue(undefined),
  setOpenaiApiKey: vi.fn().mockResolvedValue(undefined),
  hasOpenaiApiKey: vi.fn().mockResolvedValue(false),
  deleteOpenaiApiKey: vi.fn().mockResolvedValue(undefined),
}));

import { useSettingsStore } from "./features/settings/settingsStore";
import App from "./App";
import { onToolEvent } from "./lib/tauri/ipc";

beforeEach(() => {
  getAppSettings.mockReset();
  // Default: onboarding completed so the app renders the activity console.
  getAppSettings.mockResolvedValue({
    onboarding_completed: true,
    budget: { enabled: false, monthly_limit_nanodollars: 0 },
    recorder_adapter: "sqlite",
  });
  useSettingsStore.setState({ settings: null, loaded: false, loadError: null });
});

describe("App", () => {
  it("renders the activity console and wires up event subscriptions", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByText(/koe — activity/)).toBeInTheDocument();
    // ActivityLog renders with the default idle status.
    expect(screen.getByText("待機")).toBeInTheDocument();
    await waitFor(() => expect(onToolEvent).toHaveBeenCalled());
  });
});
