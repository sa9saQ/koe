// Activity store — folds the backend's `tool-event` / `tool-approval-required`
// / `session-status` streams into the state the operator console renders.
//
// Design notes (Codex R-A/R-B + workflow review):
//  - De-duplicate by `eventId` (NOT by `sequence`), so a late `done` that
//    carries a lower sequence than some unrelated later event is still applied
//    and the LIVE indicator clears.
//  - Order the visible log by `sequence`.
//  - Fold per-`actionId`, guarding each action against *stale* updates with its
//    own `lastSequence` (a single action's events are monotonic), so an
//    out-of-order older event cannot resurrect a finished action.
//  - koe runs continuously, so the dedup set and the action map are bounded to
//    the retained-event window — they must not grow without limit.

import { create } from "zustand";

import type {
  ActionState,
  ApprovalRequest,
  DisplayStatus,
  SessionConnState,
  SessionStatusEvent,
  ToolEvent,
} from "./types";

/** Max number of tool events retained in the visible log. */
export const EVENT_CAP = 100;

/**
 * Hard cap on the action map. Completed actions prune out via the event window,
 * but *active* ones are kept even off-window — so a broken/malicious backend
 * that emits `start` without ever sending `done`/`error` could grow the map
 * without limit. This cap evicts the oldest actions as a backstop. Set well
 * above any realistic concurrent-tool count.
 */
export const MAX_ACTIONS = 256;

interface ActivityState {
  connState: SessionConnState;
  /** Sticky error message; cleared when a *newer* non-error status arrives. */
  lastError: string | null;
  /** Visible log, ordered ascending by `sequence`, capped at {@link EVENT_CAP}. */
  events: ToolEvent[];
  /** De-duplication set of seen `eventId`s, bounded to the retained window. */
  seenEventIds: Set<string>;
  /** Live/recent actions keyed by `actionId` (completed ones prune out). */
  actions: Map<string, ActionState>;
  /** Pending approvals, FIFO. The head is the one shown in the modal. */
  approvalQueue: ApprovalRequest[];
  /** Highest `sequence` seen across all tool events. */
  lastSequence: number;
  /** Highest `sequence` seen across session-status events (own counter space). */
  lastSessionSequence: number;

  ingestToolEvent: (event: ToolEvent) => void;
  setSessionStatus: (status: SessionStatusEvent) => void;
  enqueueApproval: (request: ApprovalRequest) => void;
  dequeueApproval: (approvalId: string) => void;
  reset: () => void;
}

function isActivePhase(phase: ActionState["phase"]): boolean {
  return phase === "start" || phase === "progress";
}

function isTerminalPhase(phase: ActionState["phase"]): boolean {
  return phase === "done" || phase === "error";
}

function initialState() {
  return {
    connState: "idle" as SessionConnState,
    lastError: null,
    events: [] as ToolEvent[],
    seenEventIds: new Set<string>(),
    actions: new Map<string, ActionState>(),
    approvalQueue: [] as ApprovalRequest[],
    lastSequence: 0,
    // -1 so a backend whose status sequence starts at 0 is not ignored.
    lastSessionSequence: -1,
  };
}

export const useActivityStore = create<ActivityState>((set) => ({
  ...initialState(),

  ingestToolEvent: (event) =>
    set((state) => {
      if (state.seenEventIds.has(event.eventId)) {
        return state; // duplicate — ignore
      }

      // Insert into the log keeping ascending `sequence` order, then cap.
      const events = [...state.events, event].sort((a, b) => a.sequence - b.sequence);
      if (events.length > EVENT_CAP) {
        events.splice(0, events.length - EVENT_CAP);
      }

      // Fold into the per-action view.
      const actions = new Map(state.actions);
      const existing = actions.get(event.actionId);
      if (!existing) {
        actions.set(event.actionId, {
          actionId: event.actionId,
          tool: event.tool,
          phase: event.phase,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
          displaySummary: event.displaySummary,
          detail: event.detail,
          progress: event.progress,
          lastSequence: event.sequence,
          hasSeenStart: event.phase === "start",
        });
      } else if (event.phase === "start" && !existing.hasSeenStart) {
        // A real `start` arrived after a done/error (out-of-order delivery):
        // correct startedAt to the true start time WITHOUT changing the phase,
        // so the action is not resurrected as active.
        actions.set(event.actionId, {
          ...existing,
          startedAt: event.timestamp,
          hasSeenStart: true,
        });
      } else if (event.sequence > existing.lastSequence) {
        // Strictly newer (within this action) — advance. `>` not `>=` so a
        // re-emitted same-sequence event cannot resurrect a finished action.
        actions.set(event.actionId, {
          ...existing,
          tool: event.tool,
          phase: event.phase,
          updatedAt: event.timestamp,
          displaySummary: event.displaySummary,
          detail: event.detail ?? existing.detail,
          // Clear progress once terminal so a completed action keeps no stale %.
          progress: isTerminalPhase(event.phase) ? undefined : (event.progress ?? existing.progress),
          lastSequence: event.sequence,
        });
      }
      // else: stale within this action — keep the newer phase.

      // Bound memory: dedup set tracks only the retained window; completed
      // actions that have scrolled out of the log are dropped (active actions
      // are always kept, even if their start event scrolled off).
      const retainedEventIds = new Set(events.map((e) => e.eventId));
      const retainedActionIds = new Set(events.map((e) => e.actionId));
      for (const [id, action] of actions) {
        if (!isActivePhase(action.phase) && !retainedActionIds.has(id)) {
          actions.delete(id);
        }
      }
      // Backstop: even active actions are capped, so a backend that emits only
      // `start` (no terminal) cannot grow the map without bound. Evict the
      // oldest-started actions first.
      if (actions.size > MAX_ACTIONS) {
        const oldest = [...actions.values()]
          .sort((a, b) => a.startedAt - b.startedAt)
          .slice(0, actions.size - MAX_ACTIONS);
        for (const action of oldest) {
          actions.delete(action.actionId);
        }
      }

      return {
        ...state,
        seenEventIds: retainedEventIds,
        events,
        actions,
        lastSequence: Math.max(state.lastSequence, event.sequence),
      };
    }),

  setSessionStatus: (status) =>
    set((state) => {
      // Ignore stale status: a late `connected` must not clear a newer `error`.
      if (status.sequence <= state.lastSessionSequence) {
        return state;
      }
      return {
        ...state,
        connState: status.state,
        lastError: status.state === "error" ? (status.error ?? "unknown error") : null,
        lastSessionSequence: status.sequence,
      };
    }),

  enqueueApproval: (request) =>
    set((state) => {
      if (state.approvalQueue.some((a) => a.approvalId === request.approvalId)) {
        return state; // duplicate approval id — ignore
      }
      return { ...state, approvalQueue: [...state.approvalQueue, request] };
    }),

  dequeueApproval: (approvalId) =>
    set((state) => ({
      ...state,
      approvalQueue: state.approvalQueue.filter((a) => a.approvalId !== approvalId),
    })),

  reset: () => set(() => initialState()),
}));

// --- Derived selectors (pure; usable as `useActivityStore(selectX)`) --------

/** Actions currently running (phase start/progress), oldest first. */
export function selectActiveActions(state: ActivityState): ActionState[] {
  return [...state.actions.values()]
    .filter((a) => isActivePhase(a.phase))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * The user-facing status, derived from connection state + active work + sticky
 * error. Maps to 待機 / 準備 / 会話 / 作業 / エラー.
 */
export function selectDisplayStatus(state: ActivityState): DisplayStatus {
  if (state.connState === "error" || state.lastError) {
    return "error";
  }
  switch (state.connState) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "connected":
      return selectActiveActions(state).length > 0 ? "working" : "conversing";
    default:
      return "idle";
  }
}
