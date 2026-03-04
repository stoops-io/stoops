/**
 * Typed events for rooms — a discriminated union on the `type` field.
 *
 * Every event has:
 *   id           — UUID assigned at creation
 *   type         — the discriminant (e.g. "MessageSent", "ParticipantJoined")
 *   category     — the EventCategory for subscription filtering
 *   room_id      — the room this event belongs to
 *   participant_id — the participant who caused the event
 *   timestamp    — UTC creation time
 *
 * Use `createEvent()` to build events — it fills in `id` and `timestamp`.
 * Use `EVENT_ROLE` to classify events by their semantic role.
 */

import { v4 as uuidv4 } from "uuid";
import type { AuthorityLevel, Message, Participant } from "./types.js";

// ── Base ─────────────────────────────────────────────────────────────────────

interface BaseRoomEvent {
  /** UUID assigned at creation. */
  id: string;
}

// ── MESSAGE category ─────────────────────────────────────────────────────────

/** Someone sent a message. `message` contains the full content including any image. */
export interface MessageSentEvent extends BaseRoomEvent {
  type: "MessageSent";
  category: "MESSAGE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  message: Message;
}

/** A message's text content was changed. Does not update image attachments. */
export interface MessageEditedEvent extends BaseRoomEvent {
  type: "MessageEdited";
  category: "MESSAGE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  message_id: string;
  new_content: string;
  old_content: string;
}

/** A message was removed. The message ID is preserved for reference but content is gone. */
export interface MessageDeletedEvent extends BaseRoomEvent {
  type: "MessageDeleted";
  category: "MESSAGE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  message_id: string;
}

/** A participant added an emoji reaction to a message. */
export interface ReactionAddedEvent extends BaseRoomEvent {
  type: "ReactionAdded";
  category: "MESSAGE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  message_id: string;
  emoji: string;
}

/** A participant removed their emoji reaction from a message. */
export interface ReactionRemovedEvent extends BaseRoomEvent {
  type: "ReactionRemoved";
  category: "MESSAGE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  message_id: string;
  emoji: string;
}

// ── PRESENCE category ─────────────────────────────────────────────────────────

/**
 * A participant connected to the room.
 *
 * Not emitted for silent connects (`Room.connect(..., silent: true)`).
 * Agents connect silently to avoid polluting the chat with join noise.
 */
export interface ParticipantJoinedEvent extends BaseRoomEvent {
  type: "ParticipantJoined";
  category: "PRESENCE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  /** Full participant snapshot at join time. */
  participant: Participant;
}

/**
 * A participant disconnected from the room.
 *
 * Not emitted for silent disconnects (`channel.disconnect(true)`).
 */
export interface ParticipantLeftEvent extends BaseRoomEvent {
  type: "ParticipantLeft";
  category: "PRESENCE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  /** Full participant snapshot at leave time. */
  participant: Participant;
}

/** A participant's presence status changed (e.g. "online" → "away"). */
export interface StatusChangedEvent extends BaseRoomEvent {
  type: "StatusChanged";
  category: "PRESENCE";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  status: "online" | "offline" | "away";
}

/**
 * A participant was kicked from the room by an admin.
 *
 * Emitted before the channel disconnect so all participants see it.
 * The subsequent `ParticipantLeft` event is suppressed (silent disconnect).
 */
export interface ParticipantKickedEvent extends BaseRoomEvent {
  type: "ParticipantKicked";
  category: "PRESENCE";
  room_id: string;
  /** The kicked participant. */
  participant_id: string;
  timestamp: Date;
  /** Full participant snapshot at kick time. */
  participant: Participant;
  /** Display name of the admin who kicked them. */
  kicked_by: string;
}

/**
 * A participant's authority level was changed by an admin.
 *
 * Covers mute (→ guest), unmute (→ member), and promotion (→ admin).
 */
export interface AuthorityChangedEvent extends BaseRoomEvent {
  type: "AuthorityChanged";
  category: "PRESENCE";
  room_id: string;
  /** The affected participant. */
  participant_id: string;
  timestamp: Date;
  /** Full participant snapshot (with updated authority). */
  participant: Participant;
  /** The new authority level. */
  new_authority: AuthorityLevel;
  /** Display name of the admin who made the change. */
  changed_by: string;
}

// ── ACTIVITY category ─────────────────────────────────────────────────────────


/**
 * An agent made an MCP tool call.
 *
 * Emitted twice per tool call: once with `status: "started"` (before the call)
 * and once with `status: "completed"` (after). Useful for showing live tool
 * progress in a UI.
 */
export interface ToolUseEvent extends BaseRoomEvent {
  type: "ToolUse";
  category: "ACTIVITY";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  tool_name: string;
  /** "started" before the call, "completed" after. */
  status: "started" | "completed";
}

/**
 * A generic activity event for platform-specific actions.
 *
 * Used when no specific event type fits. The `action` field identifies the
 * action (e.g. `"mode_changed"`), and `detail` carries structured metadata.
 *
 * Current usages:
 *   - action: "mode_changed", detail: { mode: EngagementMode }
 *     Emitted when an agent's engagement mode changes for a room.
 */
export interface ActivityEvent extends BaseRoomEvent {
  type: "Activity";
  category: "ACTIVITY";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  action: string;
  detail: Record<string, unknown> | null;
}

/**
 * An agent's context window was compacted.
 *
 * Fired when the LLM backend summarizes and compresses the conversation history
 * to free up context space. After compaction, the agent re-reads all rooms via
 * `catch_up` to rebuild its working context.
 */
export interface ContextCompactedEvent extends BaseRoomEvent {
  type: "ContextCompacted";
  category: "ACTIVITY";
  room_id: string;
  participant_id: string;
  timestamp: Date;
  /** Full participant snapshot (for display name). */
  participant: Participant;
}

// ── MENTION category ─────────────────────────────────────────────────────────

/**
 * A participant was @mentioned in a message.
 *
 * Delivered only to the mentioned participant's channel — not broadcast to the
 * room. The `participant_id` is the **recipient** (the person mentioned), not
 * the sender. The sender is in `message.sender_id`.
 *
 * @mention detection is case-insensitive and matches on both `identifier`
 * (e.g. `@my-agent`) and display `name` (e.g. `@Alice`).
 *
 * Agents in standby modes wake up on this event type only.
 */
export interface MentionedEvent extends BaseRoomEvent {
  type: "Mentioned";
  category: "MENTION";
  room_id: string;
  /** The mentioned participant (the recipient of the @mention). */
  participant_id: string;
  timestamp: Date;
  /** The full message that contained the @mention. */
  message: Message;
}

// ── Union ─────────────────────────────────────────────────────────────────────

export type RoomEvent =
  | MessageSentEvent
  | MessageEditedEvent
  | MessageDeletedEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | ParticipantKickedEvent
  | AuthorityChangedEvent
  | StatusChangedEvent
  | ToolUseEvent
  | ActivityEvent
  | MentionedEvent
  | ContextCompactedEvent;

// ── Event roles ───────────────────────────────────────────────────────────────

/**
 * Semantic role of an event, used by the engagement system to decide how to
 * handle it relative to an agent.
 *
 * - "message"  — a direct chat message; may trigger LLM evaluation
 * - "mention"  — an @mention directed at a specific participant
 * - "ambient"  — background activity (joins, leaves, reactions) — buffered as
 *                context but doesn't trigger evaluation on its own
 * - "internal" — platform bookkeeping (edits, deletes, status changes, agent
 *                activity) — always dropped by the engagement system
 */
export type EventRole = "message" | "mention" | "ambient" | "internal";

/** Maps each event type to its semantic role for the engagement system. */
export const EVENT_ROLE: Record<RoomEvent["type"], EventRole> = {
  MessageSent:       "message",
  Mentioned:         "mention",
  ParticipantJoined: "ambient",
  ParticipantLeft:   "ambient",
  ParticipantKicked: "ambient",
  AuthorityChanged:  "ambient",
  ReactionAdded:     "ambient",
  ContextCompacted:  "ambient",
  MessageEdited:     "internal",
  MessageDeleted:    "internal",
  ReactionRemoved:   "internal",
  StatusChanged:     "internal",
  ToolUse:           "internal",
  Activity:          "internal",
};

// ── Factory ───────────────────────────────────────────────────────────────────

type EventData<T extends RoomEvent> = Omit<T, "id" | "timestamp"> & {
  id?: string;
  timestamp?: Date;
};

/**
 * Create a typed room event, filling in `id` (UUID) and `timestamp` (now).
 *
 * @example
 * const event = createEvent<MessageSentEvent>({
 *   type: "MessageSent",
 *   category: "MESSAGE",
 *   room_id: "room-1",
 *   participant_id: "user-1",
 *   message: { ... },
 * });
 */
export function createEvent<T extends RoomEvent>(data: EventData<T>): T {
  return { id: uuidv4(), timestamp: new Date(), ...data } as T;
}
