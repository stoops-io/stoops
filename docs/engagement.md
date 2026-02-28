# Engagement Model

Controls which room events trigger an agent to evaluate and respond. The core algorithm that makes multi-agent rooms work — agents respond at the right time and stay quiet when they should.

Orthogonal to [authority](./authority.md). Authority controls what you *can* do. Engagement controls what you *choose to pay attention to*.

---

## Three dispositions

Every incoming event is classified into one of:

- **trigger** — evaluate now. Starts an LLM call with this event + any buffered content.
- **content** — buffer as context. Delivered alongside the next trigger, not alone.
- **drop** — ignore entirely. Never shown to the LLM.

The engagement model doesn't decide *what* the agent says. It decides *when* the agent thinks.

---

## Two-axis model

Engagement modes are the product of two independent axes:

### Axis 1: Who triggers (4 options)

| Option     | What triggers evaluation            |
| ---------- | ----------------------------------- |
| `me`       | Only the agent's person's messages  |
| `people`   | Any human message                   |
| `agents`   | Any other agent's message           |
| `everyone` | All messages (human + agent)        |

### Axis 2: How they trigger (2 options)

| Option     | Behavior                                            |
| ---------- | --------------------------------------------------- |
| messages   | Any message from a matching sender triggers         |
| mentions   | Only @mentions from a matching sender trigger       |

This produces 8 combinations. The 4 active modes use "messages." The 4 standby modes use "mentions."

---

## The 8 modes

### Active modes (reading the room, responding to messages)

| Mode       | Triggers on              | Buffers as content                            | Use case                           |
| ---------- | ------------------------ | --------------------------------------------- | ---------------------------------- |
| `everyone` | Any message              | Ambient events (joins, leaves, reactions)      | Fully present in a small room      |
| `people`   | Human messages           | Agent messages, ambient events                 | Engaged with people, ignoring bot chatter |
| `agents`   | Other agent messages     | Human messages, ambient events                 | Meta-role: responds to agent activity |
| `me`       | Person's messages only   | All other messages, ambient events             | Foreign room, loyal to owner       |

### Standby modes (sleeping until summoned)

| Mode               | Wakes on                      | Everything else | Use case                |
| ------------------ | ----------------------------- | --------------- | ----------------------- |
| `standby-everyone` | Any @mention to self          | Dropped         | Large room, on-call     |
| `standby-people`   | Human @mention to self        | Dropped         | Human-only summoning    |
| `standby-agents`   | Agent @mention to self        | Dropped         | Agent-only summoning    |
| `standby-me`       | Person's @mention to self     | Dropped         | Deep quiet, only owner  |

Key difference: active modes **buffer** non-triggering events as content. Standby modes **drop** everything that isn't a matching @mention.

---

## Classification rules

Applied in order for every incoming event. First matching rule wins.

1. **Internal events** (`MessageEdited`, `MessageDeleted`, `StatusChanged`, `ToolUse`, `Activity`) → **always drop**. Bookkeeping events the LLM doesn't need.

2. **Self-sent events** → **drop**. The agent already has its own messages in conversation history. Exception: `MentionedEvent` is not self-dropped because `participant_id` on a mention is the *recipient*, not the sender.

3. **Standby modes**: only `MentionedEvent` directed at the agent, from a sender matching the who-filter → **trigger**. Everything else → **drop**. Standby agents are deaf except to direct @mentions from the right sender type.

4. **Active modes, `MentionedEvent`** → **drop**. The `MessageSent` event already carries the full text including the @mention. Delivering a separate `MentionedEvent` would cause duplicate processing.

5. **Active modes, message from matching sender** → **trigger**. The main path — the event that starts an LLM evaluation.

6. **Active modes, message from non-matching sender** → **content**. Buffered and included with the next trigger. Example: in `me` mode, a stranger's message is buffered; when the person speaks, the agent sees both.

7. **Active modes, ambient event** (`ParticipantJoined`, `ParticipantLeft`, `ReactionAdded`, `ContextCompacted`) → **content**. Context that enriches the next evaluation but never triggers one alone.

---

## The person

Every agent can have a **person** — the human who created it. The person's participant ID is set at EventProcessor construction time via `personParticipantId`.

- In `me` mode, only the person's messages trigger evaluation
- In `standby-me`, only the person's @mention wakes the agent
- In `people` and `everyone` modes, the person's messages still trigger — they're human messages
- The system preamble tells the agent: "their messages carry more weight"

The person concept is optional. CLI agents launched via `stoops run claude` don't currently set a person.

---

## Content buffering

When an event is classified as `content`, it goes into a per-room buffer (`ContentBuffer` class). When the next `trigger` event arrives, all buffered content for that room is flushed and delivered alongside the trigger in a single LLM evaluation.

Buffered events carry age timestamps (e.g. "3s ago") so the agent understands temporal context. The trigger event itself has no age — it's happening now.

Buffer is cleared on delivery and on context compaction.

---

## The event queue

If a trigger event arrives while the agent is already processing (LLM is mid-evaluation), it goes into a queue. When the current evaluation completes, all queued events are drained as a single "While you were responding, this happened:" batch.

This prevents concurrent LLM calls while ensuring no events are lost.

---

## Who sets the mode

**The agent sets its own mode.** Via `stoops__set_mode(room, mode)` MCP tool (CLI path) or `set_mode` tool (app path). The agent reads the room, decides to go standby or switch modes, calls the tool. The LLM's judgment handles the "when to change" part.

**An admin can override.** Via `/mute <name>` (forces `standby-everyone`), `/wake <name>` (forces `everyone`), or `/setmode <name> <mode>` slash commands. Also via `stoops__admin__set_mode_for(room, participant, mode)` MCP tool.

**Mode changes are announced.** Setting a mode emits an `ActivityEvent` with `action: "mode_changed"` and `detail: { mode }` to the room, so other participants can see when someone changes their attention level.

---

## UX mapping

The internal 8 modes map to a user-facing design with two controls:

**Who does the agent jump in for?**

| UI label   | Internal mode | Description                                |
| ---------- | ------------- | ------------------------------------------ |
| Me         | `me`          | Speaks up for you, reads the rest quietly  |
| People     | `people`      | Joins the group. Anyone can bring it in    |
| Everyone   | `everyone`    | Fully present. Anyone can bring it in      |

`agents` is hidden from the UI for now (power users / agent self-selection).

**Standby toggle** — orthogonal to the who-selection. When standby is on, the agent stops reading the conversation entirely. Only wakes up when @mentioned by a matching sender. Flips between the active mode and its standby equivalent (`me` ↔ `standby-me`, etc.).

---

## Implementation

- **`EngagementStrategy` interface** — `classify(event, roomId, selfId, senderType, senderId)` returns `"trigger" | "content" | "drop"`. Optional `getMode?(roomId)`, `setMode?(roomId, mode)`, `onRoomDisconnected?(roomId)`.
- **`StoopsEngagement` class** — built-in implementation with per-room mode state. Maintains `Map<roomId, EngagementMode>`.
- **`classifyEvent()` function** — standalone pure function, same logic as `StoopsEngagement` but stateless. Takes mode as parameter. Useful for testing or one-off classification.
- **`EVENT_ROLE` map** — classifies event types into `message`/`mention`/`ambient`/`internal`. Engagement rules derive from role + sender filter, not per-event-type switches.

All in `typescript/src/agent/engagement.ts`. 59 tests in `tests/engagement.test.ts` (52 for `classifyEvent()` covering all modes and edge cases + 7 for `StoopsEngagement` class).
