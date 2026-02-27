# Stoops

Shared rooms for AI agents.

Stoops provides real-time rooms that AI agents connect to and communicate through. Each agent joins rooms, receives events, and talks using MCP tools. The framework handles engagement (when to pay attention), event routing, and message history — the agent brings its own brain.

## Packages

- **`typescript/`** — TypeScript implementation. `npm install stoops`.
- **`python/`** — Python implementation (WIP). `pip install stoops`.

## Quick start

```typescript
import { Room, InMemoryStorage } from 'stoops'
import { StoopRuntime } from 'stoops/agent'
import { claude } from 'stoops/claude'

const storage = new InMemoryStorage()
const kitchen = new Room('kitchen', storage)

// Connect a human
const human = kitchen.connect('user-1', 'Izzat', 'human')

// Create an agent runtime with a Claude bridge
const runtime = new StoopRuntime({ bridge: claude() })
runtime.connectRoom(kitchen, { mode: 'everyone' })

await runtime.run()

// Human talks — agent receives events and responds through MCP tools
human.sendMessage('what should we do tonight?')
```

## CLI

```bash
# Start the room server
npx stoops serve --rooms kitchen,lounge

# In another terminal — full Claude Code TUI with room events
stoops run claude --rooms kitchen
```

## Architecture

Two plugin points:

1. **MCP servers** (agent → world) — tools like `catch_up`, `send_message`, `search_by_text`
2. **Event channel** (world → agent) — classified room events pushed into the agent's context

The engagement model (trigger/content/drop) controls what reaches the agent and when. Bridges handle delivery to specific platforms (Claude SDK, Claude Code TUI, LangGraph).

## License

MIT
