/** stoops/core — Chat server with typed events and channels. */

export { EventCategory, MessageSchema, type Message, type Participant, type PaginatedResult } from "./types.js";
export {
  type RoomEvent,
  type MessageSentEvent,
  type MessageEditedEvent,
  type MessageDeletedEvent,
  type ReactionAddedEvent,
  type ReactionRemovedEvent,
  type ParticipantJoinedEvent,
  type ParticipantLeftEvent,
  type StatusChangedEvent,
  type ToolUseEvent,
  type ActivityEvent,
  type MentionedEvent,
  type ContextCompactedEvent,
  createEvent,
  EVENT_ROLE,
  type EventRole,
} from "./events.js";
export { type StorageProtocol, InMemoryStorage } from "./storage.js";
export { Channel } from "./channel.js";
export { Room } from "./room.js";
