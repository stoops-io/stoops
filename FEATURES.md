# Stoops Features

What's built, what works, what's planned. This is the source of truth for the framework's current state.

---

## Core (`typescript/src/core/`)

### Room

- **Room** — shared real-time space; all participants connect via channels and receive events
- **`Room.connect(participantId, name, type?, identifier?, subscribe?, silent?)`** — creates a `Channel` for a participant; `silent: true` suppresses the `ParticipantJoined` event (used for agent reconnects); supports optional `identifier` for @mention matching; reconnects disconnect the old channel automatically
- **`Room.observe()`** — returns a `Channel` that receives every room event including targeted `MentionedEvent`s directed at other participants; observers are excluded from `listParticipants()` and don't emit join/leave events; disconnect via `observer.disconnect()`
- **`Room.listParticipants()`** — returns all connected participants (observers excluded)
- **`Room.listMessages(count, cursor)`** — paginated message history, newest-first
- **`Room.searchMessages(query, count, cursor)`** — keyword search across message content, newest-first
- **`Room.listEvents(category?, count?, cursor?)`** — paginated event history, optionally filtered by category
- **`Room.getMessage(messageId)`** — O(1) lookup for reply context resolution
- **@mention detection** — `_detectMentions()` scans message content for `@name` and `@identifier` patterns (case-insensitive); emits targeted `MentionedEvent` to the mentioned participant's channel only

### Channel

- **Channel** — per-participant bidirectional connection with event filtering
- **Event categories** — `MESSAGE`, `PRESENCE`, `ACTIVITY`, `MENTION`; channels subscribe to categories and only receive matching events
- **`channel.sendMessage(content, options?)`** — send a message in the room; supports `replyToId` and image attachments (`imageUrl`, `imageMimeType`, `imageSizeBytes`)
- **`channel.emit(event)`** — emit an arbitrary event to the room
- **`channel.updateSubscriptions(categories)`** — change which event categories this channel receives
- **`channel.disconnect(silent?)`** — disconnect from the room; `silent: true` suppresses `ParticipantLeft` event
- **Async iteration** — `for await (const event of channel)` reads events as they arrive
- **`channel.receive(timeoutMs?)`** — pull one event with optional timeout

### Events

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

### Storage

- **`StorageProtocol` interface** — `addMessage`, `getMessage`, `getMessages`, `searchMessages`, `addEvent`, `getEvents`; injectable for production adapters
- **`InMemoryStorage`** — reference implementation; `getMessage(roomId, messageId)` for O(1) reply lookup
- **Pagination helpers** — `paginate()` (ID-based cursor) and `paginateByIndex()` (index-based cursor)
- **All queries newest-first** — `next_cursor` continues backwards through history

### Types

- **`Message`** — Zod-validated schema: id, room_id, sender_id, sender_name, content, reply_to_id, image_url, image_mime_type, image_size_bytes, timestamp
- **`Participant`** — id, name, status, type (`"human"` | `"stoop"`), optional `identifier`
- **`PaginatedResult<T>`** — items, next_cursor, has_more

---

## Agent (`typescript/src/agent/`)

### Engagement

- **`EngagementStrategy` interface** — `classify(event, roomId, selfId, senderType, senderId) → "trigger" | "content" | "drop"`; optional `getMode?()`, `setMode?()`, `onRoomDisconnected?()` for strategies with per-room state
- **`StoopsEngagement` class** — built-in strategy implementing the 8-mode system; maintains per-room mode state internally
- **8 engagement modes** — 4 active + 4 standby:
  - `everyone` — any message triggers (human + stoop)
  - `people` — human messages trigger; stoop messages buffered as content
  - `stoops` — stoop messages trigger; human messages buffered as content
  - `me` — only the agent's person's messages trigger
  - `standby-everyone` — any @mention triggers; everything else dropped
  - `standby-people` — human @mentions only
  - `standby-stoops` — stoop @mentions only
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

### EventProcessor

- **Core event loop** — one processor = one agent = N room connections; delivery is pluggable via `run(deliver)` callback
- **Implements `RoomResolver`** — resolves room names/identifiers/IDs to live connections
- **Event flow**: `EventMultiplexer` → `_handleLabeledEvent()` → engagement classify → trigger/content/drop → `deliver(parts)`
- **Content buffer** — per-room `BufferedContent[]`; content events accumulate between triggers; flushed alongside the next trigger; includes age timestamps ("3s ago")
- **Event queue** — events arriving during delivery are queued; drained as "While you were responding, this happened: ..." batch after delivery completes; LangGraph consumer also supports mid-loop injection via `drainInjectBuffer()` (events seen during tool calls included in the next LLM round)
- **Processing lock** — `_processing` boolean prevents concurrent deliveries
- **Seen-event cache** — `Set<string>` of event IDs the consumer has seen; populated when events pass engagement classification (trigger or content); exposed via `isEventSeen()` / `markEventsSeen()` for MCP tools; clears on compaction and stop
- **Event ID deduplication** — separate `_seenEventIds` set tracks raw event UUIDs at entry; prevents duplicate delivery; self-clears at 500 entries; resets on `stop()`
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs; LCG generator `(n × 6337) % 10000` for non-sequential refs; exposed via `assignRef()` / `resolveRef()` for MCP tools
- **Inline mode labels** — non-`everyone` rooms show mode in brackets: `[lobby — people]`; `everyone` rooms carry no annotation
- **Startup full catch-up** — on `run()`, `buildFullCatchUp()` lists every room with mode, participants, and unseen event lines; injected as the first delivery; re-injected post-compaction via `_needsFullCatchUp`
- **Hot connect/disconnect** — rooms can be added/removed while running; on connect, agent receives "You've been added to [Room Name]" notification; notifications queued during delivery are drained after
- **Silent connect/disconnect** — `Room.connect(…, silent: true)` and `channel.disconnect(silent: true)` suppress join/leave events
- **Mode changes** — `setModeForRoom()` / `getModeForRoom()` delegate to the engagement strategy; emit `ActivityEvent` with `action: "mode_changed"`
- **Initial mode broadcast** — `connectRoom()` emits the initial mode-changed event to the room channel
- **Consumer hooks** — `onContextCompacted()` clears caches and schedules catch-up rebuild; `emitToolUse()` routes `ToolUseEvent` to the triggering room; `currentContextRoomId` getter for stats attribution
- **preQuery hook** — called before each delivery; return false to abort (used for credit caps)

### MCP Server

- **One server per stoop** — `createStoopsMcpServer()` returns `{ url, instance, stop }`
- **HTTP + SDK transport** — `StreamableHTTPServerTransport` on a random localhost port for URL-based clients; raw `McpServer` instance for Claude SDK in-process shortcut
- **4 tools**:
  - `catch_up(room)` — returns unseen events oldest-first; marks returned events as seen in the cache
  - `search_by_text(room, query, count?, cursor?)` — keyword search with 1 message of context before/after each match
  - `search_by_message(room, ref, direction?, count?)` — scroll around a specific message by ref
  - `send_message(room, content, reply_to_id?)` — send a message to the room

### Tool Handlers

- **Pure functions** — `handleCatchUp`, `handleSearchByText`, `handleSearchByMessage`, `handleSendMessage`; take a `RoomResolver` and options, return structured results
- **`buildCatchUpLines()`** — builds catch-up snapshot from unseen events; used by both the MCP tool and the runtime's startup injection
- **`resolveOrError()`** — room name resolution with error fallback message
- **`formatMsgLine()`** — formats a single message as a transcript line with refs, replies, and image markers

### Event Multiplexer

- **`EventMultiplexer`** — merges N channel async iterators into one `LabeledEvent` stream
- **`LabeledEvent`** — `{ roomId, roomName, event }`
- **Dynamic** — `addChannel()` / `removeChannel()` while running; `close()` to shut down

### Prompts

- **`SYSTEM_PREAMBLE`** — shared protocol instructions for all stoops: event format, reply format, @mention format, memory model ("no persistent memory between sessions"), person relationship ("their messages carry more weight"), all 8 engagement modes with behavioral semantics; `everyone` mode instructs stoops to respond independently (don't defer because another stoop already answered)
- **Selective reply threading** — `send_message` tool description coaches restraint: "only thread when it adds clarity in busy multi-person conversations; DMs and conversational back-and-forth should use fresh messages"
- **`getSystemPreamble(identifier?, personParticipantId?)`** — prepends an identity block if the agent has an identifier or person
- **`formatEvent()`** — converts a typed `RoomEvent` into `ContentPart[]` for the LLM; returns `null` for noise events (ToolUse, Activity, ReactionRemoved)
  - Messages: `"[HH:MM:SS] [Room] 👤 Name: content (#XXXX)"` with 4-digit decimal ref
  - Replies: `"👤 Name (→ Other: "quoted..."): reply (#XXXX)"` with sender name and truncated content resolved via `getMessage()`
  - Images: native `{ type: "image", url }` ContentPart alongside text
  - Mentions: `"⚡ [Room] 👤 Name mentioned you: content"`
  - Reactions: `"👤 Name reacted ❤️ to your message "quoted...""` or `"to Other's "quoted...""` with target message context
  - Joins/leaves: `"👤 Name joined/left the chat"`
  - Compaction: `"🤖 Name's memory was refreshed"`
- **Image-aware agent context** — image messages surfaced as native vision content blocks (`{ type: "image", url }`) in real-time events; tool outputs (`catch_up`, `search`) embed image URLs inline as `[[img:URL]]` text markers (vision blocks not supported in tool results yet)
- **`participantLabel()`** — `👤 Name` for humans, `🤖 Name` for stoops
- **`contentPartsToString()`** — flattens `ContentPart[]` back to plain text (for trace logs)

---

## Claude Consumer (`typescript/src/claude/`)

- **`ClaudeSession`** — implements `ILLMSession` using `@anthropic-ai/claude-agent-sdk`; used as the `deliver` callback target for `EventProcessor.run()`
- **Persistent context** — uses `query()` with `resume: sessionId` so context accumulates across evaluations
- **Temp directory isolation** — `mkdtempSync` in `/tmp/stoops_agent_*` per session
- **SDK configuration** — `permissionMode: "bypassPermissions"`, `settingSources: []` (clean slate), no subagents
- **BYOK support** — API key passed via `env` per query call (not `process.env`)
- **Configurable auto-compaction** — `autoCompactPct` option on `LLMSessionOptions`; Claude passes via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env per query; suggested tier defaults: Lite 50%, Classic 70%, Premium 90%
- **MCP server** — creates its own via `createStoopsMcpServer()`; registered as `{ type: 'sdk', instance }` for in-process communication (no HTTP overhead)
- **Hooks** — `PreToolUse` (records tool_use turn, calls onToolUse), `PostToolUse` (records tool_result turn)
- **`PreCompact` hook** — fires before SDK compaction; injects factual state block (identity + per-room mode/participant counts from `resolver.listAll()`); `onContextCompacted` callback triggers EventProcessor to clear caches, emit `ContextCompactedEvent`, and rebuild catch-up
- **Stats extraction** — parses SDK result message for cost, tokens, duration; computes `contextPct` as `(inputTokens + cacheReadInputTokens) / contextWindow` clamped to [0, 100]; reports via `onQueryComplete`

---

## LangGraph Consumer (`typescript/src/langgraph/`)

- **`LangGraphSession`** — implements `ILLMSession` using `@langchain/*` packages; used as the `deliver` callback target for `EventProcessor.run()`
- **Optional dependency** — validates LangChain imports at construction time; errors clearly if packages missing
- **Token pricing table** — cost approximation for Claude (Sonnet/Haiku/Opus), GPT-4o, o3, Gemini models
- **Context window sizes** — per-model context limits for compaction threshold calculation
- **Token-based compaction detection** — checks `usage_metadata.input_tokens` after each agent round; fires `onContextCompacted` when `autoCompactPct` threshold is exceeded
- **MCP server** — creates its own via `createStoopsMcpServer()`; LangGraph connects via HTTP URL (not in-process)
- **StateGraph** — `inject` → `agent` → `tools` nodes for mid-loop event injection via `drainEventQueue`
- **Model flexibility** — any LangChain-compatible model (Anthropic, OpenAI, Google)

---

## Tests

- 219 tests passing, 1 skipped (LangGraph integration)
- `event-processor.test.ts` — 55 tests: room connections, dedup, mode management, catch-up building, content buffering, processing lock, hot-connect, RoomResolver, compaction, ref map
- `engagement.test.ts` — 59 tests: 52 `classifyEvent()` covering all modes and edge cases + 7 `StoopsEngagement` class tests
- `room.test.ts` — 39 tests: connect/disconnect, message sending, @mention detection, observer behavior, pagination, event broadcasting
- `format-event.test.ts` — 30 tests: all 12 event types, reply context, reactions, images, room labels, refs, null returns
- `tool-handlers.test.ts` — 13 tests: room resolution, message formatting, catch-up building, search results
- `multiplexer.test.ts` — 12 tests: channel add/remove, close, interleaving, labeled events
- `ref-map.test.ts` — 8 tests: assignment idempotency, resolution, collision handling, clear/reset
- `session-langgraph.test.ts` — 4 tests (1 skipped): module exports, session creation, MCP server

---

## CLI (`typescript/src/cli/`)

### `stoops` command (`serve.ts`)

- **Room server** — creates in-memory room (`InMemoryStorage`), holds all state in one process
- **HTTP API** on configurable port (default 7890):
  - `POST /join` — agent registers, gets assigned ID, MCP URL, temp directory; server creates `EventProcessor` and room channel per agent
  - `POST /connect` — agent reports tmux session name; server starts `EventProcessor.run()` with tmux delivery
  - `POST /disconnect` — agent teardown; stops processor, disconnects channel
  - `/mcp?agent=<id>` — per-agent MCP endpoint with `send_message` + `snapshot_room` tools
- **Human participant** — readline stdin for chat input; messages sent via a human channel
- **Live event log** — room observer prints all events to stdout (joins, leaves, messages, mode changes)
- **Per-agent EventProcessor** — engagement model, content buffering, event formatting all run in the server process; delivery via `tmux send-keys` to the agent's tmux session
- **Graceful shutdown** — Ctrl+C disconnects all agents and human, closes HTTP server

### `stoops run claude` command (`run-claude.ts`)

- **Thin client** — registers with stoops server, sets up tmux + MCP, blocks, cleans up on exit
- **Flow**: `POST /join` → `claude mcp add --transport http` → create tmux session → `POST /connect` → `tmux attach` (blocks) → cleanup
- **tmux session** — invisible (status bar off); launches `claude` inside; named `stoops_<room>_<name>`
- **MCP config** — added to Claude Code via `claude mcp add --scope user`; removed on exit via `claude mcp remove`
- **Stale session cleanup** — kills pre-existing tmux session with same name before creating new one
- **Preflight checks** — verifies tmux is installed, server is reachable

### tmux helpers (`tmux.ts`)

- `tmuxAvailable()` — check if tmux is installed
- `tmuxSessionExists(session)` — check if a session exists
- `tmuxCreateSession(session)` — create detached session with no status bar
- `tmuxSendCommand(session, command)` — type a command + press Enter
- `tmuxInjectText(session, text)` — inject literal text (no Enter); uses `execFileSync` to avoid shell injection
- `tmuxAttach(session)` — blocking attach
- `tmuxKillSession(session)` — kill session (safe if already dead)
- `tmuxWaitForReady(session, marker, timeout)` — poll pane content for a readiness marker

### CLI MCP tools

- **`send_message(content, reply_to?)`** — posts a message via the agent's room channel; reply_to uses #ref resolved via server-side RefMap
- **`snapshot_room()`** — writes room event history to `/tmp/stoops_<agentId>/<room>.log` in grep-friendly format; returns path + search tips; header block with participants and event count; each call overwrites (always fresh)

### Event delivery

- Events flow: Room → EventProcessor (engagement classify → buffer/trigger) → `tmux send-keys` injection
- Injected as `<room-event>...</room-event>` XML-tagged text
- No processing lock — server doesn't track when Claude Code is done thinking; events inject as classified
- Content events buffered and flushed with next trigger (same as app path)

---

## Not Yet Built

### Python Implementation

- `python/` has project skeleton only (`pyproject.toml`, empty packages)
- No implementation yet

---

## Open Questions

- **Multiplexer teardown** — does `run()` exit cleanly when all rooms disconnect, or does it hang on the merged async iterator?
- **RefMap overflow** — when the map overflows between compactions, should we force a context compaction? SDK may not expose a direct `compact()` call.
- **tmux input collision** — user typing + event arriving simultaneously; XML tags should make events unambiguous but needs real testing.
- **Claude Code readiness** — after `tmux send-keys 'claude' Enter`, how long until Claude Code is ready to receive injected events? Need a delay or readiness check before the first injection.
- **Images in tool results** — `[[img:URL]]` text markers still used in MCP tool output; native vision blocks only work in real-time event injection, not in catch_up/search results.
- **Engagement mode count** — 8 modes internally, but the v3 UX design exposes 4 active modes + standby as an orthogonal toggle. Should the internal model simplify to match, or keep 8 for power users?
