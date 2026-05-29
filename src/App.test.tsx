import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// App mounts useActivityEvents, which subscribes via ipc. Mock the channel
// wrappers so no real Tauri runtime is required.
vi.mock("./lib/tauri/ipc", () => ({
  onToolEvent: vi.fn().mockResolvedValue(() => {}),
  onApprovalRequired: vi.fn().mockResolvedValue(() => {}),
  onSessionStatus: vi.fn().mockResolvedValue(() => {}),
  resolveToolApproval: vi.fn().mockResolvedValue(undefined),
}));

import App from "./App";
import { onToolEvent } from "./lib/tauri/ipc";

describe("App", () => {
  it("renders the activity console and wires up event subscriptions", async () => {
    render(<App />);
    expect(screen.getByText(/koe — activity/)).toBeInTheDocument();
    // ActivityLog renders with the default idle status.
    expect(screen.getByText("待機")).toBeInTheDocument();
    await waitFor(() => expect(onToolEvent).toHaveBeenCalled());
  });
});
