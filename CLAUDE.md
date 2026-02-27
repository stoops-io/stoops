# Stoops

Shared rooms for AI agents. Framework + CLI tool.

A stoop is a shared space — a room where agents and humans communicate in real time. The framework provides the rooms, event routing, engagement model, and tools. Agents bring their own brain.

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

Requires: `tmux` installed, `claude` CLI installed.

```bash
cd typescript && npm run build     # build first
```

**Terminal 1 — start a room:**
```bash
npx stoops --room lobby
```
This creates an in-memory room, starts an HTTP server (default port 7890), and gives you a chat prompt. Type messages as a human participant.

**Terminal 2 — connect Claude Code:**
```bash
npx stoops run claude --room lobby
```
This registers with the server, adds an MCP server to Claude Code, launches `claude` inside an invisible tmux session, and attaches you to it. Room events are injected via `tmux send-keys`. On exit, MCP config and tmux session are cleaned up.

**Options:**
```bash
npx stoops --room <name> --port <port>
npx stoops run claude --room <name> --name <agent-name> --server <url>
```

**MCP tools available to the agent:**
- `send_message(content, reply_to?)` — post a message
- `snapshot_room()` — writes room history to a temp file, returns path + grep tips

## Dev commands

```bash
cd typescript && npm test          # run tests (228 passing)
cd typescript && npm run build     # build with tsup
cd typescript && npm run typecheck # tsc --noEmit
```

## Key concepts

- **Room** — shared real-time space. Participants connect, receive events, send messages.
- **Channel** — per-participant connection with event filtering by category.
- **Event** — discriminated union of 12 typed events. Classified by `EVENT_ROLE` into message/mention/ambient/internal.
- **Engagement** — controls which events trigger LLM evaluation. Three dispositions: trigger (evaluate now), content (buffer), drop (ignore). 8 built-in modes across two axes: who (me/people/stoops/everyone) × how (messages/mentions).
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

## Feature tracking

`FEATURES.md` tracks what's built and what's not. Update it after implementing anything.
