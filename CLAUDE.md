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
- Three tiers: `admin` > `member` > `guest`
- Share links encode authority — anyone with the link joins at that tier
- Admins can kick, change others' modes, generate share links at any tier
- Members can send messages, change own mode, generate member/guest links
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
- `stoops__admin__mute(room, participant)` — admin only, demote to guest
- `stoops__admin__unmute(room, participant)` — admin only, restore to member

**TUI slash commands:**
- `/who` — list participants with types and authority
- `/leave` — disconnect
- `/kick <name>` — admin: remove a participant
- `/mute <name>` — admin: demote to guest (read-only)
- `/unmute <name>` — admin: restore to member
- `/setmode <name> <mode>` — admin: set specific mode
- `/share [--as admin|member|guest]` — generate share links

## Dev commands

```bash
cd typescript && npm test          # run tests (266 passing)
cd typescript && npm run build     # build with tsup
cd typescript && npm run typecheck # tsc --noEmit
```

### Headless mode

All three CLI commands support `--headless` for scriptable, terminal-free operation:

- `stoops serve --headless` — emits a single JSON line `{ serverUrl, publicUrl, roomName, adminToken, memberToken }` then runs silently. No banner, no logs.
- `stoops join <url> --headless` — skips the TUI; streams raw `RoomEvent` JSON lines to stdout, reads messages from stdin (one line per send).
- `stoops run claude --headless` — skips tmux; delivers formatted events as plain text to stdout. The MCP server URL is printed to stderr so tool calls can be made directly via HTTP.

Together these make it possible to drive a full room scenario from a script: start a server, parse its tokens, connect an agent runtime, send messages as a human participant, and inspect what the agent received — all without a terminal or tmux. The `--headless` agent runtime runs the full stack (EventProcessor, SSE multiplexer, engagement engine, MCP server) with only the last-mile delivery swapped out.

## Key concepts

- **Room** — shared real-time space. Participants connect, receive events, send messages.
- **Channel** — per-participant connection with event filtering by category.
- **Event** — discriminated union of 12 typed events. Classified by `EVENT_ROLE` into message/mention/ambient/internal.
- **Engagement** — controls which events trigger LLM evaluation. Three dispositions: trigger (evaluate now), content (buffer), drop (ignore). 6 active modes across two axes: who (people/agents/everyone) × how (messages/mentions). 2 additional modes (`me`, `standby-me`) exist in core for the app path but are disabled in the CLI runtime (no `personParticipantId`).
- **EventProcessor** — core event loop. Owns the multiplexer, engagement strategy, content buffer, event queue, ref map, room connections. Delivery is pluggable — `run(deliver)` takes a callback. One processor = one agent = N rooms.
- **Consumer** — platform-specific delivery. `ILLMSession` interface with Claude and LangGraph implementations. The CLI path uses tmux injection (Claude Code) or HTTP API (OpenCode). Consumers own their own lifecycle (session creation, MCP servers, compaction, stats).
- **Authority** — three tiers: `admin` > `member` > `guest`. Set on join via share token. Controls what actions are permitted (MCP tools, slash commands). Orthogonal to engagement.
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
