# Architecture

Where the core is heading. Written Feb 2026.

---

## The shift

v2 treated core as an agent runtime — it wraps an LLM, manages its session, calls `session.process()`. The framework owns the agent.

v3 flips this. Core is **infrastructure that agents plug into**. It has two plugin points:

1. **MCP servers** — tools the agent calls (catch_up, send_message, search, etc.)
2. **Event channel** — a bridge that pushes classified room events into the agent's context

The agent is external. It could be a Claude Code session, a Codex session, a LangGraph graph, or anything that speaks MCP. The framework doesn't own it — it serves it.

---

## Two plugin points

### MCP servers (agent → world)

Standard MCP tools. The agent calls them to interact with rooms:

- `catch_up(room)` — read what you missed
- `send_message(room, content)` — speak in a room
- `search_by_text(room, query)` — find past messages

These are request-response. Any MCP-compatible agent can use them.

For the CLI path, MCP tools are replaced by file reads + one CLI command. See `cli.md`.

### Event channel (world → agent)

When an agent joins a room, the engagement model classifies events and the bridge pushes them into the agent's context. The engagement model (trigger/content/drop) controls what reaches the agent and when. The bridge handles the last mile.

```
Room  ──events──►  Engagement Model  ──classified──►  Bridge  ──inject──►  Agent
                   (trigger/content/drop)              (per-platform)
```

---

## Bridge interface

Each bridge answers one question: **how do you push text into this agent?**

### Current: ILLMSession

The v2 interface. The runtime calls `session.process(parts)` with formatted content. The session owns the LLM lifecycle.

```typescript
interface ILLMSession {
  start(): Promise<void>
  stop(): Promise<void>
  process(parts: ContentPart[]): Promise<void>
  setApiKey(key: string): void
}
```

Two implementations exist: `ClaudeSession` (Claude Agent SDK) and `LangGraphSession` (@langchain/*).

### Target: Bridge

The v3 interface. Simpler — three methods, no session lifecycle management.

```typescript
interface Bridge {
  start(config: {
    systemPrompt: string
    mcpServers: McpConfig[]
  }): Promise<void>

  deliver(parts: ContentPart[]): Promise<void>

  stop(): Promise<void>
}
```

Per-platform implementations:

- **`claude()`** — headless Claude Agent SDK. Pushes events via `session.send()`.
- **`tui()`** — tmux bridge. Spawns `claude` in a tmux session, pushes events via `tmux send-keys` wrapped in `<room-event>` tags. The user sees the full Claude Code terminal.
- **`langgraph()`** — injects events as `HumanMessage` into graph state.

---

## The TUI bridge (`stoops run claude`)

The most interesting bridge. Goal: `stoops run claude` feels exactly like typing `claude` in your terminal, but room events get injected behind the scenes.

How it works:

1. `stoops run claude` creates a tmux session running `claude` with stoops MCP attached
2. User sees the normal Claude Code TUI — types normally, approves tools, everything
3. Room events arrive → bridge injects via `tmux send-keys -l`:
   ```
   <room-event>[Kitchen] 👤 Rue: hey what's up (#a1b2)</room-event>
   ```
4. Claude Code receives it as input, processes it alongside whatever the user is doing

Input collision is not a real problem because:
- The injection is atomic (one `send-keys` call, milliseconds)
- XML tags make events unambiguous
- Most of the time the user is reading, not typing

---

## The protocol preamble

When an agent joins a room, it needs to immediately understand how to participate. The preamble teaches:

- Event format: `[RoomName] 👤 Name: message (#ref)`
- What refs are (short message IDs for replies and search)
- What modes mean (everyone/people/stoops/me + standby)
- Available tools and when to use them
- When to respond vs stay quiet
- Multi-room behavior (events labeled by room)

No personality. No character writing. No behavioral coaching beyond "here's how rooms work." The agent's existing personality handles the rest.

---

## What core owns

### Stays from v2

- **Room / Channel / Events** — shared spaces, per-participant connections, typed event system
- **Engagement classification** — `classifyEvent()` returns `trigger | content | drop` per mode
- **Event loop** — multiplexer, content buffering, processing lock, queue drain
- **MCP tool handlers** — catch_up, search, send_message (pure functions)
- **Seen-event cache** — `Set<string>` tracking which events the LLM has seen
- **RefMap** — bidirectional 4-digit refs ↔ message UUIDs
- **Storage interface** — `StorageProtocol` with injectable adapters
- **Event formatting** — `formatEvent()` turns raw events into `ContentPart[]`

### Changes from v2

- **`StoopRuntime`** — still runs the event loop, but calls `bridge.deliver()` instead of `session.process()`. Runtime manages engagement, buffering, formatting. Bridge manages delivery.
- **`ILLMSession`** — replaced by the simpler `Bridge` interface.
- **Protocol preamble** — pure protocol, no personality guidance.

### Dies from v2

- **`ClaudeSession` / `LangGraphSession` as core concepts** — become bridge implementations
- **Personality/character management** — moved entirely to app layer
- **Compaction hooks, tool turn tracking, token counting** — platform-specific, live in bridges

---

## What's not in core (app layer)

- Stoop personalities and character writing
- The "person" assignment UX (who owns which stoop)
- Credit tracking and billing
- Room creation UI, invite links
- User authentication
- Display names, handles
- Trace logging
