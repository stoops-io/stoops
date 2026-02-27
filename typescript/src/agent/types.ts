/**
 * Shared interfaces for the stoops agent runtime.
 *
 * These are the contracts between the three layers:
 *
 *   StoopRuntime  ──uses──►  ILLMSession  ◄──implements──  ClaudeSession
 *                                                           LangGraphSession
 *                                                           (your own)
 *
 * To build a custom LLM backend: implement `ILLMSession` and export a
 * `SessionFactory` function. Pass it as `sessionFactory` in `StoopRuntimeOptions`.
 */

import type { Room } from "../core/room.js";
import type { Channel } from "../core/channel.js";
import type { EngagementMode, EngagementStrategy } from "./engagement.js";

// ── Content ───────────────────────────────────────────────────────────────────

/**
 * A structured content item sent to the LLM as part of a message.
 *
 * The runtime formats room events into ContentPart arrays before calling
 * `session.process()`. Text parts carry the formatted event text; image parts
 * carry the URL of an attached image so the LLM can see it natively.
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
 * Implemented by `StoopRuntime`, which maintains the map as rooms are connected
 * and disconnected. Tool handlers receive a `RoomResolver` so they can look up
 * rooms by the names the LLM uses.
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
 *
 * Reported via `LLMSessionOptions.onQueryComplete` after every evaluation.
 * The runtime forwards this to `StoopRuntimeOptions.onQueryComplete`, where
 * the app layer (web, worker) can persist it and display it in the UI.
 */
export interface LLMQueryStats {
  totalCostUsd: number;
  durationMs: number;
  /** Time spent on API calls only (excludes tool execution time). */
  durationApiMs: number;
  /** Number of LLM rounds in this evaluation (1 + number of tool-call loops). */
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache (Anthropic only). */
  cacheReadInputTokens: number;
  /** Tokens written to the prompt cache (Anthropic only). */
  cacheCreationInputTokens: number;
  isError: boolean;
  /** Context window usage as a percentage (0–100). */
  contextPct: number;
  /** The formatted text injected into the LLM for this evaluation. */
  input: string;
  /** Ordered sequence of tool calls and results during this evaluation. */
  turns: QueryTurn[];
}

// ── Session interface ─────────────────────────────────────────────────────────

/**
 * Backend-agnostic LLM session interface.
 *
 * Implement this to create a custom agent backend. The `StoopRuntime` calls
 * `start()` once at startup, `process()` for each event that triggers an
 * evaluation, and `stop()` when the agent is shut down.
 *
 * Each instance represents one agent's persistent conversation — context
 * accumulates across `process()` calls within a single `start()`/`stop()` lifecycle.
 *
 * @example
 * class MySession implements ILLMSession {
 *   async start() { // load model, connect to MCP server }
 *   async stop()  { // teardown }
 *   async process(parts: ContentPart[]) {
 *     // run LLM, call tools, report stats via onQueryComplete
 *   }
 *   setApiKey(key: string) { this._apiKey = key; }
 * }
 */
export interface ILLMSession {
  /** Initialize the session — load the SDK, start the MCP server, build the graph. */
  start(): Promise<void>;
  /** Tear down the session — stop the MCP server, release resources. */
  stop(): Promise<void>;
  /**
   * Run one LLM evaluation with the given content.
   * The session maintains conversation history across calls.
   * Reports stats via `options.onQueryComplete` before returning.
   */
  process(parts: ContentPart[]): Promise<void>;
  /** Update the API key for a running session (used for BYOK). */
  setApiKey(key: string): void;
}

/**
 * Factory function that creates a new `ILLMSession`.
 *
 * Import the factory for your chosen backend and pass it as `sessionFactory`
 * in `StoopRuntimeOptions`:
 *
 * @example
 * import { createClaudeSession } from "stoops/claude";
 * import { createLangGraphSession } from "stoops/langgraph";
 *
 * const runtime = new StoopRuntime(id, name, prompt, model, mode, {
 *   sessionFactory: createClaudeSession,  // or createLangGraphSession
 * });
 */
export type SessionFactory = (
  systemPrompt: string,
  resolver: RoomResolver,
  model: string,
  options: LLMSessionOptions,
) => ILLMSession;

// ── Session options ────────────────────────────────────────────────────────────

/**
 * Options passed from `StoopRuntime` to the `ILLMSession` on creation.
 *
 * Most of these are callbacks the session calls to integrate with the runtime:
 * event tracking, ref resolution, stats reporting, and context management.
 * You generally don't construct this yourself — it's assembled by `StoopRuntime`.
 */
export interface LLMSessionOptions {
  /** Path to the `claude` CLI binary (Claude backend only). */
  pathToClaudeCodeExecutable?: string;
  /** Called when a tool call starts or completes (for UI indicators). */
  onToolUse?: (toolName: string, status: "started" | "completed") => void;
  /** Called after each LLM evaluation with full stats. */
  onQueryComplete?: (stats: LLMQueryStats) => void;
  /** Resolve a participant ID to their stable identifier slug (e.g. "quinn"). */
  resolveParticipantIdentifier?: (id: string) => string | null;
  /** The agent's own participant ID. */
  selfId?: string;
  /** The agent's own stable identifier slug. */
  selfIdentifier?: string;
  /** Check if an event ID has already been delivered to the LLM context. */
  isEventSeen?: (eventId: string) => boolean;
  /** Mark event IDs as delivered to the LLM context. */
  markEventsSeen?: (eventIds: string[]) => void;
  /** Assign a short 4-digit decimal ref to a message ID (e.g. "3847"). */
  assignRef?: (messageId: string) => string;
  /** Resolve a ref back to the full message UUID. */
  resolveRef?: (ref: string) => string | undefined;
  /** BYOK API key — passed directly to the LLM provider. */
  apiKey?: string;
  /** Called when the context window was compacted. The runtime uses this to rebuild context. */
  onContextCompacted?: () => void;
  /** Display string identifying this agent (used in compaction prompts). */
  identity?: string;
  /**
   * Context usage percentage threshold at which to trigger compaction (0–100).
   * The Claude backend passes this as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
   * The LangGraph backend triggers `onContextCompacted` when usage exceeds this.
   */
  autoCompactPct?: number;
  /**
   * Called by the LangGraph backend between tool-call rounds to drain any events
   * that arrived while the LLM was mid-evaluation. This enables mid-loop event
   * injection — an @mention seen during a tool call is included in the next LLM
   * round rather than waiting until the whole evaluation completes.
   *
   * Returns null if there are no buffered events.
   */
  drainEventQueue?: () => ContentPart[][] | null;
}

// ── Runtime options ────────────────────────────────────────────────────────────

/**
 * Configuration for `StoopRuntime`.
 *
 * `sessionFactory` is required — import it from `stoops/claude` or
 * `stoops/langgraph` (or provide your own `ILLMSession` implementation).
 *
 * @example
 * import { createClaudeSession } from "stoops/claude";
 *
 * const runtime = new StoopRuntime("agent-id", "Quinn", systemPrompt, model, "people", {
 *   sessionFactory: createClaudeSession,
 *   selfIdentifier: "quinn",
 *   personParticipantId: "user-abc",
 *   autoCompactPct: 70,
 *   onQueryComplete: (stats, roomId) => console.log(stats),
 * });
 */
export interface StoopRuntimeOptions {
  /**
   * The LLM session backend to use.
   * Import from `stoops/claude` or `stoops/langgraph`.
   */
  sessionFactory: SessionFactory;
  /** Path to the `claude` CLI binary (Claude backend only). */
  pathToClaudeCodeExecutable?: string;
  /** Called when the agent's engagement mode changes for a room. */
  onModeChange?: (roomId: string, roomName: string, mode: EngagementMode) => void;
  /** Called when a tool call starts or completes (for UI typing indicators). */
  onToolUse?: (toolName: string, status: "started" | "completed") => void;
  /** Called after each LLM evaluation. `contextRoomId` is the room that triggered it. */
  onQueryComplete?: (stats: LLMQueryStats, contextRoomId: string | null) => void;
  /** Resolve a participant ID to their stable identifier slug. */
  resolveParticipantIdentifier?: (id: string) => string | null;
  /** The agent's own stable identifier slug (e.g. "quinn"). */
  selfIdentifier?: string;
  /** BYOK API key — forwarded to the session backend. */
  apiKey?: string;
  /** Called when the context window was compacted. */
  onContextCompacted?: () => void;
  /** Display string identifying this agent in logs. */
  identity?: string;
  /**
   * Context usage % threshold for compaction (0–100).
   * Suggested values: 50 (lite), 70 (standard), 90 (premium).
   */
  autoCompactPct?: number;
  /**
   * The participant ID of the agent's designated owner ("person").
   * Used in "me" and "standby-me" engagement modes to match only that person's
   * messages. Also used for billing attribution.
   *
   * When using the default `StoopsEngagement`, this is passed to its constructor.
   * When providing a custom `engagement` strategy, this field is unused by the
   * runtime itself — configure your strategy directly.
   */
  personParticipantId?: string;
  /**
   * Called before each LLM evaluation. Return false to abort the evaluation.
   * Used for credit cap enforcement — check the owner's balance here so billing
   * is always attributed to the agent owner, not the message sender.
   */
  preQuery?: () => Promise<boolean>;
  /**
   * Custom engagement strategy — controls which events trigger LLM evaluation.
   *
   * Defaults to `StoopsEngagement(defaultMode, personParticipantId)` if not provided.
   * Implement `EngagementStrategy` to use your own classification logic.
   */
  engagement?: EngagementStrategy;

}
