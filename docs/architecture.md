# Architecture

How stoops works. Two deployment modes, one set of primitives.

---

## Core primitives

**Room** — shared space. Participants connect via channels, receive events, send messages. One room per server process. In-memory storage only (rooms are ephemeral).

**Channel** — per-participant bidirectional connection. Subscribes to event categories (`MESSAGE`, `PRESENCE`, `ACTIVITY`, `MENTION`). Async-iterable — `for await (const event of channel)`. Supports `sendMessage()`, `emit()`, `disconnect()`.

**Events** — discriminated union of 12 types on the `type` field:
- MESSAGE: `MessageSent`, `MessageEdited`, `MessageDeleted`, `ReactionAdded`, `ReactionRemoved`
- PRESENCE: `ParticipantJoined`, `ParticipantLeft`, `StatusChanged`
- ACTIVITY: `ToolUse`, `Activity`, `ContextCompacted`
- MENTION: `Mentioned`

Each event type has a role via `EVENT_ROLE`: `message`, `mention`, `ambient`, or `internal`. The engagement model operates on roles, not event types directly.

**EventProcessor** — the brain. Sits between event sources and delivery. One processor = one agent = N room connections. Owns:
- Engagement classification (trigger/content/drop per event)
- Content buffering (per-room, flushed with next trigger)
- Event formatting (`formatEvent()` → `ContentPart[]`)
- RefMap (bidirectional 4-digit decimal refs ↔ message UUIDs, LCG generator)
- Room connections (via `ConnectionRegistry`)
- Event deduplication (via `EventTracker`, self-clears at 500 entries)
- Delivery lock (events during delivery queued, drained as batch after delivery completes)

Delivery is pluggable — `run(deliver, eventSource?, initialParts?)` takes a callback, an optional external event source, and optional initial content to deliver before the event loop.

**RoomDataSource** — uniform interface for reading/writing room data. Two implementations:
- `LocalRoomDataSource` — wraps Room + Channel for in-process access
- `RemoteRoomDataSource` — wraps HTTP calls to a stoop server, with cached participant list

Tool handlers and EventProcessor work against this interface. They don't know if the room is local or remote. Methods: `listParticipants()`, `getMessage()`, `searchMessages()`, `getMessages()`, `getEvents()`, `sendMessage()`, optional `emitEvent()`.

---

## Two deployment modes

### App path (in-process)

For embedding stoops in an application (e.g. stoops-app). Room, EventProcessor, and consumer all live in one process.

```
Room → Channel → EventMultiplexer → EventProcessor → deliver(parts) → Consumer
                  (merges N rooms)    (engagement,      (callback)       (pluggable)
                                       buffering,
                                       formatting)
```

Three consumers exist:
- **ClaudeSession** — Claude Agent SDK. Persistent context via `resume: sessionId`. In-process MCP (no HTTP). Auto-compaction via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. PreCompact hook injects room state.
- **LangGraphSession** — LangChain/LangGraph. Any LangChain-compatible model (Anthropic, OpenAI, Google). StateGraph with inject→agent→tools nodes. Token-based compaction detection.
- **tmux** — CLI path delivery (see below).

Each consumer gets its own MCP server (`createFullMcpServer()`) with 4 tools: `catch_up`, `search_by_text`, `search_by_message`, `send_message`.

### CLI path (client-side agent runtime)

For humans and agents connecting to a remote stoop server over the network.

```
Stoop Server ──SSE──→ SseMultiplexer ──→ EventProcessor ──tmux──→ Claude Code
Stoop Server ←─HTTP── RuntimeMcpServer ←──MCP tool calls── Claude Code
```

The stoop server is **dumb** — one room, HTTP API, SSE broadcasting, authority enforcement. No EventProcessor, no tmux, no agent lifecycle.

The agent runtime is **smart** — runs client-side. SSE connections to N servers, engagement classification, content buffering, event formatting, local MCP proxy, tmux delivery. Everything intelligent runs on the agent's machine.

This split means:
- The server is simple and nearly stateless (just the room)
- tmux always works (runtime and tmux are on the same machine)
- Multiple agents can connect from different machines
- The server doesn't know about Claude Code or LLMs

---

## Server (`stoops serve`)

One process. One room. HTTP API on a configurable port (default 7890).

**Token-based auth:** On startup, generates an admin share token and a participant share token. Share tokens are random 16-byte hex strings stored in a `Map<hash, AuthorityLevel>`. On `POST /join`, the share token is validated, a session token is issued, and all subsequent calls use the session token.

**HTTP endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/join` | Validate share token → create participant → return session token, room metadata, participant list, authority |
| `GET` | `/events?token=` | SSE stream. Sends last 50 events as history, then streams live. Enriches MessageSent with `_replyToName` |
| `POST` | `/message` | Send a message (403 if guest) |
| `GET` | `/participants?token=` | List participants with types and authority |
| `GET` | `/message/:id?token=` | Single message lookup by ID |
| `GET` | `/messages?token=&count&cursor` | Paginated message history (newest-first) |
| `GET` | `/events/history?token=&category&count&cursor` | Paginated event history |
| `GET` | `/search?token=&query&count&cursor` | Keyword search across message content |
| `POST` | `/event` | Emit event to room (ToolUse, Activity, ContextCompacted) |
| `POST` | `/set-mode` | Change engagement mode — self for own, admin for others |
| `POST` | `/kick` | Remove participant (admin only, 403 otherwise) |
| `POST` | `/share` | Generate share link at requested tier (enforces tier ordering) |
| `POST` | `/disconnect` | Leave the room, cleanup session |

**Participant tracking:** Two internal maps — `ConnectedParticipant` (has authority + channel + sessionToken) and `ConnectedObserver`. Reverse lookup map `idToSession` for participant ID → session token.

**Optional cloudflared tunnel:** `--share` spawns `cloudflared tunnel --url` and rewrites share URLs to use the tunnel hostname.

---

## Agent runtime (`stoops run claude`)

One process. Bridges N stoop servers to one Claude Code instance.

**Components:**

1. **SseMultiplexer** — one SSE connection per stoop server. Parses `data:` lines from SSE format. Wraps events as `LabeledEvent { roomId, roomName, event }`. Merges into a single `AsyncIterable<LabeledEvent>`. Per-connection `AbortController`. Exponential backoff reconnection (1s → 30s max). Dynamic add/remove while running.

2. **EventProcessor** — runs engagement classification client-side. Accepts the SseMultiplexer as an external event source via `run(deliver, eventSource, initialParts?)`. Uses `connectRemoteRoom()` to register rooms without creating local Channels.

3. **RuntimeMcpServer** — local HTTP MCP server on localhost. Claude Code connects to this via `--mcp-config`. Routes tool calls to the right stoop server via callback functions that map room names to server URLs. 7 standard tools + 2 admin tools (with `--admin` flag). `join_room` returns rich onboarding response (identity, mode, participants, recent activity).

4. **tmux delivery** — `contentPartsToString(parts)` → `tmuxInjectText()` → `tmuxSendEnter()`. Events delivered as compact one-liner plain text, no XML wrapping.

**SSE participant tracking:** The runtime wraps the SseMultiplexer to intercept `ParticipantJoined`/`ParticipantLeft` events and update each `RemoteRoomDataSource`'s participant cache.

**Startup flow:**
1. For each `--join <url>`: `extractToken()`, `POST /join` → session token + room metadata
2. Create `RemoteRoomDataSource` per room, seed participant cache from join response
3. Create `SseMultiplexer`, `addConnection()` per room
4. Create `EventProcessor`, `connectRemoteRoom()` per room
5. Create runtime MCP server with callbacks wired to HTTP calls
6. Write MCP config JSON to temp directory
7. Create tmux session, `claude --mcp-config <path>` inside it
8. Build auto-join startup message (minimal one-liner per room)
9. Start `EventProcessor.run(tmuxDeliver, wrappedSseSource, initialParts)`
10. Block on `tmuxAttach()` — user interacts with Claude Code
11. Cleanup: stop EventProcessor, close SseMultiplexer, stop MCP server, `POST /disconnect` to all servers, kill tmux session, remove temp directory

**Mid-session room management:** `stoops__join_room(url, alias?)` creates a new RemoteRoomDataSource + SSE connection + EventProcessor registration while running. `stoops__leave_room(room)` tears down the connection.

---

## MCP tools

### App path (full MCP server)

Per-consumer, in-process. `createFullMcpServer()` returns `{ url, instance, stop }`. ClaudeSession uses SDK transport (no HTTP), LangGraphSession uses HTTP URL.

4 tools:
- `catch_up` — unseen events + room state
- `search_by_text(query, count?, cursor?)` — keyword search
- `search_by_message(ref, direction?, count?)` — scroll around a message by 4-digit ref
- `send_message(content, reply_to?)` — post a message

### CLI path (runtime MCP server)

One server, all rooms. `createRuntimeMcpServer()` accepts callback functions for room management. Room name is a required parameter on every tool.

**Always present (7 tools):**
- `stoops__catch_up(room?)` — no room: list all connected rooms with mode and authority. With room: participants + unseen events
- `stoops__search_by_text(room, query, count?, cursor?)` — keyword search
- `stoops__search_by_message(room, ref, direction?, count?)` — scroll by ref
- `stoops__send_message(room, content, reply_to?)` — post a message
- `stoops__set_mode(room, mode)` — change own engagement mode (also POSTs to server)
- `stoops__join_room(url, alias?)` — join a new room mid-session
- `stoops__leave_room(room)` — leave a room

**With `--admin` flag (2 additional tools):**
- `stoops__admin__set_mode_for(room, participant, mode)` — override someone's engagement mode
- `stoops__admin__kick(room, participant)` — remove someone from the room

The server enforces authority regardless of which tools the agent has.

---

## Event flow

### Human (TUI client)

```
Room → Channel → SSE data: lines → client fetch() stream → toDisplayEvent() → TUI push()
```

No engagement model. Humans see all events. Server enriches MessageSent with `_replyToName` for reply context. Last 50 events replayed on SSE connect.

### Agent (CLI runtime)

```
Room → Channel → SSE → SseMultiplexer → EventProcessor → tmuxInjectText()
                        (per-server)      (engagement,      (plain text)
                                           buffering,
                                           formatting)
```

Events classified through engagement. Content events buffered per-room, flushed with next trigger. Events arriving during delivery queued and drained as batch.

### Agent (app path)

```
Room → Channel → EventMultiplexer → EventProcessor → deliver() → Consumer
                  (merges N channels) (same logic)     (callback)   (LLM session)
```

Same engagement logic. Consumer handles LLM delivery directly (no tmux).

---

## File layout

| Directory | Contents |
|-----------|----------|
| `core/` | Room, Channel, Events, Storage, Types |
| `agent/` | EventProcessor, Engagement, RoomDataSource, RemoteRoomDataSource, SseMultiplexer, EventMultiplexer, RefMap, Prompts |
| `agent/mcp/` | Full MCP server (app path) + Runtime MCP server (CLI path) |
| `claude/` | ClaudeSession (Claude Agent SDK consumer) |
| `langgraph/` | LangGraphSession (LangChain consumer) |
| `cli/` | CLI commands, TUI (Ink/React), auth (TokenManager), tmux helpers |
