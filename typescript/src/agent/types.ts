/**
 * Shared interfaces for stoops agent infrastructure.
 *
 * Two layers:
 *
 *   EventProcessor  ──deliver()──►  Consumer (ClaudeSession, LangGraphSession, tmux, etc.)
 *
 * EventProcessor owns the event loop, engagement, formatting.
 * Consumers own LLM delivery, MCP servers, compaction, stats.
 */

import type { Room } from "../core/room.js";
import type { Channel } from "../core/channel.js";

// ── Content ───────────────────────────────────────────────────────────────────

/**
 * A structured content item delivered to the consumer.
 *
 * Text parts carry formatted event text; image parts carry the URL of an
 * attached image so vision-capable consumers can see it natively.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

// ── Room resolution ───────────────────────────────────────────────────────────

/**
 * A resolved room connection: the room instance, the agent's channel, and the
 * room's display name. Passed to tool handlers so they can read/write the room.
 */
export interface RoomConnection {
  room: Room;
  channel: Channel;
  name: string;
}

/**
 * Maps room names (and identifiers) to their live connections.
 *
 * Implemented by `EventProcessor`. Tool handlers and sessions receive a
 * `RoomResolver` so they can look up rooms by the names the LLM uses.
 */
export interface RoomResolver {
  /** Resolve a room by display name, identifier slug, or room ID. Returns null if unknown. */
  resolve(roomName: string): RoomConnection | null;
  /** List all currently connected rooms with metadata. */
  listAll(): Array<{
    name: string;
    roomId: string;
    identifier?: string;
    mode: string;
    participantCount: number;
    lastMessage?: string;
  }>;
}

// ── Query stats ────────────────────────────────────────────────────────────────

/**
 * A single tool call or result recorded during an LLM evaluation.
 * Used for trace logging and observability.
 */
export interface QueryTurn {
  type: "tool_use" | "tool_result";
  tool: string;
  content: unknown;
}

/**
 * Stats from one complete LLM evaluation (one `session.process()` call).
 * Reported via `LLMSessionOptions.onQueryComplete` after every evaluation.
 */
export interface LLMQueryStats {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  isError: boolean;
  contextPct: number;
  input: string;
  turns: QueryTurn[];
}

// ── Session interface ─────────────────────────────────────────────────────────

/**
 * LLM session interface — the consumer side of the EventProcessor split.
 *
 * Each instance represents one agent's persistent conversation.
 * `process()` is the delivery method — EventProcessor calls it via the
 * `deliver` callback passed to `run()`.
 */
export interface ILLMSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  process(parts: ContentPart[]): Promise<void>;
  setApiKey(key: string): void;
}

// ── Session options ────────────────────────────────────────────────────────────

/**
 * Options for LLM session consumers.
 *
 * These are callbacks the session calls to integrate with the EventProcessor:
 * event tracking, ref resolution, stats reporting, and context management.
 * The caller assembles these by wiring EventProcessor methods.
 */
export interface LLMSessionOptions {
  pathToClaudeCodeExecutable?: string;
  onToolUse?: (toolName: string, status: "started" | "completed") => void;
  onQueryComplete?: (stats: LLMQueryStats) => void;
  resolveParticipantIdentifier?: (id: string) => string | null;
  selfId?: string;
  selfIdentifier?: string;
  isEventSeen?: (eventId: string) => boolean;
  markEventsSeen?: (eventIds: string[]) => void;
  assignRef?: (messageId: string) => string;
  resolveRef?: (ref: string) => string | undefined;
  apiKey?: string;
  onContextCompacted?: () => void;
  identity?: string;
  autoCompactPct?: number;
  drainEventQueue?: () => ContentPart[][] | null;
}
