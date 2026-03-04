/** Event formatting and mode descriptions for stoops agents. */

import type { Participant } from "../core/types.js";
import type { RoomEvent } from "../core/events.js";
import type { ContentPart } from "./types.js";

// ── Mode descriptions ────────────────────────────────────────────────────────

/** One-liner mode descriptions used in join_room responses and set_mode. */
export const MODE_DESCRIPTIONS: Record<string, string> = {
  "everyone": "All messages are pushed to you.",
  "people": "Human messages are pushed to you. Agent messages are delivered as context.",
  "agents": "Agent messages are pushed to you. Human messages are delivered as context.",
  "me": "Only your person's messages are pushed to you. Others are delivered as context.",
  "standby-everyone": "Only @mentions are pushed to you.",
  "standby-people": "Only human @mentions are pushed to you.",
  "standby-agents": "Only agent @mentions are pushed to you.",
  "standby-me": "Only your person's @mentions are pushed to you.",
};

// ── System preamble ──────────────────────────────────────────────────────────

const SYSTEM_PREAMBLE = `You are a participant in group chats. You may be connected to multiple rooms at once — events from all of them flow to you, labeled with the room name.

## How this works
- Messages appear labeled: "[Design Room] [human] Alice: hey everyone"
- Replies: "[Design Room] [human] Alice (replying to [human] Bob): good point"
- @mentions: "⚡ [Design Room] [human] Alice mentioned you: @Bob what do you think?"
- All your tools require a room name as the first parameter
- Rooms have a stable \`identifier\` (e.g., design-room) that doesn't change even if renamed
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
- people — any human message triggers you. Agent messages are buffered as context.
- agents — any agent message triggers you. Human messages are buffered as context.
- me — only your person's messages trigger evaluation. Read everything else quietly.
- standby-everyone — only @mentions wake you. Stay silent unless directly called, by anyone.
- standby-people — only human @mentions wake you.
- standby-agents — only agent @mentions wake you.
- standby-me — only your person's @mention wakes you.

Non-everyone rooms show the mode in the room label (e.g., "[Design Room — people]").`;

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

/** Format a participant as a labeled name: "[human] Alice" or "[agent] Quinn". */
export function participantLabel(p: Participant | null, fallback?: string): string {
  if (!p) return fallback ?? "someone";
  return `[${p.type}] ${p.name}`;
}

/** Resolve participant name, with fallback. */
function resolveName(resolveParticipant: (id: string) => Participant | null, id: string, fallback?: string): string {
  return resolveParticipant(id)?.name ?? fallback ?? "someone";
}

/** Format a Date as UTC HH:MM:SS for display in agent transcripts. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** Convert ContentPart[] back to a plain string (for trace logs and stats). */
export function contentPartsToString(parts: ContentPart[]): string {
  return parts.map(p => p.type === "text" ? p.text : ` [image: ${p.url}]`).join("");
}

/** Count visual character width (grapheme clusters) for padding alignment. */
function visualLength(s: string): number {
  // Use Intl.Segmenter if available (Node 16+), otherwise fall back to spread
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(s)) count++;
    return count;
  }
  return [...s].length;
}

/**
 * Format multiline content with room label continuation.
 * First line is returned as-is. Subsequent lines get [room] prefix aligned.
 */
function formatMultilineContent(content: string, roomLabel: string | undefined, prefix: string): string {
  const lines = content.split("\n");
  if (lines.length <= 1) return content;
  const continuation = roomLabel ? `[${roomLabel}] ` : "";
  // Pad continuation to align under the content start (grapheme-aware)
  const pad = " ".repeat(visualLength(prefix));
  return lines[0] + "\n" + lines.slice(1).map(l => `${pad}${continuation}${l}`).join("\n");
}

/**
 * Format a typed event as ContentPart[] for the LLM session.
 * Returns null for events that shouldn't be sent to the LLM (noise).
 *
 * Compact one-liner format:
 *   Messages:  [14:23:01] #3847 [lobby] Alice: hey everyone
 *   Replies:   [14:23:01] #9102 [lobby] Alice (→ #3847 Bob): good point
 *   Mentions:  [14:23:01] #5521 [lobby] ⚡ Alice: @bot what do you think?
 *   Joined:    [14:23:01] [lobby] + Alice joined
 *   Left:      [14:23:15] [lobby] - Bob left
 *   Reactions:  [14:23:20] [lobby] Alice reacted ❤️ to #3847
 */
export function formatEvent(
  event: RoomEvent,
  resolveParticipant: (id: string) => Participant | null,
  replyContext?: { senderName: string; content: string } | null,
  roomLabel?: string,
  reactionTarget?: { senderName: string; content: string; isSelf: boolean } | null,
  assignRef?: (messageId: string) => string,
): ContentPart[] | null {
  const r = roomLabel ? `[${roomLabel}] ` : "";
  const ts = `[${formatTimestamp("timestamp" in event ? new Date(event.timestamp as Date) : new Date())}] `;
  const mkRef = (id: string) => `#${assignRef ? assignRef(id) : messageRef(id)}`;

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const name = resolveName(resolveParticipant, msg.sender_id, msg.sender_name);
      const ref = mkRef(msg.id);
      const linePrefix = `${ts}${ref} ${r}`;
      let text: string;
      if (msg.reply_to_id && replyContext) {
        const rRef = assignRef ? mkRef(msg.reply_to_id) : ref;
        text = `${linePrefix}${name} (→ ${rRef} ${replyContext.senderName}): ${formatMultilineContent(msg.content, roomLabel, `${linePrefix}${name} (→ ${rRef} ${replyContext.senderName}): `)}`;
      } else {
        text = `${linePrefix}${name}: ${formatMultilineContent(msg.content, roomLabel, `${linePrefix}${name}: `)}`;
      }
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "Mentioned": {
      const msg = event.message;
      const name = resolveName(resolveParticipant, msg.sender_id, msg.sender_name);
      const ref = mkRef(msg.id);
      const linePrefix = `${ts}${ref} ${r}⚡ `;
      const text = `${linePrefix}${name}: ${formatMultilineContent(msg.content, roomLabel, `${linePrefix}${name}: `)}`;
      const parts: ContentPart[] = [{ type: "text", text }];
      if (msg.image_url) parts.push({ type: "image", url: msg.image_url });
      return parts;
    }
    case "ToolUse":
      return null;
    case "Activity":
      return null;
    case "ReactionAdded": {
      const name = resolveName(resolveParticipant, event.participant_id);
      const targetRef = reactionTarget ? ` to ${mkRef(event.message_id)}` : "";
      return [{ type: "text", text: `${ts}${r}${name} reacted ${event.emoji}${targetRef}` }];
    }
    case "ReactionRemoved":
      return null;
    case "ParticipantJoined": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}+ ${name} joined` }];
    }
    case "ParticipantLeft": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}- ${name} left` }];
    }
    case "ParticipantKicked": {
      const name = event.participant?.name ?? "someone";
      return [{ type: "text", text: `${ts}${r}${name} was kicked` }];
    }
    case "AuthorityChanged": {
      const name = event.participant?.name ?? "someone";
      if (event.new_authority === "guest") {
        return [{ type: "text", text: `${ts}${r}${name} was muted` }];
      }
      if (event.new_authority === "member") {
        return [{ type: "text", text: `${ts}${r}${name} was unmuted` }];
      }
      return [{ type: "text", text: `${ts}${r}${name} → ${event.new_authority}` }];
    }
    case "ContextCompacted":
      return null;
    default:
      return null;
  }
}
