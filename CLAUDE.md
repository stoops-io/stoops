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
│   │   └── cli/         # CLI commands (stoops, stoops run claude, stoops run opencode)
│   │       ├── claude/  # Claude Code agent runtime (TmuxBridge, run command)
│   │       └── opencode/ # OpenCode agent runtime (HTTP API delivery)
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

Requires: `tmux` installed (for Claude agents), `claude` CLI installed (for Claude agents), `opencode` installed (for OpenCode agents). Optional: `cloudflared` (for `--share`).

```bash
cd typescript && npm run build     # build first
```

**Terminal 1 — host a room:**
```bash
npx stoops --room lobby            # start server + join the TUI
npx stoops --room lobby --share    # same but with a shareable tunnel URL
```
Starts the server and opens the chat TUI in one command. With `--share`, spawns a cloudflared tunnel and prints a public URL.

**Terminal 2 — connect an agent:**
```bash
npx stoops run claude                                       # Claude Code — then tell agent to join a room
npx stoops run claude --admin                              # with admin MCP tools
npx stoops run claude -- --model sonnet                    # passthrough args after --
npx stoops run opencode                                    # OpenCode (in progress — session detection unreliable)
```
Launches a client-side agent runtime with MCP tools. The agent joins rooms manually by calling `join_room(url)` — tell the agent the URL and it joins, getting full onboarding (identity, mode, participants, recent activity) from the tool response. Everything after `--` is forwarded to the underlying tool as-is.

**Remote join (from another machine):**
```bash
npx stoops join <share-url>                                 # join via share link
npx stoops join <share-url> --guest                         # watch as guest (read-only)
```
Opens the TUI connected to a remote server. Events stream via SSE; messages sent via HTTP. Authority determined by share token.

**All commands:**
```bash
npx stoops [--room <name>] [--port <port>] [--share]                            # host + join
npx stoops serve [--room <name>] [--port <port>] [--share] [--headless]         # server only
npx stoops join <url> [--name <name>] [--guest] [--headless]                    # join an existing room
npx stoops run claude [--name <name>] [--admin] [--headless] [-- <args>]        # connect Claude Code
npx stoops run opencode [--name <name>] [--admin] [-- <args>]                   # connect OpenCode (in progress)
```

**Authority model:**
- Three tiers: `admin` > `participant` > `observer`
- Share links encode authority — anyone with the link joins at that tier
- Admins can kick, change others' modes, generate share links at any tier
- Participants can send messages, change own mode, generate participant/observer links
- Observers are read-only

**MCP tools (agent runtime):**
- `stoops__catch_up(room?)` — with room: catch up on events. Without: list all connected rooms
- `stoops__search_by_text(room, query, count?, cursor?)` — keyword search
- `stoops__search_by_message(room, ref, direction?, count?)` — scroll around a message
- `stoops__send_message(room, content, reply_to?)` — post a message
- `stoops__set_mode(room, mode)` — change own engagement mode
- `stoops__join_room(url, alias?)` — join a new room mid-session
- `stoops__leave_room(room)` — leave a room
- `stoops__admin__set_mode_for(room, participant, mode)` — admin only
- `stoops__admin__kick(room, participant)` — admin only

**TUI slash commands:**
- `/who` — list participants with types and authority
- `/leave` — disconnect
- `/kick <name>` — admin: remove a participant
- `/mute <name>` — admin: force standby-everyone
- `/wake <name>` — admin: force everyone mode
- `/setmode <name> <mode>` — admin: set specific mode
- `/share [--as admin|participant|observer]` — generate share links

## Dev commands

```bash
cd typescript && npm test          # run tests (248 passing)
cd typescript && npm run build     # build with tsup
cd typescript && npm run typecheck # tsc --noEmit
```

### Headless mode

All three CLI commands support `--headless` for scriptable, terminal-free operation:

- `stoops serve --headless` — emits a single JSON line `{ serverUrl, publicUrl, roomName, adminToken, participantToken }` then runs silently. No banner, no logs.
- `stoops join <url> --headless` — skips the TUI; streams raw `RoomEvent` JSON lines to stdout, reads messages from stdin (one line per send).
- `stoops run claude --headless` — skips tmux; delivers formatted events as plain text to stdout. The MCP server URL is printed to stderr so tool calls can be made directly via HTTP.

Together these make it possible to drive a full room scenario from a script: start a server, parse its tokens, connect an agent runtime, send messages as a human participant, and inspect what the agent received — all without a terminal or tmux. The `--headless` agent runtime runs the full stack (EventProcessor, SSE multiplexer, engagement engine, MCP server) with only the last-mile delivery swapped out.

## Key concepts

- **Room** — shared real-time space. Participants connect, receive events, send messages.
- **Channel** — per-participant connection with event filtering by category.
- **Event** — discriminated union of 12 typed events. Classified by `EVENT_ROLE` into message/mention/ambient/internal.
- **Engagement** — controls which events trigger LLM evaluation. Three dispositions: trigger (evaluate now), content (buffer), drop (ignore). 8 built-in modes across two axes: who (me/people/agents/everyone) × how (messages/mentions).
- **EventProcessor** — core event loop. Owns the multiplexer, engagement strategy, content buffer, event queue, ref map, room connections. Delivery is pluggable — `run(deliver)` takes a callback. One processor = one agent = N rooms.
- **Consumer** — platform-specific delivery. `ILLMSession` interface with Claude and LangGraph implementations. The CLI path uses tmux injection (Claude Code) or HTTP API (OpenCode). Consumers own their own lifecycle (session creation, MCP servers, compaction, stats).
- **Authority** — three tiers: `admin` > `participant` > `observer`. Set on join via share token. Controls what actions are permitted (MCP tools, slash commands). Orthogonal to engagement.
- **MCP tools** — app path: `catch_up`, `send_message`, `search_by_text`, `search_by_message` (one MCP server per consumer). CLI path: runtime MCP server with `stoops__*` tools routed to remote servers via HTTP.
- **RoomDataSource** — abstraction over room data access. `LocalRoomDataSource` wraps Room+Channel for in-process. `RemoteRoomDataSource` wraps HTTP calls to a stoop server.
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs. LCG generator for non-sequential refs.

## Architecture

Two deployment modes:

**App path (in-process):**
```
Room events → EventProcessor → deliver(parts) → Consumer
               (core)           (callback)       (pluggable)
```

**CLI path — Claude Code (tmux delivery):**
```
Stoop Server ──SSE──→ SseMultiplexer ──→ EventProcessor ──tmux──→ Claude Code
Stoop Server ←─HTTP── RuntimeMcpServer ←──MCP tool calls── Claude Code
```

**CLI path — OpenCode (HTTP API delivery):**
```
Stoop Server ──SSE──→ SseMultiplexer ──→ EventProcessor ──HTTP──→ OpenCode
Stoop Server ←─HTTP── RuntimeMcpServer ←──MCP tool calls── OpenCode
```

The stoop server is dumb — one room, HTTP API, SSE broadcasting, authority enforcement. The agent runtime is smart — SSE listener, engagement engine, local MCP proxy, pluggable delivery (tmux for Claude Code, HTTP API for OpenCode). All run client-side.

EventProcessor owns: event loop, engagement classification, content buffering, event formatting, ref map, room connections, mode management. Accepts either local channels (app path) or external SSE source (CLI path) via `run(deliver, eventSource?)`.

Consumer owns: LLM delivery, MCP servers, compaction hooks, stats, session lifecycle.

Four consumers exist: ClaudeSession (Claude Agent SDK), LangGraphSession (@langchain/*), CLI/tmux (Claude Code), and CLI/HTTP (OpenCode).

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
- **`Room.connect(participantId, name, options?)`** — creates a `Channel` for a participant; options: `{ type?, identifier?, subscribe?, silent?, authority? }`; `silent: true` suppresses the `ParticipantJoined` event (used for agent reconnects); supports optional `identifier` for @mention matching; optional `authority` stored on the Participant; reconnects disconnect the old channel automatically
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
- **`AuthorityLevel`** — `"admin" | "participant" | "observer"` — determines what a participant can do
- **`Participant`** — id, name, status, type (`"human"` | `"agent"`), optional `identifier`, optional `authority`
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

- **Core event loop** — one processor = one agent = N room connections; delivery is pluggable via `run(deliver, eventSource?, initialParts?)` callback
- **Implements `RoomResolver`** — resolves room names/identifiers/IDs to live connections
- **Internal delegation** — `ConnectionRegistry` (room connections, name/identifier lookup), `ContentBuffer` (per-room buffering), `EventTracker` (dedup + delivery tracking) extracted as focused internal classes; EventProcessor delegates to them while keeping its public API unchanged
- **Event flow**: event source (EventMultiplexer or SseMultiplexer) → `_handleLabeledEvent()` → engagement classify → trigger/content/drop → `deliver(parts)`
- **Injectable event source** — `run(deliver, eventSource?, initialParts?)` accepts an optional external `AsyncIterable<LabeledEvent>` (e.g. `SseMultiplexer`); if provided, iterates that instead of the internal `EventMultiplexer`; used by the client-side agent runtime
- **Initial parts** — optional `initialParts` parameter on `run()` delivers content before entering the event loop; used by the CLI runtime to prompt agent to call `join_room()`
- **Remote room connections** — `connectRemoteRoom(dataSource, roomName, mode?, identifier?)` registers a room via a `RoomDataSource` (no local Room/Channel); paired with `disconnectRemoteRoom(roomId)` for cleanup
- **Content buffer** — per-room `BufferedContent[]`; content events accumulate between triggers; flushed alongside the next trigger
- **Event queue** — events arriving during delivery are queued; drained as a batch after delivery completes; LangGraph consumer also supports mid-loop injection via `drainInjectBuffer()` (events seen during tool calls included in the next LLM round)
- **Processing lock** — `_processing` boolean prevents concurrent deliveries
- **Seen-event cache** — `EventTracker._deliveredIds` tracks event IDs the consumer has seen; exposed via `isEventSeen()` / `markEventsSeen()` for MCP tools; clears on compaction and stop
- **Event ID deduplication** — `EventTracker._processedIds` tracks raw event UUIDs at entry; prevents duplicate delivery; self-clears at 500 entries; resets on `stop()`
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs; LCG generator `(n × 6337) % 10000` for non-sequential refs; exposed via `assignRef()` / `resolveRef()` for MCP tools
- **Inline mode labels** — non-`everyone` rooms show mode in brackets: `[lobby — people]`; `everyone` rooms carry no annotation
- **Hot connect/disconnect** — rooms can be added/removed while running via `connectRoom()` / `connectRemoteRoom()` / `disconnectRoom()` / `disconnectRemoteRoom()`
- **Silent connect/disconnect** — `Room.connect(…, silent: true)` and `channel.disconnect(silent: true)` suppress join/leave events
- **Mode changes** — `setModeForRoom()` / `getModeForRoom()` delegate to the engagement strategy; emit `ActivityEvent` with `action: "mode_changed"`
- **Initial mode broadcast** — `connectRoom()` emits the initial mode-changed event to the room channel
- **Consumer hooks** — `onContextCompacted()` clears seen-event cache and ref map; `emitToolUse()` routes `ToolUseEvent` to the triggering room; `currentContextRoomId` getter for stats attribution
- **preQuery hook** — called before each delivery; return false to abort (used for credit caps)

#### MCP Servers

- **Full MCP server** (`createFullMcpServer()`) — for app-path consumers (ClaudeSession, LangGraphSession); returns `{ url, instance, stop }`; HTTP + SDK transport; 4 tools: `catch_up`, `search_by_text`, `search_by_message`, `send_message`
- **Runtime MCP server** (`createRuntimeMcpServer()`) — for CLI agent runtime; local proxy that routes tool calls to remote stoop servers via HTTP; returns `{ url, stop }`
- **Runtime tools** (always present): `stoops__catch_up(room?)`, `stoops__search_by_text(room, query)`, `stoops__search_by_message(room, ref)`, `stoops__send_message(room, content)`, `stoops__set_mode(room, mode)`, `stoops__join_room(url, alias?)`, `stoops__leave_room(room)`
- **Runtime admin tools** (with `--admin` flag): `stoops__admin__set_mode_for(room, participant, mode)`, `stoops__admin__kick(room, participant)`
- **Rich `join_room` response** — returns onboarding with identity, mode + description, person, participant list, and recent activity via `buildCatchUpLines()`; `MODE_DESCRIPTIONS` map provides one-liner mode explanations
- **Callback-based routing** — runtime MCP server accepts `onJoinRoom`, `onLeaveRoom`, `onSetMode`, `onAdminSetModeFor`, `onAdminKick` callbacks; the agent runtime wires these to HTTP calls to the right stoop server

#### Tool Handlers

- **Pure functions** — `handleCatchUp`, `handleSearchByText`, `handleSearchByMessage`, `handleSendMessage`; take a `RoomResolver` and options, return structured results
- **`buildCatchUpLines()`** — builds catch-up snapshot from unseen events; used by MCP tools and `join_room` response
- **`resolveOrError()`** — room name resolution with error fallback message
- **`formatMsgLine()`** — formats a single message as a transcript line with refs, replies, and image markers
- **`ToolHandlerOptions`** — shared type for tool handler and MCP server option parameters; extracted from `ProcessorBridge`

#### Types (`agent/types.ts`)

- **`LLMSessionOptions`** — extends `AgentIdentity` (selfId, identity, apiKey), `ProcessorBridge` (isEventSeen, markEventsSeen, assignRef, resolveRef, onContextCompacted, onToolUse), and `SessionCallbacks` (onQueryComplete, resolveParticipantIdentifier, autoCompactPct); backward-compatible union
- **`ToolHandlerOptions`** — `Pick<ProcessorBridge, "isEventSeen" | "markEventsSeen" | "assignRef" | "resolveRef">`; shared by tool handlers and MCP server

#### RoomDataSource

- **`RoomDataSource` interface** — uniform interface for reading/writing room data: `listParticipants()`, `getMessage()`, `searchMessages()`, `getMessages()`, `getEvents()`, `sendMessage()`, optional `emitEvent()`
- **`LocalRoomDataSource`** — wraps Room + Channel for in-process access; used by app-path consumers and local EventProcessor connections
- **`RemoteRoomDataSource`** — wraps HTTP calls to a stoop server; used by the CLI agent runtime
  - Participant cache: `setParticipants()`, `addParticipant()`, `removeParticipant()` — seeded from join response, updated from SSE events
  - `setSelf(id, name)` — sets own identity so `sendMessage()` stub returns correct sender fields
  - All data access via server HTTP API: `GET /message/:id`, `GET /search`, `GET /messages`, `GET /events/history`, `POST /message`, `POST /event`
- **Tool handlers use `conn.dataSource.*`** — not `conn.room.*` directly; makes them work transparently against both local and remote rooms

#### Event Multiplexer

- **`EventMultiplexer`** — merges N channel async iterators into one `LabeledEvent` stream; used by app-path EventProcessor
- **`LabeledEvent`** — `{ roomId, roomName, event }`
- **Dynamic** — `addChannel()` / `removeChannel()` while running; `close()` to shut down

#### SSE Multiplexer

- **`SseMultiplexer`** — merges N SSE connections into one `AsyncIterable<LabeledEvent>` stream; used by CLI agent runtime
- **SSE parsing** — `fetch()` POST with streaming response body; parses `data:` lines from SSE format; POST required (Cloudflare Quick Tunnels buffer GET streaming)
- **Auth** — session token sent via `Authorization: Bearer` header (not query param)
- **Per-connection lifecycle** — `AbortController` per connection; reconnection with exponential backoff (1s → 30s max)
- **Dynamic** — `addConnection(serverUrl, sessionToken, roomName, roomId)` / `removeConnection(roomId)` while running; `close()` to shut down all

#### Prompts

- **`SYSTEM_PREAMBLE`** — shared protocol instructions for app-path agents; CLI agents learn the protocol progressively through tool descriptions and `join_room` responses instead
- **`MODE_DESCRIPTIONS`** — one-liner descriptions for each engagement mode used in `join_room` responses and `set_mode` tool; e.g. `"people": "Human messages are pushed to you. Agent messages are delivered as context."`
- **`getSystemPreamble(identifier?, personParticipantId?)`** — prepends an identity block if the agent has an identifier or person; used by app-path consumers
- **`formatEvent()`** — converts a typed `RoomEvent` into compact one-liner `ContentPart[]`; returns `null` for noise events (ToolUse, Activity, ReactionRemoved, ContextCompacted)
  - Messages: `"[14:23:01] #3847 [lobby] Alice: hey everyone"` — ref before room, no type labels
  - Replies: `"[14:23:01] #9102 [lobby] Alice (→ #3847 Bob): good point"` — ref-based, no quoted content
  - Multiline: continuation lines prefixed with `[room]` aligned under content start (grapheme-aware padding)
  - Images: native `{ type: "image", url }` ContentPart alongside text
  - Mentions: `"[14:23:01] #5521 [lobby] ⚡ Alice: @bot what do you think?"`
  - Reactions: `"[14:23:01] [lobby] Alice reacted ❤️ to #3847"` — ref-based target
  - Joins: `"[14:23:01] [lobby] + Alice joined"`
  - Leaves: `"[14:23:15] [lobby] - Alice left"`
- **Image-aware agent context** — image messages surfaced as native vision content blocks (`{ type: "image", url }`) in real-time events; tool outputs (`catch_up`, `search`) embed image URLs inline as `[[img:URL]]` text markers
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

- `event-processor.test.ts` — 51 tests: room connections, dedup, mode management, catch-up building, content buffering, processing lock, RoomResolver, compaction, ref map
- `engagement.test.ts` — 59 tests: 52 `classifyEvent()` covering all modes and edge cases + 7 `StoopsEngagement` class tests
- `room.test.ts` — 39 tests: connect/disconnect, message sending, @mention detection, observer behavior, pagination, event broadcasting
- `format-event.test.ts` — 29 tests: compact one-liner format, reply context, reactions, images, room labels, refs, null returns
- `tool-handlers.test.ts` — 18 tests: room resolution, message formatting, catch-up building, search by text, search by message (before/after, ref resolution, unknown anchor)
- `multiplexer.test.ts` — 12 tests: channel add/remove, close, interleaving, labeled events
- `ref-map.test.ts` — 8 tests: assignment idempotency, resolution, collision handling, clear/reset
- `session-langgraph.test.ts` — 4 tests (1 skipped): module exports, session creation, MCP server
- `session-claude.test.ts` — 4 tests: module exports, session creation, temp directory, SDK loading
- `tmux-bridge.test.ts` — 20 tests: state detection heuristics for idle, typing, dialog (single-select, multi-select, plan approval, review/submit), permission, streaming, unknown, and priority ordering

---

### CLI (`typescript/src/cli/`)

#### Architecture

The CLI separates **server** from **client**. The server (`stoops serve`) is a dumb room server — one room, HTTP API, SSE broadcasting, authority enforcement. No EventProcessor, no tmux, no agent lifecycle. Humans join via `stoops join`, which opens a TUI client over HTTP. Agents join via `stoops run claude` or `stoops run opencode`, which run a client-side agent runtime (EventProcessor, SSE listener, engagement engine, local MCP proxy, pluggable delivery). Agent-agnostic setup is shared in `runtime-setup.ts`; each runtime only provides its delivery mechanism. This separation means the server is simple and everything smart runs client-side.

The bare `stoops` command (no subcommand) is a convenience shortcut: it starts the server then immediately joins it locally as admin, opening the TUI — one command for the common case.

#### Auth (`auth.ts`)

- **`TokenManager`** — manages share tokens and session tokens
  - Share tokens: random hex, stored in `Map<hash, AuthorityLevel>`; embedded in URLs, map to an authority tier
  - Session tokens: random hex, stored in `Map<token, {participantId, authority}>`; issued on join, used for all API calls
  - `generateShareToken(callerAuthority, targetAuthority)` — enforces tier ordering (can only generate at own tier or below)
  - `validateShareToken()`, `createSessionToken()`, `validateSessionToken()`, `revokeSessionToken()`, `findSessionByParticipant()`
- **`buildShareUrl(baseUrl, token)`** — constructs share URL with `?token=` query param
- **`extractToken(url)`** — extracts token from URL query string

#### `stoops` (bare) command (`index.ts`)

- **Host + join in one command** — starts the server with `quiet: true`, waits for it to be ready, then calls `join()` with admin share token
- **Admin token join** — host joins via `buildShareUrl(serverUrl, adminToken)` so they get admin authority
- **Share URL display** — participant share URL passed to TUI as `shareUrl` for banner display (uses tunnel URL if `--share`)
- **`getAllFlags("join")`** — collects all values for repeatable `--join` flag; accepts optional array parameter for scoped parsing
- **`getFlag()` / `getAllFlags()`** — accept optional `arr` parameter to parse a specific array instead of global `args`; used by `run` commands to parse only stoops flags (before `--`)
- **`--` passthrough** — `run claude` and `run opencode` split on `--`; stoops flags before, tool-specific args after
- **Flag bug fix** — `getFlag()` rejects values starting with `--`

#### `stoops serve` command (`serve.ts`)

- **Dumb room server** — one room, one HTTP API, SSE broadcasting, authority enforcement; no EventProcessor, no tmux, no agent lifecycle
- **Token-based auth** — all endpoints validate session tokens via `getSession()` helper; share tokens validated on join
- **Returns `ServeResult`** — `{ serverUrl, publicUrl, roomName, adminToken, participantToken }` after server is ready
- **Boot** — generates admin + participant share tokens; prints URLs with `stoops join`, `stoops run claude` (with manual join instruction), and `stoops run opencode --join` commands
- **`--headless` flag** — suppresses all output; emits one JSON line `{ serverUrl, publicUrl, roomName, adminToken, participantToken }` for scripted use
- **HTTP API** on configurable port (default 7890):
  - `POST /join` — accepts `{ token, name?, type? }`; validates share token → determines authority; creates participant (admin/participant) or observer; returns `{ sessionToken, participantId, roomName, roomId, participants, authority }`
  - `POST /events` — SSE stream; auth via `Authorization: Bearer <token>` header; sends last 50 events as history then streams live; enriches `MessageSent` with `_replyToName`; POST required for Cloudflare tunnel real-time flushing
  - `POST /message` — `{ token, content, replyTo? }`; 403 if observer
  - `GET /participants?token=<session>` — participant list with authority
  - `GET /message/:id?token=<session>` — single message lookup
  - `GET /messages?token=<session>&count&cursor` — paginated messages
  - `GET /events/history?token=<session>&category&count&cursor` — paginated events
  - `GET /search?token=<session>&query&count&cursor` — keyword search
  - `POST /event` — `{ token, event }` — emit event (for ToolUse, Activity, ContextCompacted)
  - `POST /set-mode` — `{ token, participantId?, mode }` — self for own, admin for others
  - `POST /kick` — `{ token, participantId }` — admin only
  - `POST /share` — `{ token, authority? }` — generate share links at requested tier
  - `POST /disconnect` — `{ token }` — works for all participant types; legacy `participantId`/`agentId` fallback
- **Two participant maps** — `participants` (ConnectedParticipant with authority + channel + sessionToken), `observers` (ConnectedObserver)
- **Reverse lookup** — `idToSession` map for participant ID → session token lookup
- **Graceful shutdown** — kills tunnel, closes SSE, disconnects all participants

#### `stoops join` command (`join.ts`)

- **TUI client** — connects to any stoops server over HTTP with token-based auth
- **Token extraction** — `extractToken()` pulls share token from URL; stripped to get clean server URL
- **Flow**: extract token → `POST /join` with token → get sessionToken + authority → start TUI → connect SSE → stream events → cleanup
- **Authority-aware** — observer authority → `readOnly` mode in TUI
- **Slash commands** — `/` prefix in `onSend` is intercepted and dispatched to command handlers:
  - `/who` — `GET /participants`, renders participant table with type and authority
  - `/leave` — disconnects and exits
  - `/kick <name>` — admin only; looks up participant by name, `POST /kick`
  - `/mute <name>` — admin only; sets target to `standby-everyone` via `POST /set-mode`
  - `/wake <name>` — admin only; sets target to `everyone` via `POST /set-mode`
  - `/setmode <name> <mode>` — admin only; sets specific mode via `POST /set-mode`
  - `/share [--as tier]` — generates share links via `POST /share`; observers blocked
- **System events** — slash command output rendered as `{ kind: "system" }` DisplayEvent
- **SSE uses Authorization header** — `POST /events` with `Authorization: Bearer <sessionToken>`
- **Messages use session token** — `POST /message` with `{ token: sessionToken, content }`
- **`RoomEvent` → `DisplayEvent` conversion** — `toDisplayEvent()` handles MessageSent, ParticipantJoined/Left, Activity (mode_changed)
- **Participant type tracking** — maintains `participantTypes` map from initial list + join/leave SSE events
- **Share info output** — prints copyable commands for invite, Claude Code connect, and OpenCode connect before TUI renders
- **Graceful disconnect** — `POST /disconnect` with session token on Ctrl+C/SIGINT/SIGTERM
- **`--headless` flag** — skips TUI; streams raw `RoomEvent` JSON lines to stdout, reads messages from stdin

#### TUI (`tui.tsx`)

- **Ink-based terminal UI** — React components rendered via ink; used by `stoops join`
- **5 DisplayEvent kinds** — `message`, `join`, `leave`, `mode`, `system` (new: for slash command output)
- **`TUIHandle` interface** — `push(event)`, `setAgentNames(names)`, `stop()`; events queued before mount, drained on `onReady`
- **Custom input** — replaced `ink-text-input` with a single `useInput` handler for full control; supports multi-line messages via Option+Enter (⌥↵); continuation lines indented with `"  "` prefix; block cursor at end
- **Read-only mode** — when `readOnly` is true or `onSend` is undefined, hides input and shows "watching as guest"
- **Banner** — Figlet "slant" font with purple→cyan gradient; room name only (share info printed to stdout before Ink starts for copyability)
- **Message feed** — `<Static>` items rendered once (selectable terminal text)
- **Color system** — stoops-app palette; agents get rotating color + deterministic sigil
- **System events** — rendered in `C.secondary` color for slash command output
- **Slash command autocomplete** — two-phase completion system: (1) typing `/` shows filtered command list with param hints (e.g. `/kick <name>`, `/setmode <name> <mode>`) and descriptions; (2) after completing a command, suggests parameter values — participant names for `<name>` params (dynamically tracked from join/leave events), engagement modes for `<mode>` param. Ghost text hints show unfilled params inline after the cursor. Arrow keys navigate, Tab completes, Enter completes (or submits directly for no-param commands), Escape dismisses; admin-only commands hidden for non-admins; 7 commands: `/who`, `/leave`, `/share`, `/kick`, `/mute`, `/wake`, `/setmode`
- **Ctrl+C handling** — ink's default exit disabled; custom `useInput` handler calls `onCtrlC`
- **No resize handler** — removed to prevent Ink `<Static>` cursor miscalculation and screen corruption on terminal resize; divider width updates naturally on next state change

#### Shared runtime setup (`cli/runtime-setup.ts`)

- **`setupAgentRuntime(options)`** — agent-agnostic setup shared by `run claude` and `run opencode`; returns `AgentRuntimeSetup` with processor, SSE mux, MCP server, wrapped source, initialParts, and cleanup function
- **Flow**: generate agent name → store `--join` URLs as pending (no HTTP join yet) → create empty SSE mux → create EventProcessor with empty selfId → create RuntimeMcpServer → wrap SSE source → build startup event → return setup
- **`initialParts`** — used by OpenCode path only; Claude Code ignores it (`joinUrls: undefined` passed from `run.ts`) since auto-injecting via tmux had timing issues
- **No auto-join** — rooms are NOT joined during setup; agent calls `join_room()` via MCP tool; `onJoinRoom` handles HTTP join + SSE registration + EventProcessor connection + sets selfId on first join; 15s timeout on the join fetch with a clear error message on failure
- **`AgentRuntimeOptions`** — `joinUrls?`, `name?`, `admin?`, `extraArgs?`, `headless?` — `--join` is optional; no `--room`/`--server` legacy flags
- **`JoinResult`** — per-room join state: serverUrl, sessionToken, participantId, roomName, roomId, authority, participants, dataSource
- **`AgentRuntimeSetup`** — returned by setup: agentName, joinResults (mutable, starts empty), initialParts, processor, sseMux, mcpServer, wrappedSource, cleanup()
- **Startup event** — if `--join` URLs provided, `initialParts` = `"Use join_room(\"<url>\") to connect."` (single) or bulleted list (multiple); delivered before event loop via `processor.run()`
- **Runtime MCP callbacks** — `onSetMode` sets mode locally + `POST /set-mode` to server; `onJoinRoom` does full join mid-session and returns rich onboarding response (identity, mode, person, participants, recent activity); `onLeaveRoom` disconnects from room; `onAdminSetModeFor` and `onAdminKick` routed to server
- **SSE participant tracking** — wraps the SseMultiplexer to intercept ParticipantJoined/Left events and update RemoteRoomDataSource participant caches
- **Cleanup** — stops EventProcessor, SseMultiplexer, MCP server; `POST /disconnect` to all servers

#### `stoops run claude` command (`cli/claude/run.ts`)

- **Claude Code agent runtime** — thin wrapper over `setupAgentRuntime()` adding tmux-specific delivery
- **Flow**: check `tmuxAvailable()` → `setupAgentRuntime(options)` → write stdio bridge + MCP config → create tmux session → launch `claude --mcp-config <path> <extraArgs>` → create TmuxBridge → `processor.run(bridge.deliver, wrappedSource)` → wait for startup → tmux attach → cleanup
- **No `--join` flag** — Claude Code agents join rooms manually; user tells the agent the URL, agent calls `join_room()`. Removed because tmux send-keys injection had timing issues.
- **Stdio MCP bridge** — Claude Code's HTTP MCP transport triggers OAuth on localhost (hangs forever). Instead, a tiny CJS bridge script is written to temp dir; Claude spawns it as a stdio subprocess; bridge proxies JSON-RPC → HTTP to the runtime MCP server. Uses `process.execPath` for the node binary to avoid PATH issues in tmux sessions.
- **tmuxAttach modes** — outside tmux: `spawn("tmux attach")` which keeps the event loop free; inside tmux (`$TMUX` set): `switch-client` + polls `has-session` every 500ms until session ends (switch-client exits immediately, so naive Promise resolution would trigger cleanup too early)
- **Passthrough args** — everything after `--` forwarded to the `claude` command (e.g. `-- --model sonnet`)
- **TmuxBridge delivery** — state-aware injection via `TmuxBridge.deliver()`; events delivered as plain text (no XML wrapping)
- **`--headless` flag** — skips tmux entirely; delivers formatted events as plain text to stdout; prints MCP server URL to stderr; MCP tools callable directly via HTTP for scripted testing
- **Cleanup** — stops TmuxBridge, `setup.cleanup()`, kills tmux session, removes temp directory

#### TmuxBridge (`cli/claude/tmux-bridge.ts`)

- **State-aware event injection** — reads Claude Code's TUI screen via `tmux capture-pane`, detects UI state, applies the right injection strategy
- **6 TUI states detected** — `idle` (inject now), `typing` (Ctrl+U/inject/Ctrl+Y), `dialog` (queue), `permission` (queue), `streaming` (queue), `unknown` (queue — safe default)
- **`detectStateFromLines(lines)`** — pure function for heuristic state detection; checks last ~15 lines of screen for known patterns:
  - Dialog: `"Enter to select"`, `"Esc to cancel"`, `"Ready to code?"`, `"Review your answers"`, `"ctrl+g to edit in"`
  - Permission: `"(Y)"`, `"Allow "`, `"Deny "`
  - Streaming: spinner characters `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`
  - Idle/typing: prompt char `❯`/`›` with `❯❯`/`››` footer
- **`deliver(parts)`** — drop-in replacement for EventProcessor's deliver callback; converts ContentPart[] to text, injects via state-appropriate strategy
- **`injectWhileTyping(text)`** — Ctrl+U (cuts user's input to kill ring) → inject event + Enter → Ctrl+Y (restores user's text); user sees a brief flicker at worst
- **Event queue** — events that can't be injected (dialog, permission, streaming, unknown states) are queued; a polling timer (200ms) drains them one-at-a-time when the state becomes safe
- **No `waitForReady`** — startup uses a 2-second delay; TmuxBridge queues events until Claude is idle, so exact readiness detection isn't needed
- **Design doc** — full exploration of alternatives and rationale at `docs/claude-code-tmux-bridge.md`

#### `stoops run opencode` command (`cli/opencode/run.ts`) ⚠️ in progress

- **OpenCode agent runtime** — thin wrapper over `setupAgentRuntime()` using OpenCode's HTTP API for delivery; no tmux needed
- **Flow**: `setupAgentRuntime(options)` → pick random port (14096-15095) → spawn `opencode serve --port <port> <extraArgs>` with `OPENCODE_CONFIG_CONTENT` env to inject stoops MCP → poll `/session/status` until ready (30s timeout) → build deliver callback → `processor.run(deliver, wrappedSource)` → block until child exits or Ctrl+C → cleanup
- **`OPENCODE_CONFIG_CONTENT` env** — injects stoops MCP server config at launch: `{"mcp":{"stoops":{"type":"remote","url":"<mcp-url>","oauth":false}}}`; no temp files, no cleanup needed
- **Session detection** — when `onRoomJoined` fires, queries `GET /session` (sorted by `time.updated` desc), checks top 3 sessions' messages for `stoops__` tool parts; stores `roomId → sessionId` mapping; unreliable with multiple concurrent sessions (see `docs/opencode-session-detection.md`)
- **Deliver callback** — `POST /session/:id/message` with `{ parts: [{ type: "text", text }] }`; synchronous (blocks until LLM finishes) to preserve EventProcessor's processing lock
- **Passthrough args** — everything after `--` forwarded to the `opencode serve` command
- **No tmux** — pure HTTP API integration; user opens OpenCode in browser
- **Cleanup** — kills child process, `setup.cleanup()`

#### tmux helpers (`tmux.ts`)

- All functions sanitize session names (`sanitizeSessionName()` replaces `.`, `:`, `$`, `%` with `_`) to prevent tmux target misinterpretation
- All functions use `execFileSync` (args as array, no shell interpolation)
- `tmuxAvailable()` — check if tmux is installed
- `tmuxSessionExists(session)` — check if a session exists
- `tmuxCreateSession(session)` — create detached session with no status bar
- `tmuxSendCommand(session, command)` — type a command + press Enter
- `tmuxInjectText(session, text)` — inject literal text (no Enter)
- `tmuxSendEnter(session)` — send Enter key
- `tmuxCapturePane(session)` — capture visible screen content as array of lines
- `tmuxSendKey(session, key)` — send a control key sequence (e.g. `C-u`, `C-y`, `Escape`); no `-l` flag so tmux interprets key names
- `tmuxAttach(session)` — async attach; outside tmux uses `spawn("tmux attach")` to keep event loop free; inside tmux uses `switch-client` + polls `has-session` until session ends
- `tmuxKillSession(session)` — kill session (safe if already dead)

#### Agent event delivery

- **Shared path**: Stoop Server → SSE → SseMultiplexer → EventProcessor (engagement classify → buffer/trigger) → deliver callback
- **Claude Code delivery**: deliver → TmuxBridge (state detection → inject/queue) → Claude Code via tmux
  - TmuxBridge reads screen via `capture-pane` before each injection to detect TUI state
  - Safe injection: idle → direct inject; user typing → Ctrl+U/inject/Ctrl+Y; unsafe states → queue and poll
- **OpenCode delivery**: deliver → `POST /session/:id/message` → OpenCode via HTTP API
  - Synchronous POST (blocks until LLM finishes) preserves processing lock semantics
  - OpenCode handles internal queuing if busy — no client-side state detection needed
- Events delivered as plain text — compact one-liners, no XML wrapping (both paths)
- Content events buffered and flushed with next trigger (same as app path)
- EventProcessor runs client-side — engagement, buffering, formatting all local

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
- **~~tmux input collision~~** — resolved: TmuxBridge detects TUI state via `capture-pane` and applies state-appropriate injection (Ctrl+U/Ctrl+Y for user typing, queue for dialogs/streaming).
- **~~Claude Code readiness~~** — resolved: TmuxBridge.waitForReady() polls `capture-pane` for the `❯` prompt instead of using a hardcoded delay.
- **Images in tool results** — `[[img:URL]]` text markers still used in MCP tool output; native vision blocks only work in real-time event injection, not in catch_up/search results.
- **Engagement mode count** — 8 modes internally, but the v3 UX design exposes 4 active modes + standby as an orthogonal toggle. Should the internal model simplify to match, or keep 8 for power users?
