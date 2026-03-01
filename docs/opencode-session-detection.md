# OpenCode Session Detection

Status: **hacky workaround in place, needs proper solution**

## The Problem

`stoops run opencode` spawns `opencode serve` and provides MCP tools. When room events arrive, we need to deliver them to the correct OpenCode session via `POST /session/:id/message`. But OpenCode can have many persistent sessions (stored in SQLite, survive restarts), and we don't know which one the user is actively chatting in.

Unlike Claude Code where there's exactly one tmux pane = one target, OpenCode has N persistent sessions and no reliable way to map an MCP tool call back to the calling session.

## What We Tried

### 1. Detect on join via `/session/status` (busy session)

Query `GET /session/status` when `join_room` fires, find the "busy" session.

**Why it failed:** Multiple sessions can exist (persisted from previous runs). `Object.entries` iteration order is not guaranteed by update time. Often picked the wrong session.

### 2. Global SSE event stream (`GET /global/event`)

Subscribe to OpenCode's SSE at `/global/event`, watch for `message.part.updated` events with `part.type === "tool"` and `part.tool` containing `stoops__`. Each tool part carries `sessionID`.

**Why it failed:** The SSE endpoint only emits `server.connected` and `server.heartbeat` in `opencode serve` mode. Session-level events (tool calls, messages) never appear on the global bus. Likely a limitation of `opencode serve` — the session processing might happen in a context that doesn't emit to GlobalBus, or GlobalBus only works in the TUI/worker mode.

We confirmed:

- `GET /event` (flat format) and `GET /global/event` (payload-wrapped format) both exist
- Both only return `server.connected` + `server.heartbeat`
- Tool parts DO exist in `GET /session/:id/message` — the data is there, just not broadcast via SSE
- Tool names are prefixed with the MCP server name: `stoops_stoops__join_room` (not `stoops__join_room`)

### 3. Query session messages for stoops tools (current approach)

When `onRoomJoined` fires, query `GET /session` (sorted by `time.updated` desc), check top 3 sessions' messages for `stoops__` tool parts, use the first match.

**Why it's not great:** It's polling-based and adds latency. Checking messages for N sessions is multiple HTTP round-trips. The `time.updated` heuristic could pick wrong in edge cases (e.g., user has another session active simultaneously). For multi-session scenarios (session A joins room1, session B joins room2), subsequent joins may incorrectly attribute to the wrong session if both have stoops tools.

## What Would Actually Work

### Option A: OpenCode exposes session ID in MCP tool context

If OpenCode passed the calling session ID as a custom HTTP header (e.g., `X-OpenCode-Session-Id`) when making MCP tool calls to remote servers, we'd have a perfect mapping. This would require a change to OpenCode's MCP client.

The session ID IS available internally — `Tool.Context.sessionID` is set in `src/session/prompt.ts:836` — it's just not propagated to the HTTP transport.

### Option B: Fix GlobalBus in `opencode serve` mode

If `message.part.updated` events actually flowed through the global SSE endpoint in serve mode, our SSE approach would work perfectly. Each event carries `sessionID`, `tool` name, and `state.input` with the tool arguments.

### Option C: OpenCode TUI in tmux (like Claude Code)

Bare `opencode` (no subcommand) opens an interactive terminal TUI. We could run it in tmux and inject events via `send-keys`, exactly like the Claude Code integration. Would need TmuxBridge state detection adapted for OpenCode's TUI patterns.

Rejected by user — they want the programmatic API, not tmux.

### Option D: MCP protocol-level session tracking

Use `Mcp-Session-Id` headers (part of the MCP spec) to establish persistent MCP sessions. But OpenCode creates one shared MCP client for all sessions, so MCP session IDs wouldn't distinguish OpenCode sessions.

### Option E: Per-tool-call correlation via nonce

Have `join_room` return a unique nonce in its response. After the tool completes, search session messages for that nonce. Reliable but adds another HTTP round-trip per join.

## Current State

Using approach #3 (message inspection). Works for the single-session case. May break with multiple concurrent sessions. The `onRoomJoined(url, roomId)` callback in `runtime-setup.ts` provides the room ID; `findStoopsSession()` in `opencode/run.ts` does the session lookup.

Delivery uses `processor.currentContextRoomId` to look up the target session per-room from a `roomSessions` map, so the plumbing for multi-session IS in place — the weak link is just the detection.

## Key Files

- `typescript/src/cli/opencode/run.ts` — OpenCode runtime, session detection, delivery
- `typescript/src/cli/runtime-setup.ts` — shared setup, `onRoomJoined` callback
- `typescript/src/agent/mcp/runtime.ts` — MCP server tools
- OpenCode source: `/Users/izzat/Projects/opencode/packages/opencode/src/session/prompt.ts` (tool context with sessionID)
- OpenCode source: `/Users/izzat/Projects/opencode/packages/opencode/src/server/routes/global.ts` (SSE endpoint)
- OpenCode source: `/Users/izzat/Projects/opencode/packages/opencode/src/bus/index.ts` (Bus.publish → GlobalBus)
