// Type-safe wrappers over Tauri's `invoke` / `listen`.
//
// Centralising the event-name and command-name strings here keeps the
// backend contract in one place and lets components subscribe without
// repeating channel names or casting `unknown` payloads.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  ApprovalDecision,
  ApprovalRequest,
  SessionStatusEvent,
  ToolEvent,
} from "../../features/activity/types";

/** Backend event channels. */
export const EVENT = {
  toolEvent: "tool-event",
  approvalRequired: "tool-approval-required",
  sessionStatus: "session-status",
} as const;

/** Backend command names. */
export const COMMAND = {
  resolveToolApproval: "resolve_tool_approval",
} as const;

/** Subscribe to live tool events. Returns an unlisten function. */
export function onToolEvent(handler: (event: ToolEvent) => void): Promise<UnlistenFn> {
  return listen<ToolEvent>(EVENT.toolEvent, (e) => handler(e.payload));
}

/** Subscribe to approval requests. Returns an unlisten function. */
export function onApprovalRequired(
  handler: (request: ApprovalRequest) => void,
): Promise<UnlistenFn> {
  return listen<ApprovalRequest>(EVENT.approvalRequired, (e) => handler(e.payload));
}

/** Subscribe to session connection-status changes. Returns an unlisten function. */
export function onSessionStatus(
  handler: (status: SessionStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionStatusEvent>(EVENT.sessionStatus, (e) => handler(e.payload));
}

/**
 * Resolve a pending approval. The backend routes the decision to the matching
 * oneshot by `approvalId`; unknown / timed-out / duplicate ids are rejected
 * backend-side (fail-closed).
 */
export function resolveToolApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  return invoke(COMMAND.resolveToolApproval, { approvalId, decision });
}
