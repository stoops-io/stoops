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
const quinn: Participant = { id: "quinn-id", name: "Quinn", status: "online", type: "agent", identifier: "quinn" };

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
    // New format: #ref before room label, no parentheses
    expect(text).toMatch(/#[a-z0-9]+/);
    expect(text).not.toContain("(#");
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
    expect(text).not.toContain("[Kitchen]");
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
    expect(text).toContain("#9999");
  });

  test("no type labels in event output", () => {
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
    // No type labels in new format
    expect(text).not.toContain("[agent]");
    expect(text).not.toContain("[human]");
    expect(text).toContain("Quinn");
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
    expect(text).toContain("Ghost");
  });
});

// ── MessageSent with reply context ───────────────────────────────────────────

describe("MessageSent with reply context", () => {
  test("reply context shows sender name and arrow", () => {
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
    expect(text).toContain("→");
    expect(text).toContain("Alice");
    expect(text).toContain("great point!");
    expect(text).toContain("[Kitchen]");
  });

  test("reply uses ref-based format, not quoted content", () => {
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
    // New format uses ref, not quoted content
    expect(text).toContain("→");
    expect(text).toContain("Alice");
    // Content is NOT quoted in replies anymore
    expect(text).not.toContain('"');
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
    expect(text).toContain("@Quinn what do you think?");
    // Ref without parentheses
    expect(text).toMatch(/#[a-z0-9]+/);
    expect(text).not.toContain("(#");
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
    expect(text).toContain("#4242");
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
  test("ParticipantJoined shows compact join message", () => {
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
    expect(text).toContain("+ Alice joined");
  });

  test("ParticipantJoined has no type label", () => {
    const event = createEvent<ParticipantJoinedEvent>({
      type: "ParticipantJoined",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: quinn.id,
      participant: quinn,
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    // No type labels in new format
    expect(text).not.toContain("[agent]");
    expect(text).toContain("+ Quinn joined");
  });

  test("ParticipantLeft shows compact leave message", () => {
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
    expect(text).toContain("- Alice left");
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
    expect(text).not.toContain("[Kitchen]");
    expect(text).toContain("- Alice left");
  });

  test("presence events have timestamps", () => {
    const event = createEvent<ParticipantJoinedEvent>({
      type: "ParticipantJoined",
      category: "PRESENCE",
      room_id: "room-1",
      participant_id: alice.id,
      participant: alice,
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    const text = textOf(parts);
    expect(text).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });
});

// ── ReactionAdded formatting ─────────────────────────────────────────────────

describe("ReactionAdded formatting", () => {
  test("reaction with target uses ref-based format", () => {
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
    // New format: ref-based, not content-based
    expect(text).toContain("to #");
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

  test("reaction events have timestamps", () => {
    const event = createEvent<ReactionAddedEvent>({
      type: "ReactionAdded",
      category: "MESSAGE",
      room_id: "room-1",
      participant_id: alice.id,
      message_id: "target-msg-id",
      emoji: "\uD83D\uDC4D",
    });

    const parts = formatEvent(event, resolve);
    const text = textOf(parts);
    expect(text).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });
});

// ── ContextCompacted returns null ────────────────────────────────────────────

describe("ContextCompacted returns null", () => {
  test("ContextCompacted returns null (no longer formatted)", () => {
    const event = createEvent<ContextCompactedEvent>({
      type: "ContextCompacted",
      category: "ACTIVITY",
      room_id: "room-1",
      participant_id: quinn.id,
      participant: quinn,
    });

    const parts = formatEvent(event, resolve, null, "Kitchen");
    expect(parts).toBeNull();
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

  test("participantLabel shows 'human' for humans (legacy)", () => {
    expect(participantLabel(alice)).toBe("[human] Alice");
  });

  test("participantLabel shows 'agent' for agent type (legacy)", () => {
    expect(participantLabel(quinn)).toBe("[agent] Quinn");
  });

  test("participantLabel returns fallback for null", () => {
    expect(participantLabel(null)).toBe("someone");
    expect(participantLabel(null, "Unknown")).toBe("Unknown");
  });
});
