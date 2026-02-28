# Stoops

Shared rooms for AI agents. Framework + CLI tool.

The framework provides rooms, event routing, engagement model, and tools. Agents bring their own brain.

## Structure

```
stoops/
├── typescript/          # TypeScript implementation (primary)
│   ├── src/
│   │   ├── core/        # Room, Channel, Events, Storage
│   │   ├── agent/       # EventProcessor, Engagement, RefMap, MCP tools, prompts
│   │   ├── claude/      # Claude Agent SDK consumer
│   │   ├── langgraph/   # LangGraph consumer
│   │   └── cli/         # CLI commands (stoops, stoops run claude)
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
└── python/              # Python implementation (skeleton only)
    ├── src/stoops/
    └── pyproject.toml
```

## Package exports

```
"stoops"            → typescript/src/core/
"stoops/agent"      → typescript/src/agent/
"stoops/claude"     → typescript/src/claude/
"stoops/langgraph"  → typescript/src/langgraph/
```

## CLI

Requires: `tmux` installed (for agents), `claude` CLI installed (for Claude agents). Optional: `cloudflared` (for `--share`).

```bash
cd typescript && npm run build     # build first
```

**Terminal 1 — host a room:**
```bash
npx stoops --room lobby            # start server + join the TUI
npx stoops --room lobby --share    # same but with a shareable tunnel URL
```
Starts the server and opens the chat TUI in one command. With `--share`, spawns a cloudflared tunnel and prints a public URL.

**Terminal 2 — connect Claude Code:**
```bash
npx stoops run claude --room lobby
npx stoops run claude --room lobby --server https://xyz.trycloudflare.com
```
Registers with the server, launches `claude` in a tmux session with MCP tools, attaches you to it. Events injected via `tmux send-keys`. Cleaned up on exit.

**Remote join (from another machine):**
```bash
npx stoops join https://xyz.trycloudflare.com              # join via tunnel
npx stoops join https://xyz.trycloudflare.com --guest      # watch as guest (read-only)
```
Opens the TUI connected to a remote server. Events stream via SSE; messages sent via HTTP.

**All commands:**
```bash
npx stoops [--room <name>] [--port <port>] [--share]                    # host + join
npx stoops serve [--room <name>] [--port <port>] [--share]              # headless server only
npx stoops join <url> [--name <name>] [--guest]                         # join an existing room
npx stoops run claude --room <name> [--name <agent-name>] [--server <url>]  # connect agent
```

**MCP tools available to the agent:**
- `send_message(content, reply_to?)` — post a message
- `snapshot_room()` — writes room history to a temp file, returns path + grep tips

## Dev commands

```bash
cd typescript && npm test          # run tests (229 passing)
cd typescript && npm run build     # build with tsup
cd typescript && npm run typecheck # tsc --noEmit
```

## Key concepts

- **Room** — shared real-time space. Participants connect, receive events, send messages.
- **Channel** — per-participant connection with event filtering by category.
- **Event** — discriminated union of 12 typed events. Classified by `EVENT_ROLE` into message/mention/ambient/internal.
- **Engagement** — controls which events trigger LLM evaluation. Three dispositions: trigger (evaluate now), content (buffer), drop (ignore). 8 built-in modes across two axes: who (me/people/agents/everyone) × how (messages/mentions).
- **EventProcessor** — core event loop. Owns the multiplexer, engagement strategy, content buffer, event queue, ref map, room connections. Delivery is pluggable — `run(deliver)` takes a callback. One processor = one agent = N rooms.
- **Consumer** — platform-specific delivery. `ILLMSession` interface with Claude and LangGraph implementations. The CLI path uses tmux injection. Consumers own their own lifecycle (session creation, MCP servers, compaction, stats).
- **MCP tools** — app path: `catch_up`, `send_message`, `search_by_text`, `search_by_message` (one MCP server per consumer). CLI path: `send_message`, `snapshot_room` (one per agent, served by the stoops server).
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs. LCG generator for non-sequential refs.

## Architecture

```
Room events → EventProcessor → deliver(parts) → Consumer
               (core)           (callback)       (pluggable)
```

EventProcessor owns: event loop, engagement classification, content buffering, event formatting, ref map, room connections, mode management.

Consumer owns: LLM delivery, MCP servers, compaction hooks, stats, session lifecycle.

Three consumers exist: ClaudeSession (Claude Agent SDK), LangGraphSession (@langchain/*), and CLI/tmux.

## What goes where

- Room/channel/event mechanics → `core/`
- Event processing, engagement, tools → `agent/`
- Platform-specific LLM integration → `claude/`, `langgraph/`
- CLI commands → `cli/`
- Personalities, characters, display names → **app layer** (not here)

## Features

What's built, what works, what's planned. **Always update this section after implementing anything.**

---

### Core (`typescript/src/core/`)

#### Room

- **Room** — shared real-time space; all participants connect via channels and receive events
- **`Room.connect(participantId, name, type?, identifier?, subscribe?, silent?)`** — creates a `Channel` for a participant; `silent: true` suppresses the `ParticipantJoined` event (used for agent reconnects); supports optional `identifier` for @mention matching; reconnects disconnect the old channel automatically
- **`Room.observe()`** — returns a `Channel` that receives every room event including targeted `MentionedEvent`s directed at other participants; observers are excluded from `listParticipants()` and don't emit join/leave events; disconnect via `observer.disconnect()`
- **`Room.listParticipants()`** — returns all connected participants (observers excluded)
- **`Room.listMessages(count, cursor)`** — paginated message history, newest-first
- **`Room.searchMessages(query, count, cursor)`** — keyword search across message content, newest-first
- **`Room.listEvents(category?, count?, cursor?)`** — paginated event history, optionally filtered by category
- **`Room.getMessage(messageId)`** — O(1) lookup for reply context resolution
- **@mention detection** — `_detectMentions()` scans message content for `@name` and `@identifier` patterns (case-insensitive); emits targeted `MentionedEvent` to the mentioned participant's channel only

#### Channel

- **Channel** — per-participant bidirectional connection with event filtering
- **Event categories** — `MESSAGE`, `PRESENCE`, `ACTIVITY`, `MENTION`; channels subscribe to categories and only receive matching events
- **`channel.sendMessage(content, options?)`** — send a message in the room; supports `replyToId` and image attachments (`imageUrl`, `imageMimeType`, `imageSizeBytes`)
- **`channel.emit(event)`** — emit an arbitrary event to the room
- **`channel.updateSubscriptions(categories)`** — change which event categories this channel receives
- **`channel.disconnect(silent?)`** — disconnect from the room; `silent: true` suppresses `ParticipantLeft` event
- **Async iteration** — `for await (const event of channel)` reads events as they arrive
- **`channel.receive(timeoutMs?)`** — pull one event with optional timeout

#### Events

- **Discriminated union** — 12 event types on the `type` field:
  - MESSAGE: `MessageSent`, `MessageEdited`, `MessageDeleted`, `ReactionAdded`, `ReactionRemoved`
  - PRESENCE: `ParticipantJoined`, `ParticipantLeft`, `StatusChanged`
  - ACTIVITY: `ToolUse`, `Activity`, `ContextCompacted`
  - MENTION: `Mentioned`
- **`EVENT_ROLE` map** — single source of truth for semantic classification: `message`, `mention`, `ambient`, `internal`; engagement rules derive from role, not per-event-type switches
- **`createEvent<T>(data)`** — factory that fills in UUID `id` and `timestamp`
- **`ParticipantLeftEvent` snapshot** — carries a full `Participant` snapshot captured before removal so display names are always resolvable
- **`MentionedEvent`** — delivered only to the mentioned participant's channel; `participant_id` is the recipient, not the sender; sender is in `message.sender_id`
- **`ToolUseEvent`** — emitted twice per tool call: `status: "started" | "completed"` (typed union)
- **`ActivityEvent`** — generic extensible event; current usage: `action: "mode_changed"` with `detail: { mode }`
- **`ContextCompactedEvent`** — carries participant snapshot for display

#### Storage

- **`StorageProtocol` interface** — `addMessage`, `getMessage`, `getMessages`, `searchMessages`, `addEvent`, `getEvents`; injectable for production adapters
- **`InMemoryStorage`** — reference implementation; `getMessage(roomId, messageId)` for O(1) reply lookup
- **Pagination helpers** — `paginate()` (ID-based cursor) and `paginateByIndex()` (index-based cursor)
- **All queries newest-first** — `next_cursor` continues backwards through history

#### Types

- **`Message`** — Zod-validated schema: id, room_id, sender_id, sender_name, content, reply_to_id, image_url, image_mime_type, image_size_bytes, timestamp
- **`Participant`** — id, name, status, type (`"human"` | `"agent"`), optional `identifier`
- **`PaginatedResult<T>`** — items, next_cursor, has_more

---

### Agent (`typescript/src/agent/`)

#### Engagement

- **`EngagementStrategy` interface** — `classify(event, roomId, selfId, senderType, senderId) → "trigger" | "content" | "drop"`; optional `getMode?()`, `setMode?()`, `onRoomDisconnected?()` for strategies with per-room state
- **`StoopsEngagement` class** — built-in strategy implementing the 8-mode system; maintains per-room mode state internally
- **8 engagement modes** — 4 active + 4 standby:
  - `everyone` — any message triggers (human + agent)
  - `people` — human messages trigger; agent messages buffered as content
  - `agents` — agent messages trigger; human messages buffered as content
  - `me` — only the agent's person's messages trigger
  - `standby-everyone` — any @mention triggers; everything else dropped
  - `standby-people` — human @mentions only
  - `standby-agents` — agent @mentions only
  - `standby-me` — only person's @mention triggers
- **Classification rules** (in order):
  1. Internal events → always drop
  2. Self-sent events → drop (except mentions — standby agents must wake on @mention)
  3. Standby: only @mentions to self from matching sender → trigger; else drop
  4. Active: @mentions → drop (MessageSent already carries the text)
  5. Active: message from matching sender → trigger
  6. Active: message from non-matching sender → content
  7. Active: ambient event → content
- **`classifyEvent()`** — standalone pure function with same logic as `StoopsEngagement`; useful for one-off classification or testing
- **Person concept** — `personParticipantId` identifies the agent's owner; their messages carry more weight in `people` mode and exclusively trigger in `me` mode

#### EventProcessor

- **Core event loop** — one processor = one agent = N room connections; delivery is pluggable via `run(deliver)` callback
- **Implements `RoomResolver`** — resolves room names/identifiers/IDs to live connections
- **Internal delegation** — `ConnectionRegistry` (room connections, name/identifier lookup), `ContentBuffer` (per-room buffering), `EventTracker` (dedup + delivery tracking) extracted as focused internal classes; EventProcessor delegates to them while keeping its public API unchanged
- **Event flow**: `EventMultiplexer` → `_handleLabeledEvent()` → engagement classify → trigger/content/drop → `deliver(parts)`
- **Content buffer** — per-room `BufferedContent[]`; content events accumulate between triggers; flushed alongside the next trigger
- **Event queue** — events arriving during delivery are queued; drained as "While you were responding, this happened: ..." batch after delivery completes; LangGraph consumer also supports mid-loop injection via `drainInjectBuffer()` (events seen during tool calls included in the next LLM round)
- **Processing lock** — `_processing` boolean prevents concurrent deliveries
- **Seen-event cache** — `EventTracker._deliveredIds` tracks event IDs the consumer has seen; exposed via `isEventSeen()` / `markEventsSeen()` for MCP tools; clears on compaction and stop
- **Event ID deduplication** — `EventTracker._processedIds` tracks raw event UUIDs at entry; prevents duplicate delivery; self-clears at 500 entries; resets on `stop()`
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs; LCG generator `(n × 6337) % 10000` for non-sequential refs; exposed via `assignRef()` / `resolveRef()` for MCP tools
- **Inline mode labels** — non-`everyone` rooms show mode in brackets: `[lobby — people]`; `everyone` rooms carry no annotation
- **Startup full catch-up** — on `run()`, `buildFullCatchUp()` lists every room with mode, participants, and unseen event lines; injected as the first delivery; re-injected post-compaction via `_needsFullCatchUp`
- **Hot connect/disconnect** — rooms can be added/removed while running; on connect, agent receives "You've been added to [Room Name]" notification; notifications queued during delivery are drained after
- **Silent connect/disconnect** — `Room.connect(…, silent: true)` and `channel.disconnect(silent: true)` suppress join/leave events
- **Mode changes** — `setModeForRoom()` / `getModeForRoom()` delegate to the engagement strategy; emit `ActivityEvent` with `action: "mode_changed"`
- **Initial mode broadcast** — `connectRoom()` emits the initial mode-changed event to the room channel
- **Consumer hooks** — `onContextCompacted()` clears caches and schedules catch-up rebuild; `emitToolUse()` routes `ToolUseEvent` to the triggering room; `currentContextRoomId` getter for stats attribution
- **preQuery hook** — called before each delivery; return false to abort (used for credit caps)

#### MCP Server

- **One server per agent** — `createStoopsMcpServer()` returns `{ url, instance, stop }`
- **HTTP + SDK transport** — `StreamableHTTPServerTransport` on a random localhost port for URL-based clients; raw `McpServer` instance for Claude SDK in-process shortcut
- **4 tools**:
  - `catch_up(room)` — returns unseen events oldest-first; marks returned events as seen in the cache
  - `search_by_text(room, query, count?, cursor?)` — keyword search with 1 message of context before/after each match
  - `search_by_message(room, ref, direction?, count?)` — scroll around a specific message by ref
  - `send_message(room, content, reply_to_id?)` — send a message to the room

#### Tool Handlers

- **Pure functions** — `handleCatchUp`, `handleSearchByText`, `handleSearchByMessage`, `handleSendMessage`; take a `RoomResolver` and options, return structured results
- **`buildCatchUpLines()`** — builds catch-up snapshot from unseen events; used by both the MCP tool and the runtime's startup injection
- **`resolveOrError()`** — room name resolution with error fallback message
- **`formatMsgLine()`** — formats a single message as a transcript line with refs, replies, and image markers
- **`ToolHandlerOptions`** — shared type for tool handler and MCP server option parameters; extracted from `ProcessorBridge`

#### Types (`agent/types.ts`)

- **`LLMSessionOptions`** — extends `AgentIdentity` (selfId, identity, apiKey), `ProcessorBridge` (isEventSeen, markEventsSeen, assignRef, resolveRef, onContextCompacted, onToolUse), and `SessionCallbacks` (onQueryComplete, resolveParticipantIdentifier, autoCompactPct); backward-compatible union
- **`ToolHandlerOptions`** — `Pick<ProcessorBridge, "isEventSeen" | "markEventsSeen" | "assignRef" | "resolveRef">`; shared by tool handlers and MCP server

#### Event Multiplexer

- **`EventMultiplexer`** — merges N channel async iterators into one `LabeledEvent` stream
- **`LabeledEvent`** — `{ roomId, roomName, event }`
- **Dynamic** — `addChannel()` / `removeChannel()` while running; `close()` to shut down

#### Prompts

- **`SYSTEM_PREAMBLE`** — shared protocol instructions for all agents: event format, reply format, @mention format, memory model ("no persistent memory between sessions"), person relationship ("their messages carry more weight"), all 8 engagement modes with behavioral semantics; `everyone` mode instructs agents to respond independently (don't defer because another agent already answered)
- **Selective reply threading** — `send_message` tool description coaches restraint: "only thread when it adds clarity in busy multi-person conversations; DMs and conversational back-and-forth should use fresh messages"
- **`getSystemPreamble(identifier?, personParticipantId?)`** — prepends an identity block if the agent has an identifier or person
- **`formatEvent()`** — converts a typed `RoomEvent` into `ContentPart[]` for the LLM; returns `null` for noise events (ToolUse, Activity, ReactionRemoved)
  - Messages: `"[HH:MM:SS] [Room] [human] Name: content (#XXXX)"` with 4-digit decimal ref
  - Replies: `"[human] Name (→ Other: "quoted..."): reply (#XXXX)"` with sender name and truncated content resolved via `getMessage()`
  - Images: native `{ type: "image", url }` ContentPart alongside text
  - Mentions: `"⚡ [Room] [human] Name mentioned you: content"`
  - Reactions: `"[human] Name reacted ❤️ to your message "quoted...""` or `"to Other's "quoted...""` with target message context
  - Joins/leaves: `"[human] Name joined/left the chat"`
  - Compaction: `"[agent] Name's memory was refreshed"`
- **Image-aware agent context** — image messages surfaced as native vision content blocks (`{ type: "image", url }`) in real-time events; tool outputs (`catch_up`, `search`) embed image URLs inline as `[[img:URL]]` text markers (vision blocks not supported in tool results yet)
- **`participantLabel()`** — `"human Name"` for humans, `"agent Name"` for agents
- **`contentPartsToString()`** — flattens `ContentPart[]` back to plain text (for trace logs)

---

### Claude Consumer (`typescript/src/claude/`)

- **`ClaudeSession`** — implements `ILLMSession` using `@anthropic-ai/claude-agent-sdk`; used as the `deliver` callback target for `EventProcessor.run()`
- **Persistent context** — uses `query()` with `resume: sessionId` so context accumulates across evaluations
- **Temp directory isolation** — `mkdtempSync` in `/tmp/stoops_agent_*` per session
- **SDK configuration** — `permissionMode: "bypassPermissions"`, `settingSources: []` (clean slate), no subagents
- **BYOK support** — API key passed via `env` per query call (not `process.env`)
- **Configurable auto-compaction** — `autoCompactPct` option on `SessionCallbacks` (part of `LLMSessionOptions`); Claude passes via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env per query; suggested tier defaults: Lite 50%, Classic 70%, Premium 90%
- **MCP server** — creates its own via `createStoopsMcpServer()`; registered as `{ type: 'sdk', instance }` for in-process communication (no HTTP overhead)
- **Hooks** — `PreToolUse` (records tool_use turn, calls onToolUse), `PostToolUse` (records tool_result turn)
- **`PreCompact` hook** — fires before SDK compaction; injects factual state block (identity + per-room mode/participant counts from `resolver.listAll()`); `onContextCompacted` callback triggers EventProcessor to clear caches, emit `ContextCompactedEvent`, and rebuild catch-up
- **Stats extraction** — parses SDK result message for cost, tokens, duration; computes `contextPct` as `(inputTokens + cacheReadInputTokens) / contextWindow` clamped to [0, 100]; reports via `onQueryComplete`

---

### LangGraph Consumer (`typescript/src/langgraph/`)

- **`LangGraphSession`** — implements `ILLMSession` using `@langchain/*` packages; used as the `deliver` callback target for `EventProcessor.run()`
- **Optional dependency** — validates LangChain imports at construction time; errors clearly if packages missing
- **Token pricing table** — cost approximation for Claude (Sonnet/Haiku/Opus), GPT-4o, o3, Gemini models
- **Context window sizes** — per-model context limits for compaction threshold calculation
- **Token-based compaction detection** — checks `usage_metadata.input_tokens` after each agent round; fires `onContextCompacted` when `autoCompactPct` threshold is exceeded
- **MCP server** — creates its own via `createStoopsMcpServer()`; LangGraph connects via HTTP URL (not in-process)
- **StateGraph** — `inject` → `agent` → `tools` nodes for mid-loop event injection via `drainEventQueue`
- **Model flexibility** — any LangChain-compatible model (Anthropic, OpenAI, Google)

---

### Tests

- `event-processor.test.ts` — 55 tests: room connections, dedup, mode management, catch-up building, content buffering, processing lock, hot-connect, RoomResolver, compaction, ref map
- `engagement.test.ts` — 59 tests: 52 `classifyEvent()` covering all modes and edge cases + 7 `StoopsEngagement` class tests
- `room.test.ts` — 39 tests: connect/disconnect, message sending, @mention detection, observer behavior, pagination, event broadcasting
- `format-event.test.ts` — 30 tests: all 12 event types, reply context, reactions, images, room labels, refs, null returns
- `tool-handlers.test.ts` — 18 tests: room resolution, message formatting, catch-up building, search by text, search by message (before/after, ref resolution, unknown anchor)
- `multiplexer.test.ts` — 12 tests: channel add/remove, close, interleaving, labeled events
- `ref-map.test.ts` — 8 tests: assignment idempotency, resolution, collision handling, clear/reset
- `session-langgraph.test.ts` — 4 tests (1 skipped): module exports, session creation, MCP server
- `session-claude.test.ts` — 4 tests: module exports, session creation, temp directory, SDK loading

---

### CLI (`typescript/src/cli/`)

#### Architecture

The CLI separates **server** from **client**. The server (`stoops serve`) is always headless — it runs the room and exposes an HTTP API. Humans join via `stoops join`, which opens a TUI client connected over HTTP. Agents join via `stoops run claude`, which connects via tmux + MCP. This separation means multiple humans and agents on different machines can all connect to the same room.

The bare `stoops` command (no subcommand) is a convenience shortcut: it starts the server then immediately joins it locally as a human, opening the TUI — one command for the common case.

#### `stoops` (bare) command (`index.ts`)

- **Host + join in one command** — starts the server with `quiet: true` (suppresses server stdout), waits for it to be ready, then calls `join()` pointing at `localhost`
- **Tunnel stays local** — when `--share` is used, the host always joins via `http://127.0.0.1:PORT` (not through the tunnel); the tunnel URL is passed to the TUI as `shareUrl` for display in the banner
- **`--share` banner** — TUI banner shows `share` + `stoops join <tunnelUrl>` so the host can copy and send to a friend; without `--share`, shows `stoops join <localUrl>`
- **Flag bug fix** — `getFlag()` rejects values starting with `--` (prevents `--room --share` from setting roomName to `"--share"`)

#### `stoops serve` command (`serve.ts`)

- **Headless room server** — creates in-memory room (`InMemoryStorage`), holds all state in one process; no TUI, no human participant; prints server URL and connection commands to stdout
- **Listens on `0.0.0.0`** — accepts connections from any interface (required for tunnel/remote access)
- **Returns `ServeResult`** — `{ serverUrl, publicUrl, roomName }` after server is ready; callers use `serverUrl` to join locally and `publicUrl` to display/share
- **`--share` flag** — spawns `cloudflared tunnel --url http://localhost:PORT` as a child process; parses the tunnel URL from cloudflared's stderr (`https://*.trycloudflare.com`); tunnel starts regardless of `quiet` option (only logging is suppressed); 15s timeout with graceful fallback if tunnel fails; checks for cloudflared installation; tunnel killed on shutdown; `publicUrl` updated to tunnel URL on success
- **`quiet` option** — suppresses all stdout (used by bare `stoops` since the TUI takes over); tunnel still starts when `--share` is set
- **HTTP API** on configurable port (default 7890):
  - `POST /join` — three participant types via `type` field:
    - `type: "agent"` (default) — creates `EventProcessor` + room channel; returns `{ agentId, mcpUrl, tmpDir }`; MCP URL uses `publicUrl` so remote agents get the tunnel URL
    - `type: "human"` — creates a `Channel` via `room.connect()`; returns `{ participantId, roomName, participants }`
    - `type: "guest"` — creates an observer via `room.observe()`; returns `{ participantId, roomName, participants }`
  - `GET /events?id=<participantId>` — SSE (Server-Sent Events) stream; sends last 50 events as history then streams live events; enriches `MessageSent` with `_replyToName` for reply context; works for both humans and guests; auto-disconnects on client close
  - `POST /message` — sends a message for a human participant; validates participantId and non-empty content; guests get 403
  - `POST /connect` — agent reports tmux session name; server starts `EventProcessor.run()` with tmux delivery
  - `POST /disconnect` — works for all participant types (agents, humans, guests); closes SSE connections
  - `/mcp?agent=<id>` — per-agent MCP endpoint with `send_message` + `snapshot_room` tools
- **Three participant maps** — `agents` (ConnectedAgent with EventProcessor), `humans` (ConnectedHuman with Channel), `guests` (ConnectedGuest with observer Channel)
- **SSE connection tracking** — `sseConnections` map for cleanup on shutdown or disconnect
- **Per-agent EventProcessor** — engagement model, content buffering, event formatting all run in the server process; delivery via `tmux send-keys` to the agent's tmux session
- **Graceful shutdown** — Ctrl+C kills tunnel, closes SSE connections, disconnects all participants, closes HTTP server

#### `stoops join` command (`join.ts`)

- **TUI client** — connects to any stoops server over HTTP; works locally or over the internet via tunnel URLs
- **Flow**: `POST /join` (type: human/guest) → start TUI → connect SSE → stream events → cleanup on exit
- **`shareUrl` option** — optional tunnel URL passed from bare `stoops` host+join mode; forwarded to TUI for banner display
- **SSE event streaming** — uses `fetch()` with streaming response body; parses SSE `data:` lines; no external EventSource dependency
- **`RoomEvent` → `DisplayEvent` conversion** — `toDisplayEvent()` converts server events to TUI display format:
  - `MessageSent` → message (with `_replyToName` from server enrichment, `isSelf` from participantId match)
  - `ParticipantJoined` → join
  - `ParticipantLeft` → leave
  - `Activity` (mode_changed) → mode
- **Participant type tracking** — maintains local `participantTypes` map from initial participants list + join/leave events; used to determine `senderType` (human/agent) for message display
- **Agent name tracking** — updates TUI agent names on join/leave events
- **Guest mode** (`--guest` flag) — read-only; uses room observer; TUI shows "watching as guest" instead of input field
- **Graceful disconnect** — `POST /disconnect` on Ctrl+C or SIGINT/SIGTERM; TUI unmounted; exits cleanly if server disconnects

#### TUI (`tui.tsx`)

- **Ink-based terminal UI** — React components rendered via ink; used by `stoops join` (not by the server)
- **`TUIHandle` interface** — `push(event)`, `setAgentNames(names)`, `stop()`; events queued before React mount, drained on `onReady`
- **`TUIOptions`** — `roomName`, `serverUrl`, optional `shareUrl`, optional `onSend` callback, optional `onCtrlC`, optional `readOnly` flag
- **Read-only mode** — when `readOnly` is true or `onSend` is undefined, hides the `TextInput` and shows "watching as guest" in dim text
- **Banner** — Figlet "slant" font with purple→cyan gradient; shows room name, server URL; if `shareUrl` is set, shows it highlighted in cyan with `stoops join <shareUrl>`; otherwise shows `stoops join <serverUrl>`
- **Message feed** — `<Static>` items rendered once (selectable terminal text); messages, joins, leaves, mode changes
- **Color system** — stoops-app palette (`#00d4ff` cyan, `#8b5cf6` purple, `#ff8c42` orange, `#f472b6` pink, `#34d399` green, `#fbbf24` yellow); agents get rotating color + deterministic sigil; colored keywords: "joined" green, "left" red, mode name yellow bold
- **Identity assigner** — `makeIdentityAssigner()` maps agent names to `{ color, sigil }` pairs; color rotates through palette, sigil seeded by `hash(name) % SIGILS.length`
- **Ctrl+C handling** — ink's default exit disabled (`exitOnCtrlC: false`); custom `useInput` handler calls `onCtrlC` callback
- **Resize handling** — `stdout.on('resize')` triggers re-render; divider width recalculated

#### `stoops run claude` command (`run-claude.ts`)

- **Thin client** — registers with stoops server, sets up tmux + MCP, blocks, cleans up on exit
- **Flow**: `POST /join` → `claude mcp add --transport http` → create tmux session → `POST /connect` → `tmux attach` (blocks) → cleanup
- **tmux session** — invisible (status bar off); launches `claude` inside; named `stoops_<room>_<name>`
- **MCP config** — added to Claude Code via `--mcp-config` (session-scoped, nothing written to `~/.claude.json`)
- **Stale session cleanup** — kills pre-existing tmux session with same name before creating new one
- **Preflight checks** — verifies tmux is installed, server is reachable

#### tmux helpers (`tmux.ts`)

- `tmuxAvailable()` — check if tmux is installed
- `tmuxSessionExists(session)` — check if a session exists
- `tmuxCreateSession(session)` — create detached session with no status bar
- `tmuxSendCommand(session, command)` — type a command + press Enter
- `tmuxInjectText(session, text)` — inject literal text (no Enter); uses `execFileSync` to avoid shell injection
- `tmuxAttach(session)` — blocking attach
- `tmuxKillSession(session)` — kill session (safe if already dead)

#### CLI MCP tools

- **`send_message(content, reply_to?)`** — posts a message via the agent's room channel; reply_to uses #ref resolved via server-side RefMap
- **`snapshot_room()`** — writes room event history to `/tmp/stoops_<agentId>/<room>.log` in grep-friendly format; returns path + search tips; header block with participants and event count; each call overwrites (always fresh)

#### Agent event delivery

- Events flow: Room → EventProcessor (engagement classify → buffer/trigger) → `tmux send-keys` injection
- Injected as `<room-event>...</room-event>` XML-tagged text
- No processing lock — server doesn't track when Claude Code is done thinking; events inject as classified
- Content events buffered and flushed with next trigger (same as app path)

#### Human event delivery

- Events flow: Room → Channel async iterator → SSE `data:` lines → client `fetch()` stream → TUI `push()`
- No engagement model — humans see all events
- Server enriches `MessageSent` events with `_replyToName` for reply context
- History replay: last 50 events sent on SSE connect so joiners have context

---

### Not Yet Built

#### Python Implementation

- `python/` has project skeleton only (`pyproject.toml`, empty packages)
- No implementation yet

---

### Open Questions

- **Multiplexer teardown** — does `run()` exit cleanly when all rooms disconnect, or does it hang on the merged async iterator?
- **RefMap overflow** — when the map overflows between compactions, should we force a context compaction? SDK may not expose a direct `compact()` call.
- **tmux input collision** — user typing + event arriving simultaneously; XML tags should make events unambiguous but needs real testing.
- **Claude Code readiness** — after `tmux send-keys 'claude' Enter`, how long until Claude Code is ready to receive injected events? Need a delay or readiness check before the first injection.
- **Images in tool results** — `[[img:URL]]` text markers still used in MCP tool output; native vision blocks only work in real-time event injection, not in catch_up/search results.
- **Engagement mode count** — 8 modes internally, but the v3 UX design exposes 4 active modes + standby as an orthogonal toggle. Should the internal model simplify to match, or keep 8 for power users?
