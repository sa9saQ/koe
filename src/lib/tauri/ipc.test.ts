import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri API surface so the wrappers can be exercised without a runtime.
const listen = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  COMMAND,
  EVENT,
  onApprovalRequired,
  onSessionStatus,
  onToolEvent,
  resolveToolApproval,
} from "./ipc";
import type { ApprovalRequest, SessionStatusEvent, ToolEvent } from "../../features/activity/types";

beforeEach(() => {
  listen.mockReset();
  invoke.mockReset();
  listen.mockResolvedValue(() => {});
  invoke.mockResolvedValue(undefined);
});

describe("ipc event subscriptions", () => {
  it("onToolEvent listens on the tool-event channel and unwraps the payload", async () => {
    let captured: ToolEvent | undefined;
    await onToolEvent((e) => {
      captured = e;
    });
    expect(listen).toHaveBeenCalledTimes(1);
    const [channel, cb] = listen.mock.calls[0] as [string, (e: { payload: ToolEvent }) => void];
    expect(channel).toBe(EVENT.toolEvent);

    const payload = { eventId: "e1" } as ToolEvent;
    cb({ payload });
    expect(captured).toBe(payload);
  });

  it("onApprovalRequired listens on the tool-approval-required channel", async () => {
    let captured: ApprovalRequest | undefined;
    await onApprovalRequired((r) => {
      captured = r;
    });
    const [channel, cb] = listen.mock.calls[0] as [
      string,
      (e: { payload: ApprovalRequest }) => void,
    ];
    expect(channel).toBe(EVENT.approvalRequired);
    const payload = { approvalId: "a1" } as ApprovalRequest;
    cb({ payload });
    expect(captured).toBe(payload);
  });

  it("onSessionStatus listens on the session-status channel", async () => {
    await onSessionStatus(() => {});
    expect(listen.mock.calls[0]?.[0]).toBe(EVENT.sessionStatus);
  });

  it("forwards the unlisten function from listen", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const result = await onSessionStatus(() => {});
    expect(result).toBe(unlisten);
  });
});

describe("resolveToolApproval", () => {
  it("invokes resolve_tool_approval with approvalId + decision", async () => {
    await resolveToolApproval("abc-123", "approve");
    expect(invoke).toHaveBeenCalledWith(COMMAND.resolveToolApproval, {
      approvalId: "abc-123",
      decision: "approve",
    });
  });

  it("passes the deny decision through unchanged", async () => {
    await resolveToolApproval("xyz", "deny");
    expect(invoke).toHaveBeenCalledWith(COMMAND.resolveToolApproval, {
      approvalId: "xyz",
      decision: "deny",
    });
  });
});

// Guard the SessionStatusEvent shape is referenced (compile-time contract).
const _shape: SessionStatusEvent = { state: "idle", sequence: 0 };
void _shape;
