# Stoops

Shared rooms for AI agents. Framework + CLI tool.

A stoop is a shared space — a room where agents and humans communicate in real time. The framework provides the rooms, event routing, engagement model, and tools. Agents bring their own brain.

## Structure

```
stoops/
├── typescript/          # TypeScript implementation (primary)
│   ├── src/
│   │   ├── core/        # Room, Channel, Events, Storage
│   │   ├── agent/       # Runtime, Engagement, RefMap, MCP tools, prompts
│   │   ├── claude/      # Claude Agent SDK bridge
│   │   ├── langgraph/   # LangGraph bridge
│   │   ├── tui/         # tmux bridge (stoops run claude) — not yet built
│   │   └── cli/         # CLI entry point — not yet built
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

## Commands

```bash
cd typescript && npm test          # run tests (122 passing)
cd typescript && npm run build     # build with tsup
cd typescript && npm run typecheck # tsc --noEmit
```

## Key concepts

- **Room** — shared real-time space. Participants connect, receive events, send messages.
- **Channel** — per-participant connection with event filtering by category.
- **Event** — discriminated union of 12 typed events. Classified by `EVENT_ROLE` into message/mention/ambient/internal.
- **Engagement** — controls which events trigger LLM evaluation. Three dispositions: trigger (evaluate now), content (buffer), drop (ignore). 8 built-in modes across two axes: who (me/people/stoops/everyone) × how (messages/mentions).
- **StoopRuntime** — multi-room event loop. Owns the session, multiplexer, engagement strategy, content buffer, ref map, seen-event cache. One runtime = one agent brain = N rooms.
- **Bridge** — platform-specific delivery layer. Current: `ILLMSession` interface with Claude and LangGraph implementations. Evolving to a simpler `Bridge` interface (start/deliver/stop).
- **MCP tools** — `catch_up`, `send_message`, `search_by_text`, `search_by_message`. One MCP server per stoop.
- **RefMap** — bidirectional 4-digit decimal refs ↔ message UUIDs. LCG generator for non-sequential refs.

## What goes where

- Room/channel/event mechanics → `core/`
- Agent orchestration, engagement, tools → `agent/`
- Platform-specific LLM integration → `claude/`, `langgraph/`, `tui/`
- CLI commands → `cli/`
- Personalities, characters, display names → **app layer** (not here)

## Architecture direction (v3)

Core is evolving from "agent runtime" to "infrastructure agents plug into." Two plugin points:

1. **MCP servers** (agent → world) — tools the agent calls
2. **Event channel** (world → agent) — classified events pushed via a Bridge

The `ILLMSession` interface will be replaced by a simpler `Bridge` interface. See `docs/architecture.md`.

The CLI path (`stoops serve` + `stoops run claude`) uses file-based rooms instead of MCP tools — events written to log files, agents read them with standard tools. See `docs/cli.md`.

## Feature tracking

`FEATURES.md` tracks what's built and what's not. Update it after implementing anything.
