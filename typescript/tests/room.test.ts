/** Tests for the room core: Room, Channel, events, storage. */

import { describe, test, expect } from "vitest";
import { Channel } from "../src/core/channel.js";
import { Room } from "../src/core/room.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { EventCategory } from "../src/core/types.js";
import { createEvent } from "../src/core/events.js";
import type { Participant } from "../src/core/types.js";
import type {
  ActivityEvent,
  MentionedEvent,
  MessageSentEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  RoomEvent,
} from "../src/core/events.js";

/** Collect all pending events from a channel with a timeout. */
async function drain(channel: Channel, timeout = 50): Promise<RoomEvent[]> {
  const events: RoomEvent[] = [];
  while (true) {
    const event = await channel.receive(timeout);
    if (event === null) break;
    events.push(event);
  }
  return events;
}

// --- Connect / Disconnect ---

describe("connect / disconnect", () => {
  test("connect returns channel", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice", "human");
    expect(ch).toBeInstanceOf(Channel);
    expect(ch.participantId).toBe("alice");
    expect(ch.roomId).toBe("test");
  });

  test("connect defaults type to human", async () => {
    const room = new Room("test");
    await room.connect("alice", "Alice");
    const participants = room.listParticipants();
    expect(participants[0].type).toBe("human");
  });

  test("connect as stoop sets type", async () => {
    const room = new Room("test");
    await room.connect("quinn", "Quinn", "stoop");
    const participants = room.listParticipants();
    expect(participants[0].type).toBe("stoop");
  });

  test("connect with identifier stores it on participant", async () => {
    const room = new Room("test");
    await room.connect("quinn", "Quinn", "stoop", "quinn");
    const participants = room.listParticipants();
    expect(participants[0].identifier).toBe("quinn");
  });

  test("connect without identifier leaves identifier undefined", async () => {
    const room = new Room("test");
    await room.connect("alice", "Alice", "human");
    const participants = room.listParticipants();
    expect(participants[0].identifier).toBeUndefined();
  });

  test("connect broadcasts ParticipantJoined with correct type", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human");
    await room.connect("quinn", "Quinn", "stoop");

    // Alice should receive Quinn's ParticipantJoinedEvent
    const events = await drain(chA);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ParticipantJoined");
    const joinEvent = events[0] as ParticipantJoinedEvent;
    expect(joinEvent.participant.name).toBe("Quinn");
    expect(joinEvent.participant.type).toBe("stoop");
  });

  test("joiner does not receive own join event", async () => {
    const room = new Room("test");
    await room.connect("alice", "Alice", "human");
    const chB = await room.connect("bob", "Bob", "human");

    // Bob should NOT receive his own join event
    const events = await drain(chB);
    expect(events).toHaveLength(0);
  });

  test("disconnect broadcasts ParticipantLeft", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    await drain(chA); // clear join event

    await chB.disconnect();

    const events = await drain(chA);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ParticipantLeft");
    expect(events[0].participant_id).toBe("bob");
  });
});

// --- Silent connect / disconnect ---

describe("silent connect / disconnect", () => {
  test("silent connect does not broadcast ParticipantJoined", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human");
    await room.connect("stoop", "StoopBot", "stoop", undefined, undefined, true);

    // Alice should NOT receive ParticipantJoined for StoopBot
    const events = await drain(chA);
    expect(events).toHaveLength(0);
  });

  test("silent disconnect does not broadcast ParticipantLeft", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human");
    const chB = await room.connect("stoop", "StoopBot", "stoop", undefined, undefined, true);
    await drain(chA); // clear any events

    await chB.disconnect(true);

    const events = await drain(chA);
    expect(events).toHaveLength(0);
  });

  test("non-silent connect still broadcasts ParticipantJoined", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human");
    await room.connect("bob", "Bob", "human", undefined, undefined, false);

    const events = await drain(chA);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ParticipantJoined");
  });

  test("getMessage returns message by id", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    const msg = await ch.sendMessage("hello");
    const found = await room.getMessage(msg.id);
    expect(found).not.toBeNull();
    expect(found!.content).toBe("hello");
  });

  test("getMessage returns null for unknown id", async () => {
    const room = new Room("test");
    const result = await room.getMessage("nonexistent");
    expect(result).toBeNull();
  });
});

// --- Messages ---

describe("messages", () => {
  test("send message broadcasts to all", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    await drain(chA);
    await drain(chB);

    const msg = await chA.sendMessage("Hello!");

    expect(msg.content).toBe("Hello!");
    expect(msg.sender_id).toBe("alice");
    expect(msg.sender_name).toBe("Alice");
    expect(msg.room_id).toBe("test");

    // Alice receives her own message (sender receives MessageSentEvent)
    const eventsA = await drain(chA);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].type).toBe("MessageSent");
    expect((eventsA[0] as MessageSentEvent).message.content).toBe("Hello!");

    // Bob receives it too
    const eventsB = await drain(chB);
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].type).toBe("MessageSent");
    expect((eventsB[0] as MessageSentEvent).message.content).toBe("Hello!");
  });

  test("send message with reply", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    const msg1 = await ch.sendMessage("First");
    const msg2 = await ch.sendMessage("Reply", msg1.id);
    expect(msg2.reply_to_id).toBe(msg1.id);
  });

  test("send message with image metadata", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");

    const msg = await ch.sendMessage("Check this", null, {
      url: "https://cdn.example.com/image.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12345,
    });

    expect(msg.image_url).toBe("https://cdn.example.com/image.jpg");
    expect(msg.image_mime_type).toBe("image/jpeg");
    expect(msg.image_size_bytes).toBe(12345);

    const events = await drain(ch);
    expect(events).toHaveLength(1);
    const event = events[0] as MessageSentEvent;
    expect(event.message.image_url).toBe("https://cdn.example.com/image.jpg");
  });
});

// --- Subscription filtering ---

describe("subscription filtering", () => {
  test("ghost only gets mentions", async () => {
    const room = new Room("test");
    const chHuman = await room.connect("human", "Human", "human");
    const chGhost = await room.connect(
      "ghost",
      "Ghost",
      "stoop",
      undefined,
      new Set([EventCategory.MENTION]),
    );
    await drain(chHuman);
    await drain(chGhost);

    // Send a normal message — ghost should NOT get it
    await chHuman.sendMessage("hey everyone");
    let events = await drain(chGhost);
    expect(events).toHaveLength(0);

    // Send a message mentioning ghost — ghost SHOULD get it
    await chHuman.sendMessage("hey @Ghost what do you think?");
    events = await drain(chGhost);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("Mentioned");
  });

  test("listen mode gets messages but not activity", async () => {
    const room = new Room("test");
    const chHuman = await room.connect("human", "Human", "human");
    const chListener = await room.connect(
      "listener",
      "Listener",
      "stoop",
      undefined,
      new Set([EventCategory.MESSAGE, EventCategory.MENTION]),
    );
    await drain(chHuman);
    await drain(chListener);

    // Send message — listener gets MessageSentEvent
    await chHuman.sendMessage("hello");
    let events = await drain(chListener);
    expect(events.some((e) => e.type === "MessageSent")).toBe(true);

    // Activity event — listener does NOT get it
    const activityEvent = createEvent<ActivityEvent>({
      type: "Activity",
      category: "ACTIVITY",
      room_id: "test",
      participant_id: "human",
      action: "typing",
      detail: { started: true },
    });
    await chHuman.emit(activityEvent);
    events = await drain(chListener);
    expect(events).toHaveLength(0);
  });
});

// --- Emit activity events ---

describe("emit activity events", () => {
  test("emit generic activity", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    await drain(chA);
    await drain(chB);

    const activity = createEvent<ActivityEvent>({
      type: "Activity",
      category: "ACTIVITY",
      room_id: "test",
      participant_id: "alice",
      action: "browsing",
      detail: { url: "https://example.com" },
    });
    await chA.emit(activity);

    const events = await drain(chB);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("Activity");
    expect((events[0] as ActivityEvent).action).toBe("browsing");
  });
});

// --- Update subscriptions ---

describe("update subscriptions", () => {
  test("switch from ghost to engaged", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human");
    const chB = await room.connect(
      "bob",
      "Bob",
      "stoop",
      undefined,
      new Set([EventCategory.MENTION]),
    );
    await drain(chA);
    await drain(chB);

    // Bob in ghost mode — doesn't get messages
    await chA.sendMessage("hello");
    let events = await drain(chB);
    expect(events).toHaveLength(0);

    // Switch Bob to engaged mode
    chB.updateSubscriptions(
      new Set([
        EventCategory.MESSAGE,
        EventCategory.PRESENCE,
        EventCategory.ACTIVITY,
        EventCategory.MENTION,
      ]),
    );

    await chA.sendMessage("hello again");
    events = await drain(chB);
    expect(events.some((e) => e.type === "MessageSent")).toBe(true);
  });
});

// --- @mention detection ---

describe("mention detection", () => {
  test("mention detection by display name", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    await drain(chA);
    await drain(chB);

    await chA.sendMessage("hey @Bob check this out");

    const events = await drain(chB);
    const types = new Set(events.map((e) => e.type));
    expect(types.has("MessageSent")).toBe(true);
    expect(types.has("Mentioned")).toBe(true);
  });

  test("mention case insensitive", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    await drain(chA);
    await drain(chB);

    await chA.sendMessage("hey @bob you there?");

    const events = await drain(chB);
    const types = new Set(events.map((e) => e.type));
    expect(types.has("Mentioned")).toBe(true);
  });

  test("@identifier finds participant", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human", "alice");
    const chB = await room.connect("bob-id", "Robert", "human", "bob");
    await drain(chA);
    await drain(chB);

    // @bob matches identifier "bob", not display name "Robert"
    await chA.sendMessage("hey @bob you there?");

    const events = await drain(chB);
    const types = new Set(events.map((e) => e.type));
    expect(types.has("Mentioned")).toBe(true);
  });

  test("@displayname still works as fallback when no identifier", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob-id", "Robert");
    await drain(chA);
    await drain(chB);

    await chA.sendMessage("hey @Robert you there?");

    const events = await drain(chB);
    const types = new Set(events.map((e) => e.type));
    expect(types.has("Mentioned")).toBe(true);
  });

  test("no double-mention when identifier matches name lowercased", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human", "alice");
    const chB = await room.connect("bob-id", "quinn", "stoop", "quinn");
    await drain(chA);
    await drain(chB);

    // @quinn would match both identifier AND name — should only fire one mention
    await chA.sendMessage("hey @quinn what do you think?");

    const events = await drain(chB);
    const mentionEvents = events.filter((e) => e.type === "Mentioned");
    expect(mentionEvents).toHaveLength(1);
  });

  test("@identifier supports hyphenated handles", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice", "human", "alice");
    const chB = await room.connect("guest-1", "Guest One", "human", "guest-1");
    await drain(chA);
    await drain(chB);

    await chA.sendMessage("hey @guest-1 check this");

    const events = await drain(chB);
    const mentionEvents = events.filter((e) => e.type === "Mentioned");
    expect(mentionEvents).toHaveLength(1);
  });

  test("observer receives broadcast events (MessageSent, joins)", async () => {
    const room = new Room("test");
    const observer = room.observe();
    const chA = await room.connect("alice", "Alice");
    await drain(observer); // clear the join event for alice

    await chA.sendMessage("hello everyone");

    const events = await drain(observer);
    expect(events.some((e) => e.type === "MessageSent")).toBe(true);
  });

  test("observer receives MentionedEvent directed at another participant", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const chB = await room.connect("bob", "Bob");
    const observer = room.observe();
    await drain(chA);
    await drain(chB);
    await drain(observer);

    await chA.sendMessage("hey @Bob check this");

    const events = await drain(observer);
    const mentionEvents = events.filter((e) => e.type === "Mentioned");
    expect(mentionEvents).toHaveLength(1);
    expect((mentionEvents[0] as MentionedEvent).participant_id).toBe("bob");
  });

  test("observer does not appear in listParticipants", async () => {
    const room = new Room("test");
    room.observe();
    await room.connect("alice", "Alice");

    const participants = room.listParticipants();
    expect(participants).toHaveLength(1);
    expect(participants[0].id).toBe("alice");
  });

  test("observer disconnect is clean — no ParticipantLeft event", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const observer = room.observe();
    await drain(chA);
    await drain(observer);

    await observer.disconnect();

    const events = await drain(chA);
    expect(events).toHaveLength(0);
  });

  test("observer does not receive events after disconnect", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    const observer = room.observe();
    await drain(observer);

    await observer.disconnect();
    await chA.sendMessage("hello");

    const events = await drain(observer);
    expect(events).toHaveLength(0);
  });
});

// --- Read methods ---

describe("read methods", () => {
  test("list messages", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    await ch.sendMessage("msg1");
    await ch.sendMessage("msg2");
    await ch.sendMessage("msg3");

    const result = await room.listMessages(2);
    expect(result.items).toHaveLength(2);
    // Most recent first
    expect(result.items[0].content).toBe("msg3");
    expect(result.items[1].content).toBe("msg2");
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).not.toBeNull();
  });

  test("list messages pagination", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    for (let i = 0; i < 5; i++) {
      await ch.sendMessage(`msg${i}`);
    }

    // First page
    const page1 = await room.listMessages(2);
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].content).toBe("msg4");
    expect(page1.items[1].content).toBe("msg3");
    expect(page1.has_more).toBe(true);

    // Second page
    const page2 = await room.listMessages(2, page1.next_cursor);
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].content).toBe("msg2");
    expect(page2.items[1].content).toBe("msg1");
    expect(page2.has_more).toBe(true);

    // Third page
    const page3 = await room.listMessages(2, page2.next_cursor);
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].content).toBe("msg0");
    expect(page3.has_more).toBe(false);
  });

  test("search messages", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    await ch.sendMessage("I love pizza");
    await ch.sendMessage("Finance is boring");
    await ch.sendMessage("Pizza again");

    const result = await room.searchMessages("pizza");
    expect(result.items).toHaveLength(2);
  });

  test("list participants", async () => {
    const room = new Room("test");
    await room.connect("alice", "Alice");
    await room.connect("bob", "Bob");

    const participants = room.listParticipants();
    expect(participants).toHaveLength(2);
    const names = new Set(participants.map((p) => p.name));
    expect(names).toEqual(new Set(["Alice", "Bob"]));
  });

  test("list events", async () => {
    const room = new Room("test");
    const chA = await room.connect("alice", "Alice");
    await room.connect("bob", "Bob");
    await chA.sendMessage("hello");

    // All events
    const result = await room.listEvents();
    expect(result.items.length).toBeGreaterThan(0);

    // Filter by category
    const messages = await room.listEvents(EventCategory.MESSAGE);
    expect(messages.items.every((e) => e.type === "MessageSent")).toBe(true);

    const presence = await room.listEvents(EventCategory.PRESENCE);
    expect(presence.items.every((e) => e.type === "ParticipantJoined")).toBe(true);
  });

  test("list events pagination", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    for (let i = 0; i < 5; i++) {
      await ch.sendMessage(`msg${i}`);
    }

    const result = await room.listEvents(EventCategory.MESSAGE, 2);
    expect(result.items).toHaveLength(2);
    expect(result.has_more).toBe(true);
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  test("disconnected channel throws", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");
    await ch.disconnect();

    await expect(ch.sendMessage("hello")).rejects.toThrow("disconnected");
  });

  test("sender receives own MessageSent", async () => {
    const room = new Room("test");
    const ch = await room.connect("alice", "Alice");

    await ch.sendMessage("hello");

    const events = await drain(ch);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("MessageSent");
    expect((events[0] as MessageSentEvent).message.sender_id).toBe("alice");
  });
});
