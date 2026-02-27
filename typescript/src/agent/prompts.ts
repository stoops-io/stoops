/** Event formatting, mode reminders, and system preamble for stoops agents. */

import type { Participant } from "../core/types.js";
import type { RoomEvent } from "../core/events.js";
import type { ContentPart } from "./types.js";

// ── System preamble ───────────────────────────────────────────────────────────

const SYSTEM_PREAMBLE = `You are a participant in group chats. You may be connected to multiple rooms at once — events from all of them flow to you, labeled with the room name.

## How this works
- Messages appear labeled: "[Kitchen Crew] Rue: hey everyone"
- Replies: "[Kitchen Crew] Rue (replying to Ash): good point"
- @mentions: "⚡ [Kitchen Crew] Rue mentioned you: @Ash what do you think?"
- All your tools require a room name as the first parameter
- Rooms have a stable \`identifier\` (e.g., kitchen-crew) that doesn't change even if renamed
- Message references like #3847 are internal tool labels only. Never include them in messages — participants don't see them.

## Your memory
You have no persistent memory between sessions. Each time you start, you're waking up fresh. Your conversations are still there — read them via tools.

If you lack context for something someone references, say so directly — don't invent explanations.

## Your person
You were created by someone — that's your person. You know their participant ID from your identity block below. Their messages carry more weight: they're the one who set you up and knows what they want from you. In group rooms, stay tuned to them even when others are talking.

When someone who isn't your person addresses you in a group room, respond if it's useful and natural. But don't lose track of who you're ultimately here for.

## Engagement modes
Each room has a mode controlling when you evaluate and respond:
- everyone — all messages trigger evaluation. Respond when you have something genuine to add.
- people — any human message triggers you. Stoop messages are buffered as context.
- stoops — any stoop message triggers you. Human messages are buffered as context.
- me — only your person's messages trigger evaluation. Read everything else quietly.
- standby-everyone — only @mentions wake you. Stay silent unless directly called, by anyone.
- standby-people — only human @mentions wake you.
- standby-stoops — only stoop @mentions wake you.
- standby-me — only your person's @mention wakes you.

Non-everyone rooms show the mode in the room label (e.g., "[Kitchen Crew — people]").`;

/**
 * Build the system preamble for a stoop.
 *
 * Prepends an identity block if the stoop has an identifier or person.
 * The caller (app layer) appends the stoop's personality after this.
 */
export function getSystemPreamble(identifier?: string, personParticipantId?: string): string {
  const lines: string[] = [];
  if (identifier) lines.push(`Your identifier: @${identifier}`);
  if (personParticipantId) lines.push(`Your person's participant ID: ${personParticipantId}`);
  if (identifier) lines.push(`Recognize other participants by their identifier. Address them by their current display name.`);
  const identityBlock = lines.length > 0 ? `## Your identity\n${lines.join("\n")}\n\n` : "";
  return identityBlock + SYSTEM_PREAMBLE;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Short 4-char ref for a message ID, used in transcripts. */
export function messageRef(messageId: string): string {
  return messageId.replace(/-/g, "").slice(0, 4);
}

/** Per-mode label strings. */
export const MODE_REMINDERS: Record<"me" | "people" | "stoops" | "everyone" | "standby-me" | "standby-people" | "standby-stoops" | "standby-everyone", string> = {
  me: "me",
  people: "people",
  stoops: "stoops",
  everyone: "everyone",
  "standby-me": "standby-me",
  "standby-people": "standby-people",
  "standby-stoops": "standby-stoops",
  "standby-everyone": "standby-everyone",
};

/** Format a participant as a labeled name: 👤 Rue (human) or 🤖 Quinn (stoop). */
export function participantLabel(p: Participant | null, fallback?: string): string {
  if (!p) return fallback ?? "someone";
  const emoji = p.type === "stoop" ? "🤖" : "👤";
  return `${emoji} ${p.name}`;
}

/** Format a Date as UTC HH:MM:SS for display in agent transcripts. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** Convert ContentPart[] back to a plain string (for trace logs and stats). */
export function contentPartsToString(parts: ContentPart[]): string {
  return parts.map(p => p.type === "text" ? p.text : ` [image: ${p.url}]`).join("");
}

/**
 * Format a typed event as ContentPart[] for the LLM session.
 * Returns null for events that shouldn't be sent to the LLM (noise).
 *
 * When roomLabel is provided, all output is prefixed with [roomLabel].
 * Omit roomLabel for single-room agents (backward compatible).
 *
 * When assignRef is provided, messages get runtime-managed 4-digit decimal refs
 * (#3847) instead of the static hex refs. Pass (id) => runtime.assignRef(id).
 */
export function formatEvent(
  event: RoomEvent,
  resolveParticipant: (id: string) => Participant | null,
  replyContext?: { senderName: string; content: string } | null,
  roomLabel?: string,
  reactionTarget?: { senderName: string; content: string; isSelf: boolean } | null,
  assignRef?: (messageId: string) => string,
): ContentPart[] | null {
  const p = roomLabel ? `[${roomLabel}] ` : "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = `[${formatTimestamp((event as any).timestamp ?? new Date())}] `;
  const mkRef = (id: string) => `(#${assignRef ? assignRef(id) : messageRef(id)})`;

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const label = participantLabel(resolveParticipant(msg.sender_id), msg.sender_name);
      const ref = ` ${mkRef(msg.id)}`;
      let text: string;
      if (msg.reply_to_id && replyContext) {
        const q = replyContext.content.length > 60 ? replyContext.content.slice(0, 57) + "..." : replyContext.content;
        text = `${ts}${p}${label} (→ ${replyContext.senderName}: "${q}"): ${msg.content}${ref}`;
      } else {
        text = `${ts}${p}${label}: ${msg.content}${ref}`;
      }
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "Mentioned": {
      const msg = event.message;
      const label = participantLabel(resolveParticipant(msg.sender_id), msg.sender_name);
      const text = `${ts}⚡ ${p}${label} mentioned you: ${msg.content}`;
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "ToolUse":
      return null;
    case "Activity":
      return null;
    case "ReactionAdded": {
      const label = participantLabel(resolveParticipant(event.participant_id), event.participant_id);
      if (reactionTarget) {
        const q = reactionTarget.content.length > 40
          ? reactionTarget.content.slice(0, 37) + "..."
          : reactionTarget.content;
        if (reactionTarget.isSelf) {
          return [{ type: "text", text: `${ts}${p}${label} reacted ${event.emoji} to your message "${q}"` }];
        }
        return [{ type: "text", text: `${ts}${p}${label} reacted ${event.emoji} to ${reactionTarget.senderName}'s "${q}"` }];
      }
      return [{ type: "text", text: `${ts}${p}${label} reacted ${event.emoji}` }];
    }
    case "ReactionRemoved":
      return null;
    case "ParticipantJoined": {
      // Use event.participant directly — it carries the full Participant including type
      return [{ type: "text", text: `${ts}${p}${participantLabel(event.participant)} joined the chat` }];
    }
    case "ParticipantLeft": {
      const label = participantLabel(event.participant);
      return [{ type: "text", text: `${ts}${p}${label} left the chat` }];
    }
    case "ContextCompacted": {
      const label = participantLabel(event.participant);
      return [{ type: "text", text: `${ts}${p}${label}'s memory was refreshed` }];
    }
    default:
      return null;
  }
}
