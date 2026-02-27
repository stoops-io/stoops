/** Tests for formatEvent — converting typed RoomEvents into ContentPart[] for the LLM. */

import { describe, test, expect } from "vitest";
import { createEvent } from "../src/core/events.js";
import { formatEvent, participantLabel, messageRef } from "../src/agent/prompts.js";
import type {
  MessageSentEvent,
  MentionedEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  ContextCompactedEvent,
  ToolUseEvent,
  ActivityEvent,
} from "../src/core/events.js";
import type { Participant } from "../src/core/types.js";
import type { ContentPart } from "../src/agent/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const alice: Participant = { id: "alice-id", name: "Alice", status: "online", type: "human" };
const quinn: Participant = { id: "quinn-id", name: "Quinn", status: "online", type: "stoop", identifier: "quinn" };

const participants = new Map<string, Participant>([
  [alice.id, alice],
  [quinn.id, quinn],
]);

function resolve(id: string): Participant | null {
  return participants.get(id) ?? null;
}

/** Extract text from the first ContentPart in a result, or null. */
function textOf(parts: ContentPart[] | null): string | null {
  if (!parts || parts.length === 0) return null;
  const first = parts[0];
  return first.type === "text" ? first.text : null;
}

// ── MessageSent formatting ───────────────────────────────────────────────────

describe("MessageSent formatting", () => {
  test("basic message with room label and ref", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "abcd-1234-5678-9abc",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "hello everyone",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    expect(parts).not.toBeNull();
    const text = textOf(parts);
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Alice");
    expect(text).toContain("hello everyone");
    // Should contain a ref like (#abcd) — the static hex ref from messageRef
    expect(text).toMatch(/\(#[a-z0-9]+\)/);
  });

  test("message without room label omits prefix", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "abcd-1234-5678-9abc",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "hi",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    // No room label prefix — text should NOT contain a "[RoomName]" bracket pair
    // (timestamps use brackets too, e.g. [12:00:00], but there's no room label)
    expect(text).not.toMatch(/\] \[/); // no "] [" which would indicate room label after timestamp
    // But should still have the participant label and content
    expect(text).toContain("Alice");
    expect(text).toContain("hi");
  });

  test("message with custom assignRef uses the returned ref", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "msg-uuid-here",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "test message",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve, null, "Kitchen", null, () => "9999");
    const text = textOf(parts);
    expect(text).toContain("(#9999)");
  });

  test("stoop participant gets robot emoji label", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: quinn.id,
      message: {
        id: "msg-id",
        room_id: "room-1",
        sender_id: quinn.id,
        sender_name: "Quinn",
        content: "I am a stoop",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    expect(text).toContain("\uD83E\uDD16 Quinn"); // robot emoji
  });

  test("unknown sender falls back to sender_name from message", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: "unknown-id",
      message: {
        id: "msg-id",
        room_id: "room-1",
        sender_id: "unknown-id",
        sender_name: "Ghost",
        content: "who am I?",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    // participantLabel returns the fallback sender_name when resolve returns null
    expect(text).toContain("Ghost");
  });
});

// ── MessageSent with reply context ───────────────────────────────────────────

describe("MessageSent with reply context", () => {
  test("reply context shows quoted original message", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: quinn.id,
      message: {
        id: "reply-msg-id",
        room_id: "room-1",
        sender_id: quinn.id,
        sender_name: "Quinn",
        content: "great point!",
        reply_to_id: "original-msg-id",
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const replyCtx = { senderName: "Alice", content: "I think we should refactor" };
    const parts = formatEvent(event, resolve, replyCtx, "Kitchen");
    const text = textOf(parts);
    expect(text).toContain("Alice");
    expect(text).toContain("I think we should refactor");
    expect(text).toContain("great point!");
    expect(text).toContain("[Kitchen]");
  });

  test("long reply context is truncated to 60 chars", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: quinn.id,
      message: {
        id: "reply-msg-id",
        room_id: "room-1",
        sender_id: quinn.id,
        sender_name: "Quinn",
        content: "agreed",
        reply_to_id: "original-msg-id",
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const longContent = "A".repeat(100);
    const replyCtx = { senderName: "Alice", content: longContent };
    const parts = formatEvent(event, resolve, replyCtx);
    const text = textOf(parts);
    // Should be truncated — the first 57 chars + "..."
    expect(text).toContain("A".repeat(57) + "...");
    expect(text).not.toContain("A".repeat(58));
  });

  test("reply_to_id present but no replyContext skips reply formatting", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "reply-msg-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "replying",
        reply_to_id: "some-old-msg",
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    // No replyContext passed — should format as a normal message
    const parts = formatEvent(event, resolve, null);
    const text = textOf(parts);
    expect(text).toContain("Alice");
    expect(text).toContain("replying");
    // Should NOT contain reply arrow notation
    expect(text).not.toContain("\u2192");
  });
});

// ── Mentioned formatting ─────────────────────────────────────────────────────

describe("Mentioned formatting", () => {
  test("mention includes lightning bolt, content, and ref", () => {
    const event = createEvent<MentionedEvent>({
      type: "Mentioned",
      category: "MENTION",
      room_id: "room-1",
      participant_id: quinn.id, // the mentioned participant
      message: {
        id: "mention-msg-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "@Quinn what do you think?",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    const text = textOf(parts);
    expect(text).toContain("\u26A1"); // lightning bolt
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Alice");
    expect(text).toContain("mentioned you");
    expect(text).toContain("@Quinn what do you think?");
    // Should contain a ref
    expect(text).toMatch(/\(#[a-z0-9]+\)/);
  });

  test("mention with custom assignRef", () => {
    const event = createEvent<MentionedEvent>({
      type: "Mentioned",
      category: "MENTION",
      room_id: "room-1",
      participant_id: quinn.id,
      message: {
        id: "mention-msg-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "@Quinn hi",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve, null, undefined, null, () => "4242");
    const text = textOf(parts);
    expect(text).toContain("(#4242)");
  });

  test("mention with image includes image ContentPart", () => {
    const event = createEvent<MentionedEvent>({
      type: "Mentioned",
      category: "MENTION",
      room_id: "room-1",
      participant_id: quinn.id,
      message: {
        id: "mention-img-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "@Quinn look at this",
        reply_to_id: null,
        image_url: "https://cdn.example.com/photo.jpg",
        image_mime_type: "image/jpeg",
        image_size_bytes: 5000,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(2);
    expect(parts![0].type).toBe("text");
    expect(parts![1].type).toBe("image");
    expect((parts![1] as { type: "image"; url: string }).url).toBe("https://cdn.example.com/photo.jpg");
  });
});

// ── ParticipantJoined/Left formatting ────────────────────────────────────────

describe("ParticipantJoined/Left formatting", () => {
  test("ParticipantJoined shows join message with participant label", () => {
    const event = createEvent<ParticipantJoinedEvent>({
      type: "ParticipantJoined",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: alice.id,
      participant: alice,
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    const text = textOf(parts);
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Alice");
    expect(text).toContain("joined the chat");
  });

  test("ParticipantJoined for stoop shows robot emoji", () => {
    const event = createEvent<ParticipantJoinedEvent>({
      type: "ParticipantJoined",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: quinn.id,
      participant: quinn,
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    expect(text).toContain("\uD83E\uDD16 Quinn");
    expect(text).toContain("joined the chat");
  });

  test("ParticipantLeft shows leave message", () => {
    const event = createEvent<ParticipantLeftEvent>({
      type: "ParticipantLeft",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: alice.id,
      participant: alice,
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    const text = textOf(parts);
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Alice");
    expect(text).toContain("left the chat");
  });

  test("ParticipantLeft without room label omits prefix", () => {
    const event = createEvent<ParticipantLeftEvent>({
      type: "ParticipantLeft",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: alice.id,
      participant: alice,
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    // No room label prefix — timestamps still use brackets, but there should be
    // no second bracket pair for a room label
    expect(text).not.toMatch(/\] \[/);
    expect(text).toContain("left the chat");
  });
});

// ── ReactionAdded formatting ─────────────────────────────────────────────────

describe("ReactionAdded formatting", () => {
  test("reaction to self message", () => {
    const event = createEvent<ReactionAddedEvent>({
      type: "ReactionAdded",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "target-msg-id",
      emoji: "\uD83D\uDC4D",
    });

    const reactionTarget = {
      senderName: "Quinn",
      content: "I posted this message",
      isSelf: true,
    };

    const parts = formatEvent(event, resolve, null, "Kitchen", reactionTarget);
    const text = textOf(parts);
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Alice");
    expect(text).toContain("\uD83D\uDC4D");
    expect(text).toContain("your message");
    expect(text).toContain("I posted this message");
  });

  test("reaction to someone else's message", () => {
    const event = createEvent<ReactionAddedEvent>({
      type: "ReactionAdded",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "target-msg-id",
      emoji: "\u2764\uFE0F",
    });

    const reactionTarget = {
      senderName: "Bob",
      content: "Bob said this",
      isSelf: false,
    };

    const parts = formatEvent(event, resolve, null, "Kitchen", reactionTarget);
    const text = textOf(parts);
    expect(text).toContain("Alice");
    expect(text).toContain("\u2764\uFE0F");
    expect(text).toContain("Bob's");
    expect(text).toContain("Bob said this");
    expect(text).not.toContain("your message");
  });

  test("reaction without target context shows minimal text", () => {
    const event = createEvent<ReactionAddedEvent>({
      type: "ReactionAdded",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "target-msg-id",
      emoji: "\uD83D\uDE00",
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    expect(text).toContain("Alice");
    expect(text).toContain("\uD83D\uDE00");
    expect(text).toContain("reacted");
  });

  test("long reaction target content is truncated to 40 chars", () => {
    const event = createEvent<ReactionAddedEvent>({
      type: "ReactionAdded",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "msg-id",
      emoji: "\uD83D\uDC4D",
    });

    const longContent = "X".repeat(60);
    const reactionTarget = {
      senderName: "Bob",
      content: longContent,
      isSelf: false,
    };

    const parts = formatEvent(event, resolve, null, undefined, reactionTarget);
    const text = textOf(parts);
    // Truncated to 37 chars + "..."
    expect(text).toContain("X".repeat(37) + "...");
    expect(text).not.toContain("X".repeat(38));
  });
});

// ── ContextCompacted formatting ──────────────────────────────────────────────

describe("ContextCompacted formatting", () => {
  test("ContextCompacted shows memory refreshed message", () => {
    const event = createEvent<ContextCompactedEvent>({
      type: "ContextCompacted",
      category: "ACTIVITY",
      room_id: "room-1",
      participant_id: quinn.id,
      participant: quinn,
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    const text = textOf(parts);
    expect(text).toContain("[Kitchen]");
    expect(text).toContain("Quinn");
    expect(text).toContain("memory was refreshed");
  });

  test("ContextCompacted without room label", () => {
    const event = createEvent<ContextCompactedEvent>({
      type: "ContextCompacted",
      category: "ACTIVITY",
      room_id: "room-1",
      participant_id: quinn.id,
      participant: quinn,
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    // No room label prefix — timestamps still use brackets, but no room label
    expect(text).not.toMatch(/\] \[/);
    expect(text).toContain("memory was refreshed");
  });
});

// ── ToolUse and Activity return null ─────────────────────────────────────────

describe("ToolUse and Activity return null", () => {
  test("ToolUse returns null", () => {
    const event = createEvent<ToolUseEvent>({
      type: "ToolUse",
      category: "ACTIVITY",
      room_id: "room-1",
      participant_id: quinn.id,
      tool_name: "send_message",
      status: "started",
    });

    const parts = formatEvent(event, resolve);
    expect(parts).toBeNull();
  });

  test("Activity returns null", () => {
    const event = createEvent<ActivityEvent>({
      type: "Activity",
      category: "ACTIVITY",
      room_id: "room-1",
      participant_id: quinn.id,
      action: "mode_changed",
      detail: { mode: "everyone" },
    });

    const parts = formatEvent(event, resolve);
    expect(parts).toBeNull();
  });
});

// ── ReactionRemoved returns null ─────────────────────────────────────────────

describe("ReactionRemoved returns null", () => {
  test("ReactionRemoved returns null", () => {
    const event = createEvent<ReactionRemovedEvent>({
      type: "ReactionRemoved",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "some-msg-id",
      emoji: "\uD83D\uDC4D",
    });

    const parts = formatEvent(event, resolve);
    expect(parts).toBeNull();
  });
});

// ── Image messages include image ContentPart ─────────────────────────────────

describe("image messages include image ContentPart", () => {
  test("MessageSent with image_url includes image part", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "img-msg-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "check this photo",
        reply_to_id: null,
        image_url: "https://cdn.example.com/sunset.png",
        image_mime_type: "image/png",
        image_size_bytes: 45000,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(2);

    const textPart = parts![0];
    expect(textPart.type).toBe("text");
    expect((textPart as { type: "text"; text: string }).text).toContain("check this photo");

    const imagePart = parts![1];
    expect(imagePart.type).toBe("image");
    expect((imagePart as { type: "image"; url: string }).url).toBe("https://cdn.example.com/sunset.png");
  });

  test("MessageSent without image_url has only text part", () => {
    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message: {
        id: "text-msg-id",
        room_id: "room-1",
        sender_id: alice.id,
        sender_name: "Alice",
        content: "just text",
        reply_to_id: null,
        image_url: null,
        image_mime_type: null,
        image_size_bytes: null,
        timestamp: new Date("2026-01-15T12:00:00Z"),
      },
    });

    const parts = formatEvent(event, resolve);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(1);
    expect(parts![0].type).toBe("text");
  });
});

// ── Helper function tests ────────────────────────────────────────────────────

describe("helper functions", () => {
  test("messageRef strips hyphens and takes first 4 chars", () => {
    expect(messageRef("abcd-1234-5678-9abc")).toBe("abcd");
    expect(messageRef("12345678-abcd-efgh-ijkl")).toBe("1234");
  });

  test("participantLabel shows human emoji for humans", () => {
    expect(participantLabel(alice)).toBe("\uD83D\uDC64 Alice");
  });

  test("participantLabel shows robot emoji for stoops", () => {
    expect(participantLabel(quinn)).toBe("\uD83E\uDD16 Quinn");
  });

  test("participantLabel returns fallback for null", () => {
    expect(participantLabel(null)).toBe("someone");
    expect(participantLabel(null, "Unknown")).toBe("Unknown");
  });
});
