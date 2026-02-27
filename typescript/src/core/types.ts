/** Core types for stoops — messages, participants, pagination. */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

// ── Event categories ─────────────────────────────────────────────────────────

/**
 * The four top-level categories events are grouped under.
 *
 * Channels subscribe to one or more categories — they only receive events in
 * their subscription set. Use this to filter what an agent or observer sees:
 *
 * - MESSAGE  — chat messages and reactions (sent, edited, deleted, reacted)
 * - PRESENCE — participants joining and leaving
 * - ACTIVITY — agent activity (thinking, tool use, mode changes, compaction)
 * - MENTION  — direct @mentions delivered only to the mentioned participant
 */
export const EventCategory = {
  MESSAGE:  "MESSAGE",
  PRESENCE: "PRESENCE",
  ACTIVITY: "ACTIVITY",
  MENTION:  "MENTION",
} as const;

export type EventCategory = (typeof EventCategory)[keyof typeof EventCategory];

// ── Message ──────────────────────────────────────────────────────────────────

/**
 * A chat message. Immutable once stored — edits and deletes are separate events.
 *
 * - `id`                — UUID, assigned by the room on creation
 * - `room_id`           — the room this message belongs to
 * - `sender_id`         — participant ID of the author
 * - `sender_name`       — display name at the time of sending (denormalized)
 * - `content`           — text body (may be empty if the message is image-only)
 * - `reply_to_id`       — if set, this message is a reply to that message ID
 * - `image_url`         — optional attached image URL
 * - `image_mime_type`   — MIME type of the attached image (e.g. "image/jpeg")
 * - `image_size_bytes`  — size of the image in bytes
 * - `timestamp`         — creation time (UTC)
 */
export const MessageSchema = z.object({
  id: z.string().default(() => uuidv4()),
  room_id: z.string(),
  sender_id: z.string(),
  sender_name: z.string(),
  content: z.string(),
  reply_to_id: z.string().nullable().default(null),
  image_url: z.string().nullable().default(null),
  image_mime_type: z.string().nullable().default(null),
  image_size_bytes: z.number().int().nullable().default(null),
  timestamp: z.date().default(() => new Date()),
});

export type Message = z.infer<typeof MessageSchema>;

// ── Participant ───────────────────────────────────────────────────────────────

/** Whether a participant is a human or an agent. */
export type ParticipantType = "human" | "stoop";

/**
 * A participant in a room.
 *
 * - `id`         — stable unique ID across all rooms and sessions
 * - `name`       — display name (mutable — participants can rename)
 * - `status`     — current presence status ("online", "offline", etc.)
 * - `type`       — "human" or "stoop" (agent)
 * - `identifier` — optional stable @-mention slug, e.g. "my-agent".
 *                  Unlike `name`, this never changes on rename.
 *                  Used for @-mention matching in addition to the display name.
 *                  Not all participants have one — guests and anonymous users
 *                  typically don't.
 */
export interface Participant {
  id: string;
  name: string;
  status: string;
  type: ParticipantType;
  identifier?: string;
}

// ── Pagination ────────────────────────────────────────────────────────────────

/**
 * A page of results with a cursor for fetching the previous page.
 *
 * All paginated queries return results newest-first. Pass `next_cursor` back
 * to the same query to continue paginating backwards through history.
 *
 * - `items`       — results for this page (newest-first)
 * - `next_cursor` — pass this to get the next (older) page; null when exhausted
 * - `has_more`    — true if there are older items beyond this page
 */
export interface PaginatedResult<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}
