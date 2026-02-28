# Claude Code tmux Bridge

How we got here, what we considered, and what we're building.

## The problem

Stoops needs to push room events into Claude Code in real-time. Claude Code is an interactive CLI app (built on Ink/React) with no official API for injecting input into a running session. We need to get text in, reliably, while a human may or may not be interacting with the same session.

## Starting point: tmux send-keys

tmux is a terminal multiplexer. When you run a process inside a tmux session, you can programmatically type into it from outside using `tmux send-keys`. This is what stoops currently does — launch Claude Code inside tmux, inject room events as `<room-event>` tagged text via `send-keys`, and press Enter.

This works for the happy path. But it's blind — you're shoving bytes into a terminal with no idea what state the app is in.

## The edge cases

We identified several states where blind injection breaks:

1. **Claude Code is showing a permission prompt** (Allow/Deny, Yes/No) — injected text goes into the prompt's input buffer, gets interpreted as option selection or ignored entirely
2. **Claude Code is showing a question dialog** (numbered options, multi-select checkboxes) — same problem, text lands in the wrong context
3. **Claude Code is streaming a response** — text arrives but doesn't get processed as a new prompt until streaming finishes
4. **User is mid-typing** — injected text gets interleaved with their input, producing garbage like `hel<room-event>...lo`
5. **Autocomplete menu is visible** — keystrokes get eaten by the dropdown
6. **Reverse search is active** (Ctrl+R) — text goes into search, not the prompt

## What we explored

### Option 1: Claude Code's programmatic input (`-p --resume`)

Claude Code has a non-interactive mode: `claude -p "prompt" --resume SESSION_ID`. You can send follow-up messages to the same session programmatically. Each call is a fresh process that appends to the conversation context.

**Pros:** No tmux at all. Clean process-per-turn. No input collision.

**Cons:** Each `-p` call is a fresh process invocation. The agent can't be "thinking" when a new event arrives — you'd queue events until the current turn completes. Loses the "living agent" feel of a persistent interactive session. Request/response rather than continuous.

We didn't pursue this further. It works but it's a different interaction model — more like a bot than an agent with presence.

### Option 2: Separate human from injection entirely

Don't let the human type into the Claude Code session. The human stays in the stoops TUI, their messages become room events, and those events get pushed to Claude Code via tmux. The human never touches the tmux session — they might not know it exists.

**Pros:** No input collision ever. stoops runtime has exclusive control of tmux input. Permission prompts can be auto-handled. Injection is always safe.

**Cons:** Human loses direct interaction with Claude Code (no typing, no manual tool approval). The agent's relationship with the human is entirely mediated through the room.

This is actually close to what stoops already does in practice — the human is usually in one terminal with the TUI, the agent is in another. The question is whether `tmux attach` (letting the human peek into the agent session) is a feature worth supporting.

### Option 3: claude-commander (PTY + socket wrapper)

We found [claude-commander](https://github.com/sstraus/claude-commander), a Rust binary (~600KB, 1528 lines) that wraps Claude Code's PTY and exposes a Unix socket API. You send JSON commands to `/tmp/claudec-<SESSION_ID>.sock`:

```json
{"action": "send", "text": "hello", "submit": true}
{"action": "send", "text": "partial", "submit": false}
{"action": "keys", "keys": "\\x1b"}
{"action": "status"}
```

All PTY writes go through a single mutex, so keyboard and socket input are serialized — no byte-level corruption.

**Pros:** Structured API instead of blind `send-keys`. The `submit: false` option lets you type text without pressing Enter. Raw key sequences (Escape, arrows, Ctrl+C) are supported.

**Cons:** Only solves write-side collision (mutex serialization). No screen reading — you still can't detect what state Claude Code is in. No "is Claude idle?" detection. The `status` command only returns pid/socket path, not screen contents. And it's a 2-star repo Rust dependency.

The concept is right — own the PTY, expose a structured API — but it only solves half the problem. We need read access (screen state) not just write access (inject text).

### Option 4: agentchattr's approach

We looked at [agentchattr](https://github.com/cline/agentchattr), where the tmux-over-Claude-Code idea originally came from. Their approach is radically simple:

- Server writes to a queue file when an @mention happens
- Watcher thread polls the file every 1 second
- On trigger, it injects the fixed string `"chat - use mcp"` + Enter via `tmux send-keys -l`
- Claude Code then uses MCP tools to pull the actual message content

That's it. ~20 lines of injection code. No screen reading, no state detection, no retry logic, fire-and-forget.

**What's smart:** The injection payload is tiny and fixed. The real message lives on the server. If injection fails, the message is still there waiting. The agent reads via MCP (reliable channel), not via terminal text (fragile channel).

**What fails:** Users reported unreliability because there's zero state detection. If Claude Code is showing a permission prompt, the text goes nowhere useful. No recovery.

**The takeaway:** Keep the injection layer as thin and dumb as possible. The less you depend on it working perfectly, the more reliable the system is.

## What we ended up with

### The insight: capture-pane + Claude Code's keyboard shortcuts

tmux has `capture-pane` — it reads what's currently visible on screen as plain text. And we mapped out every keyboard shortcut and TUI state in Claude Code. Combined, these give us:

1. **State detection** — read the screen, parse the last few lines, know what state Claude Code is in
2. **State-appropriate action** — send the right keystrokes for each state

### Claude Code TUI states (from actual screenshots)

We captured screenshots of every interactive state and identified the text patterns that `capture-pane` would return:

**Idle prompt (safe to inject):**

```
❯ █
❯❯ accept edits on (shift+tab to cycle) · PR #2
```

The prompt character `❯` with nothing after it, plus the `❯❯` footer line.

**Question / selection dialog (don't inject):**

```
› 1. Yes
    It works
  2. No
    It doesn't work
  3. Type something.

  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
```

Numbered list with `›` selector. Footer contains `Enter to select`.

**Multi-select dialog (don't inject):**

```
› 1. [ ] Option A
  2. [ ] Option B
  3. [ ] Option C

Enter to select · ↑/↓ to navigate · Esc to cancel
```

Same footer, `[ ]` checkboxes.

**Plan approval dialog (don't inject):**

```
Ready to code?
...
› 1. Yes, clear context (38% used) and auto-accept edits
  2. Yes, auto-accept edits
  3. Yes, manually approve edits
  4. Type here to tell Claude what to change

ctrl+g to edit in VS Code · ~/.claude/plans/...
```

Numbered options, different footer but still a selection UI.

**Review/submit confirmation (don't inject):**

```
Review your answers
⚠ You have not answered all questions
Ready to submit your answers?
› 1. Submit answers
  2. Cancel
```

**Permission dialog (don't inject):**
`(Y)es / (N)o`, `Allow` / `Deny` patterns.

**Streaming response (don't inject):**
Spinner characters `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`.

**User mid-typing (inject with care):**

```
❯ some partial text█
❯❯ accept edits on (shift+tab to cycle)
```

Prompt character followed by text content.

### The state machine

```
Event arrives, want to inject
    │
    ▼
capture-pane → read last N lines
    │
    ├─ Idle (empty prompt + ❯❯ footer)
    │   → send-keys the event text + Enter
    │   ✅ done
    │
    ├─ User mid-typing (text after prompt char)
    │   → Ctrl+U (cuts line to kill ring)
    │   → send-keys our event + Enter
    │   → Ctrl+Y (pastes their text back)
    │   ✅ done
    │
    ├─ Autocomplete visible
    │   → Esc (dismiss)
    │   → re-detect state, handle accordingly
    │
    ├─ Reverse search active
    │   → Esc (exit search)
    │   → re-detect state, handle accordingly
    │
    ├─ Selection dialog / question / plan approval
    │   → queue event, poll until dialog clears
    │
    ├─ Permission dialog
    │   → queue event, poll until dialog clears
    │
    └─ Streaming response
        → queue event, poll until idle
```

### Key keyboard shortcuts we rely on

These are documented Claude Code keybindings:

- **Ctrl+U** — delete entire input line (stores in kill ring)
- **Ctrl+Y** — paste from kill ring (restores what Ctrl+U deleted)
- **Ctrl+K** — delete from cursor to end of line
- **Esc** — dismiss autocomplete, cancel input, exit reverse search
- **Ctrl+C** — interrupt generation
- **Enter** — submit prompt

The Ctrl+U / Ctrl+Y pair is the critical trick for the "user mid-typing" case. These are readline-style keybindings that Claude Code supports. Cut the user's in-progress text, inject ours, paste theirs back. The user sees a brief flicker at worst.

### Heuristic detection table

| Pattern in capture-pane output      | Detected state      | Action                     |
| ----------------------------------- | ------------------- | -------------------------- |
| `Enter to select` in last lines     | Selection dialog    | Queue, poll                |
| `Ready to code?` + numbered options | Plan approval       | Queue, poll                |
| `Review your answers`               | Submit confirmation | Queue, poll                |
| `(Y)es / (N)o` or `Allow` / `Deny`  | Permission prompt   | Queue, poll                |
| Spinner chars (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)        | Streaming           | Queue, poll                |
| `❯ ` + empty + `❯❯` footer          | Idle                | Inject now                 |
| `❯ <text>` + `❯❯` footer            | User typing         | Ctrl+U, inject, Ctrl+Y     |
| None of the above                   | Unknown             | Queue, poll (safe default) |

### What this doesn't solve

- **Heuristics can break across Claude Code versions.** The TUI text patterns could change. This is inherently fragile.
- **Polling latency.** We poll `capture-pane` rather than getting notified of state changes. There's a window between our last poll and our injection where state could change.
- **The Ctrl+U/Ctrl+Y trick assumes readline support.** If Claude Code changes its input handling, this breaks.
- **We can't detect all states.** There might be modal states we haven't screenshotted. The "unknown = queue" fallback keeps things safe but potentially slow.

### Why this is good enough

The alternative is no state detection at all (what agentchattr does) or a completely different architecture (the `-p --resume` loop). This approach:

- Works with the existing tmux-based architecture
- Adds reliability without changing the fundamental model
- Fails safe — unknown states just queue, nothing gets corrupted
- The most common case (idle prompt) is the easiest to detect
- The second most common case (user typing) has a clean solution
- Dialog states are rare during normal agent operation (especially with `--dangerously-skip-permissions` or permission configs)

It's heuristic-based and will need maintenance as Claude Code evolves. But it's a pragmatic step up from blind injection, and it can be built incrementally — start with idle detection only, add more state handlers as needed.
