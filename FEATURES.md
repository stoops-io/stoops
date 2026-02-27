# Stoops Features

What's built, what works, what's planned. This is the source of truth for the framework's current state.

---

## Core (`typescript/src/core/`)

### Room

- **Room** — shared real-time space; all participants connect via channels and receive events
- **`Room.connect(id, name, type, options?)`** — creates a `Channel` for a participant; `silent: true` suppresses the `ParticipantJoined` event (used for agent reconnects); supports optional `identifier` on the participant
- **`Room.observe()`** — returns a `Channel` that receives every room event including targeted `MentionedEvent`s directed at other participants; observers are excluded from `listParticipants()` and don't emit join/leave events; disconnect via `observer.disconnect()`
- **`Room.listParticipants()`** — returns all connected participants; accepts optional `excludeIds` array to filter synthetic entries (e.g. `__observer__`)
- **`Room.listMessages(count, cursor)`** — paginated message history, newest-first
- **`Room.searchMessages(query, count, cursor)`** — keyword search across message content, newest-first
- **`Room.listEvents(category?, count?, cursor?)`** — paginated event history, optionally filtered by category
- **`Room.getMessage(messageId)`** — O(1) lookup for reply context resolution
- **@mention detection** — `_detectMentions()` scans message content for `@name` and `@identifier` patterns (case-insensitive); emits targeted `MentionedEvent` to the mentioned participant's channel only
- **`RoomOptions.onMention` callback** — optional callback invoked when any participant is mentioned; used by app layer to forward mention events to external systems (replaces hardcoded `__observer__` forwarding)
- **`excludeParticipantIds`** — runtime option to filter synthetic participants from listings

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
- **`ToolUseEvent`** — emitted twice per tool call: `status: "started"` before, `status: "completed"` after
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

### StoopRuntime

- **Multi-room event loop** — one runtime = one LLM session = N room connections
- **Implements `RoomResolver`** — resolves room names/identifiers/IDs to live connections
- **Event flow**: `EventMultiplexer` → `_handleLabeledEvent()` → engagement classify → trigger/content/drop
- **Content buffer** — per-room `BufferedContent[]`; content events accumulate between triggers; flushed alongside the next trigger in a single `_processRaw()` call; includes age timestamps ("3s ago")
- **Event queue** — events arriving during `_processing` are queued; drained as "While you were responding, this happened: ..." batch after the current evaluation completes; LangGraph backend also supports mid-loop injection via `drainEventQueue` (events seen during tool calls included in the next LLM round)
- **Processing lock** — `_processing` boolean prevents concurrent LLM evaluations
- **Seen-event cache** — `Set<string>` of event IDs the LLM has seen; populated when events pass engagement classification (trigger or content) and when `catch_up` returns events; used by MCP tools to avoid showing redundant events; clears on compaction (LLM loses context) and runtime restart
- **Event ID deduplication** — separate `_seenEventIds` set tracks raw event UUIDs at the entry point of `_handleLabeledEvent`; prevents duplicate delivery if the same event arrives twice; self-clears at 500 entries; resets on `stop()`
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs; LCG generator `(n × 6337) % 10000` for non-sequential refs; used in event formatting and tool results
- **Inline mode labels** — non-`everyone` rooms show mode in brackets: `[Kitchen — people]`; `everyone` rooms carry no annotation; startup prompt lists each room with its mode; hot-connect and mode-change notifications use bare mode names
- **Startup full catch-up** — on `run()`, `_buildFullCatchUp()` lists every room with its mode and stable ref, shows participants (excluding self and configurable `excludeParticipantIds`) and unseen event lines for active rooms, shows `(standby — @mentions only)` for standby rooms; injected as the first `_processRaw()` call; same snapshot re-injected post-compaction via `_needsFullCatchUp`
- **Hot connect/disconnect** — rooms can be added/removed while running; on connect, stoop receives "You've been added to [Room Name]" with history; notifications queued during `_processing` are drained after evaluation (not dropped)
- **Silent connect/disconnect** — `Room.connect(…, silent: true)` and `channel.disconnect(silent: true)` suppress `ParticipantJoined`/`ParticipantLeft` events; used by runtime reconnects, server restore, and observer channel
- **Mode changes** — `setModeForRoom()` / `getModeForRoom()` delegate to the engagement strategy; emit `ActivityEvent` with `action: "mode_changed"`
- **Initial mode broadcast** — `connectRoom()` emits the initial `Activity` mode-changed event to the room channel so activity logs always show the starting mode
- **Activity event routing** — `ToolUseEvent` is routed to the room that triggered the current evaluation, not broadcast to all rooms
- **preQuery hook** — called before each evaluation; return false to abort (used for credit caps)
- **ParticipantActivated/Deactivated** — emitted to the room during evaluation so UIs can show "thinking" indicators

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
- **`MODE_REMINDERS`** — per-mode label strings for room labels
- **`contentPartsToString()`** — flattens `ContentPart[]` back to plain text (for trace logs)

---

## Claude Bridge (`typescript/src/claude/`)

- **`ClaudeSession`** — implements `ILLMSession` using `@anthropic-ai/claude-agent-sdk`
- **Persistent context** — uses `query()` with `resume: sessionId` so context accumulates across evaluations
- **Temp directory isolation** — `mkdtempSync` in `/tmp/stoops_agent_*` per session
- **SDK configuration** — `permissionMode: "bypassPermissions"`, `settingSources: []` (clean slate), no subagents
- **BYOK support** — API key passed via `env` per query call (not `process.env`)
- **Configurable auto-compaction** — `autoCompactPct` option on `LLMSessionOptions` and `StoopRuntimeOptions`; Claude passes via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env per query; suggested tier defaults: Lite 50%, Classic 70%, Premium 90%
- **MCP server** — registered as `{ type: 'sdk', instance }` for in-process communication (no HTTP overhead)
- **Hooks** — `PreToolUse` (records tool_use turn, calls onToolUse), `PostToolUse` (records tool_result turn)
- **`PreCompact` hook** — fires before SDK compaction; injects factual state block (stoop identity + per-room mode/participant counts from `resolver.listAll()`) and instructs the stoop to write a concise arc summary (ongoing threads, decisions, participant notes); `onContextCompacted` callback clears the seen-event cache and ref map, emits `ContextCompactedEvent`, sets `_needsFullCatchUp`; after the compacting query completes, runtime injects a fresh `_buildFullCatchUp()` snapshot
- **Stats extraction** — parses SDK result message for cost, tokens, duration; computes `contextPct` as `(inputTokens + cacheReadInputTokens) / contextWindow` clamped to [0, 100]; included in `LLMQueryStats`; reports via `onQueryComplete`

---

## LangGraph Bridge (`typescript/src/langgraph/`)

- **`LangGraphSession`** — implements `ILLMSession` using `@langchain/*` packages
- **Optional dependency** — validates LangChain imports at construction time; errors clearly if packages missing
- **Token pricing table** — cost approximation for Claude (Sonnet/Haiku/Opus), GPT-4o, o3, Gemini models
- **Context window sizes** — per-model context limits for compaction threshold calculation
- **Token-based compaction detection** — checks `usage_metadata.input_tokens` after each agent round; fires `onContextCompacted` when `autoCompactPct` threshold is exceeded
- **HTTP MCP server** — LangGraph connects to stoops tools via URL (not in-process)
- **StateGraph** — `inject` → `agent` → `tools` nodes for mid-loop event injection via `drainEventQueue`
- **Model flexibility** — any LangChain-compatible model (Anthropic, OpenAI, Google)

---

## Tests

- 122 tests passing, 1 skipped (LangGraph integration)
- `engagement.test.ts` — 59 tests: 52 `classifyEvent()` covering all modes and edge cases + 7 `StoopsEngagement` class tests
- `room.test.ts` — 39 tests: connect/disconnect, message sending, @mention detection, observer behavior, pagination, event broadcasting
- `tool-handlers.test.ts` — 13 tests: room resolution, message formatting, catch-up building, search results
- `ref-map.test.ts` — 8 tests: assignment idempotency, resolution, collision handling, clear/reset
- `session-langgraph.test.ts` — 4 tests (1 skipped): startup, processing, token pricing

---

## Not Yet Built

### CLI (`src/cli/`)

- `stoops serve` — room server process (rooms as files, HTTP for connections)
- `stoops run claude` — tmux bridge: full Claude Code TUI with room events injected

### TUI Bridge (`src/tui/`)

- tmux session management for Claude Code integration
- Event injection via `tmux send-keys`
- XML-tagged event format: `<room-event>...</room-event>`

### File-Based Rooms

- `events.log` — append-only log per room, grep-friendly format
- `participants.json` — runtime-maintained participant state
- `info.json` — room metadata (name, mode, identifier)
- `media/` — image files referenced from event log
- `stoops send` CLI command — the one outbound interaction tool
- Replaces MCP tools with standard file reading (tail, grep, cat)

### Bridge Interface (v3)

- `Bridge` — replaces `ILLMSession`; three methods: `start(config)`, `deliver(parts)`, `stop()`
- `claude()` — headless Claude SDK bridge
- `tui()` — tmux bridge for Claude Code TUI
- `langgraph()` — LangGraph bridge

### Room Server

- `npx stoops serve --rooms kitchen,lounge --port 3456`
- For CLI path: rooms run as a service that MCP servers and bridges connect to
- For programmatic path: rooms are in-process (no server needed)

### Python Implementation

- `python/` has project skeleton only (`pyproject.toml`, empty packages)
- No implementation yet

---

## Open Questions

- **Multiplexer teardown** — does `run()` exit cleanly when all rooms disconnect, or does it hang on the merged async iterator?
- **RefMap overflow** — when the map overflows between compactions, should we force a context compaction? SDK may not expose a direct `compact()` call.
- **Log rotation** — `events.log` grows unboundedly; compaction is the natural truncation point, but file rotation strategy is TBD.
- **Concurrency** — multiple stoops appending to the same room log file; file locking vs per-stoop views?
- **Nudge granularity** — does "new activity" cause the agent to always cat the whole log? Probably include the new line but agent can pull more.
- **tmux input collision** — user typing + event arriving simultaneously; XML tags should make events unambiguous but needs real testing.
- **Security scope of bash** — stoop gets bash access scoped to `.data/rooms/` only; need to verify SDK sandbox options.
- **SDK Read tool + vision** — confirmed it supports images but needs verification inside a scoped cwd.
- **Images in tool results** — `[[img:URL]]` text markers still used in MCP tool output; native vision blocks only work in real-time event injection, not in catch_up/search results.
- **Engagement mode count** — 8 modes internally, but the v3 UX design exposes 4 active modes + standby as an orthogonal toggle. Should the internal model simplify to match, or keep 8 for power users?
