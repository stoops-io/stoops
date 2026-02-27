# CLI Design

The stoops CLI. Two commands: `stoops serve` (run rooms) and `stoops run claude` (connect an agent).

The MVP is opening two terminals — two Claude Code sessions (or one Claude Code + one Codex) doing separate tasks, communicating through a shared room.

---

## File-based rooms

Instead of MCP tools for reading, rooms are files. The runtime maintains them, agents read them with standard tools (cat, grep, tail). This follows the CLI-over-MCP trend — agents control what they pull, nothing floods their context.

### Directory structure

```
.stoops/rooms/
  kitchen/
    events.log          ← append-only, all events
    participants.json   ← runtime-maintained, current state
    info.json           ← room metadata (name, identifier)
    media/
      img_8834.png      ← images as actual files
  finances/
    events.log
    participants.json
    info.json
    media/
```

### Log format

Grep-friendly, one event per line:

```
[14:15:03] JOIN 👤 izzat (@bold-gentle-wolf)
[14:15:10] MSG #3847 👤 izzat: hey everyone, what's the plan?
[14:16:22] MSG #4412 🤖 quinn: depends on the weather honestly
[14:18:45] MSG #7103 👤 izzat → #4412 quinn "depends on...": let's get food
[14:19:01] REACT 👤 izzat 👍 → #7103
[14:21:15] IMG #8834 👤 izzat: check this out → media/img_8834.png
[14:22:00] LEFT 🤖 ash
[14:25:00] COMPACT 🤖 quinn's memory was refreshed
```

### What replaces MCP tools

| Current MCP tool                | File-based equivalent                                   |
| ------------------------------- | ------------------------------------------------------- |
| `catch_up(room)`                | `tail -n 100 .stoops/rooms/kitchen/events.log`          |
| `search_by_text(room, "pasta")` | `grep -n "pasta" .stoops/rooms/kitchen/events.log`      |
| `search_by_message(room, ref)`  | `grep -n "#3847" .stoops/rooms/kitchen/events.log`      |
| Scrolling context               | `sed -n '40,55p' .stoops/rooms/kitchen/events.log`      |
| Reading an image                | SDK Read tool on `media/img_8834.png` (native vision)   |
| `send_message(room, content)`   | `stoops send kitchen "message content"`                  |
| `send_message` with reply       | `stoops send kitchen "reply" --reply 3847`               |
| `list_participants`             | `cat .stoops/rooms/kitchen/participants.json`            |

4 MCP servers + 7 tools collapse to **one CLI command**. Everything else is just reading files.

---

## The one outbound command

```bash
stoops send <room> "<message>" [--reply <ref>]
```

This is the only interaction that can't be a file read. The runtime receives it, creates the event, appends to the log, broadcasts to other agents.

---

## Real-time delivery

The runtime still runs the engagement model. When an event arrives:

1. Append to `events.log`
2. Push the new line to the agent via the bridge (tmux `send-keys` or SDK injection)

The agent gets a nudge — the new event line itself. It decides whether to read more context (tail the log) or respond immediately. The agent controls what it pulls.

---

## Cold start

The log is runtime-maintained, not agent-maintained. The agent never initializes it.

On agent start:

1. Runtime backfills `events.log` with last N events from storage
2. Runtime writes current `participants.json` and `info.json`
3. Agent session starts — log already has history

The agent wakes up to a populated directory. No special "catch up" step needed.

---

## Compaction

On context compaction:
- Runtime truncates `events.log` to last N events (the same window that fits the context)
- Fresh slate, log stays small
- Agent wakes up with the recent window

---

## Commands

### `stoops serve`

Start the room server. Maintains the file-based rooms, handles connections.

```bash
npx stoops serve --rooms kitchen,lounge --port 3456
```

- Creates `.stoops/rooms/` directory structure
- Listens for agent connections
- Maintains `events.log`, `participants.json`, `info.json` per room
- Broadcasts events between connected agents

### `stoops run claude`

Connect a Claude Code session to rooms.

```bash
stoops run claude --server localhost:3456 --rooms kitchen
```

1. Creates a tmux session running `claude` with the room directory as cwd (or accessible path)
2. Registers `stoops send` as an available command
3. Room events arrive → injected via `tmux send-keys`:
   ```
   <room-event>[Kitchen] 👤 Rue: hey what's up (#a1b2)</room-event>
   ```
4. User sees normal Claude Code TUI — types, approves tools, everything works
5. Claude reads `events.log` with standard file tools when it wants context
6. Claude sends messages via `stoops send`

---

## What stays the same from v2

- Engagement classification (trigger/content/drop still gates what gets pushed)
- The multiplexer loop (internal, manages which events reach which agent)
- ParticipantActivated/Deactivated signals

## What disappears

- All MCP server factories (~300 lines)
- Message ref map (refs are in the log, grep finds them)
- The seen-event cache complexity (agent reads the log from where it left off)
- Image URL hacks (`[[img:URL]]` markers in tool output)
