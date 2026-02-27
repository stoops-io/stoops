/** Tests for engagement — classifyEvent function and StoopsEngagement class. */

import { describe, test, expect } from "vitest";
import { classifyEvent, StoopsEngagement } from "../src/agent/engagement.js";
import { createEvent } from "../src/core/events.js";
import type {
  MessageSentEvent,
  MentionedEvent,
  ToolUseEvent,
  ActivityEvent,
  ReactionAddedEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
} from "../src/core/events.js";

const SELF = "agent_quinn";
const HUMAN_ID = "user_human";
const PERSON_ID = "user_person"; // agent's person (owner)
const OTHER_HUMAN = "user_other";
const OTHER_AGENT = "agent_ash";

const BASE = { room_id: "test" };

function makeMessage(senderId: string, content = "hello") {
  return createEvent<MessageSentEvent>({
    type: "MessageSent",
    category: "MESSAGE",
    ...BASE,
    participant_id: senderId,
    message: {
      id: "m1",
      room_id: "test",
      sender_id: senderId,
      sender_name: "Sender",
      content,
      reply_to_id: null,
      timestamp: new Date(),
    },
  });
}

function makeMentioned(mentionedId: string, senderId: string) {
  return createEvent<MentionedEvent>({
    type: "Mentioned",
    category: "MENTION",
    ...BASE,
    participant_id: mentionedId,
    message: {
      id: "m2",
      room_id: "test",
      sender_id: senderId,
      sender_name: "Sender",
      content: `@${mentionedId} hey`,
      reply_to_id: null,
      timestamp: new Date(),
    },
  });
}

function makeToolUse(participantId: string) {
  return createEvent<ToolUseEvent>({
    type: "ToolUse",
    category: "ACTIVITY",
    ...BASE,
    participant_id: participantId,
    tool_name: "list_messages",
    status: "started",
  });
}

function makeReaction(participantId: string) {
  return createEvent<ReactionAddedEvent>({
    type: "ReactionAdded",
    category: "MESSAGE",
    ...BASE,
    participant_id: participantId,
    message_id: "m1",
    emoji: "👍",
  });
}

function makeJoined(participantId: string) {
  return createEvent<ParticipantJoinedEvent>({
    type: "ParticipantJoined",
    category: "PRESENCE",
    ...BASE,
    participant_id: participantId,
    participant: { id: participantId, name: "Newcomer", status: "online", type: "human" },
  });
}

function makeLeft(participantId: string) {
  return createEvent<ParticipantLeftEvent>({
    type: "ParticipantLeft",
    category: "PRESENCE",
    ...BASE,
    participant_id: participantId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyEvent (standalone pure function)
// ═══════════════════════════════════════════════════════════════════════════════

// --- standby-everyone mode ---

describe("standby-everyone mode", () => {
  test("Mentioned to self → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("Mentioned to other → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from human → drop", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from agent → drop", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "standby-everyone", SELF, "agent",OTHER_AGENT)).toBe("drop");
  });

  test("ParticipantJoined → drop", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "standby-everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });
});

// --- people mode ---

describe("people mode", () => {
  test("human MessageSent → trigger", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("agent MessageSent → content", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "people", SELF, "agent",OTHER_AGENT)).toBe("content");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ReactionAdded → content", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ToolUse → drop (internal)", () => {
    expect(classifyEvent(makeToolUse(HUMAN_ID), "people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "people", SELF, "agent",SELF)).toBe("drop");
  });
});

// --- me mode ---

describe("me mode", () => {
  test("person's MessageSent → trigger", () => {
    expect(classifyEvent(makeMessage(PERSON_ID), "me", SELF, "human", PERSON_ID, PERSON_ID)).toBe("trigger");
  });

  test("other human MessageSent → content (not trigger)", () => {
    expect(classifyEvent(makeMessage(OTHER_HUMAN), "me", SELF, "human", OTHER_HUMAN, PERSON_ID)).toBe("content");
  });

  test("agent MessageSent → content", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "me", SELF, "agent",OTHER_AGENT, PERSON_ID)).toBe("content");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "me", SELF, "human", HUMAN_ID, PERSON_ID)).toBe("drop");
  });

  test("no personId provided — all humans → content (safe fallback)", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "me", SELF, "human", HUMAN_ID, undefined)).toBe("content");
  });

  test("ParticipantJoined → content", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "me", SELF, "human", HUMAN_ID, PERSON_ID)).toBe("content");
  });

  test("ReactionAdded → content", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "me", SELF, "human", HUMAN_ID, PERSON_ID)).toBe("content");
  });

  test("ToolUse → drop (internal)", () => {
    expect(classifyEvent(makeToolUse(HUMAN_ID), "me", SELF, "human", HUMAN_ID, PERSON_ID)).toBe("drop");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "me", SELF, "agent",SELF, PERSON_ID)).toBe("drop");
  });
});

// --- everyone mode ---

describe("everyone mode", () => {
  test("MessageSent from human → trigger", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("MessageSent from agent → trigger", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "everyone", SELF, "agent",OTHER_AGENT)).toBe("trigger");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ToolUse → drop (internal)", () => {
    expect(classifyEvent(makeToolUse(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ReactionAdded → content", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "everyone", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "everyone", SELF, "agent",SELF)).toBe("drop");
  });
});

// --- agents mode ---

describe("agents mode", () => {
  test("agent MessageSent → trigger", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "agents", SELF, "agent",OTHER_AGENT)).toBe("trigger");
  });

  test("human MessageSent → content", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("Mentioned to self → drop (dedup)", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("ParticipantJoined → content (ambient)", () => {
    expect(classifyEvent(makeJoined(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ParticipantLeft → content (ambient)", () => {
    expect(classifyEvent(makeLeft(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ReactionAdded → content (ambient)", () => {
    expect(classifyEvent(makeReaction(HUMAN_ID), "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("ContextCompacted → content", () => {
    const event = createEvent<{ type: "ContextCompacted"; category: "ACTIVITY"; room_id: string; participant_id: string; participant: { id: string; name: string; status: string; type: "human" | "agent" } }>({
      type: "ContextCompacted",
      category: "ACTIVITY",
      ...BASE,
      participant_id: HUMAN_ID,
      participant: { id: HUMAN_ID, name: "Human", status: "online", type: "human" },
    });
    expect(classifyEvent(event as any, "agents", SELF, "human", HUMAN_ID)).toBe("content");
  });

  test("own MessageSent → drop", () => {
    expect(classifyEvent(makeMessage(SELF), "agents", SELF, "agent",SELF)).toBe("drop");
  });
});

// --- standby-me mode ---

describe("standby-me mode", () => {
  test("Mentioned to self from person → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, PERSON_ID), "standby-me", SELF, "human", PERSON_ID, PERSON_ID)).toBe("trigger");
  });

  test("Mentioned to self from other human → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_HUMAN), "standby-me", SELF, "human", OTHER_HUMAN, PERSON_ID)).toBe("drop");
  });

  test("Mentioned to self from agent → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_AGENT), "standby-me", SELF, "agent",OTHER_AGENT, PERSON_ID)).toBe("drop");
  });

  test("Mentioned to other (not self) from person → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, PERSON_ID), "standby-me", SELF, "human", PERSON_ID, PERSON_ID)).toBe("drop");
  });

  test("MessageSent from person → drop", () => {
    expect(classifyEvent(makeMessage(PERSON_ID), "standby-me", SELF, "human", PERSON_ID, PERSON_ID)).toBe("drop");
  });

  test("no personId provided → drop even if mentioned", () => {
    expect(classifyEvent(makeMentioned(SELF, PERSON_ID), "standby-me", SELF, "human", PERSON_ID, undefined)).toBe("drop");
  });
});

// --- standby-people mode ---

describe("standby-people mode", () => {
  test("Mentioned to self from human → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("trigger");
  });

  test("Mentioned to self from agent → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_AGENT), "standby-people", SELF, "agent",OTHER_AGENT)).toBe("drop");
  });

  test("Mentioned to other (not self) from human → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("MessageSent from human → drop", () => {
    expect(classifyEvent(makeMessage(HUMAN_ID), "standby-people", SELF, "human", HUMAN_ID)).toBe("drop");
  });
});

// --- standby-agents mode ---

describe("standby-agents mode", () => {
  test("Mentioned to self from agent → trigger", () => {
    expect(classifyEvent(makeMentioned(SELF, OTHER_AGENT), "standby-agents", SELF, "agent",OTHER_AGENT)).toBe("trigger");
  });

  test("Mentioned to self from human → drop", () => {
    expect(classifyEvent(makeMentioned(SELF, HUMAN_ID), "standby-agents", SELF, "human", HUMAN_ID)).toBe("drop");
  });

  test("Mentioned to other (not self) from agent → drop", () => {
    expect(classifyEvent(makeMentioned(OTHER_AGENT, OTHER_AGENT), "standby-agents", SELF, "agent",OTHER_AGENT)).toBe("drop");
  });

  test("MessageSent from agent → drop", () => {
    expect(classifyEvent(makeMessage(OTHER_AGENT), "standby-agents", SELF, "agent",OTHER_AGENT)).toBe("drop");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// StoopsEngagement (stateful class with per-room modes)
// ═══════════════════════════════════════════════════════════════════════════════

describe("StoopsEngagement", () => {
  test("getMode returns default when no mode set", () => {
    const eng = new StoopsEngagement("people");
    expect(eng.getMode("room-1")).toBe("people");
  });

  test("setMode / getMode round-trips", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "everyone");
    expect(eng.getMode("room-1")).toBe("everyone");
  });

  test("onRoomDisconnected reverts to default", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "me");
    eng.onRoomDisconnected("room-1");
    expect(eng.getMode("room-1")).toBe("people");
  });

  test("classify uses per-room mode", () => {
    const eng = new StoopsEngagement("people", PERSON_ID);
    eng.setMode("room-1", "me");
    // person's message in me mode → trigger
    expect(eng.classify(makeMessage(PERSON_ID), "room-1", SELF, "human", PERSON_ID)).toBe("trigger");
    // other human in me mode → content
    expect(eng.classify(makeMessage(OTHER_HUMAN), "room-1", SELF, "human", OTHER_HUMAN)).toBe("content");
  });

  test("classify uses default mode for unset rooms", () => {
    const eng = new StoopsEngagement("everyone");
    // everyone mode: human message → trigger
    expect(eng.classify(makeMessage(HUMAN_ID), "room-1", SELF, "human", HUMAN_ID)).toBe("trigger");
    // everyone mode: agent message → trigger
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-1", SELF, "agent",OTHER_AGENT)).toBe("trigger");
  });

  test("classify with personParticipantId in standby-me", () => {
    const eng = new StoopsEngagement("standby-me", PERSON_ID);
    // person @mentions self → trigger
    expect(eng.classify(makeMentioned(SELF, PERSON_ID), "room-1", SELF, "human", PERSON_ID)).toBe("trigger");
    // other human @mentions self → drop
    expect(eng.classify(makeMentioned(SELF, OTHER_HUMAN), "room-1", SELF, "human", OTHER_HUMAN)).toBe("drop");
  });

  test("different rooms have independent modes", () => {
    const eng = new StoopsEngagement("people");
    eng.setMode("room-1", "everyone");
    eng.setMode("room-2", "me");
    // room-1 (everyone): agent message → trigger
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-1", SELF, "agent",OTHER_AGENT)).toBe("trigger");
    // room-2 (me without person): agent message → content
    expect(eng.classify(makeMessage(OTHER_AGENT), "room-2", SELF, "agent",OTHER_AGENT)).toBe("content");
  });
});
