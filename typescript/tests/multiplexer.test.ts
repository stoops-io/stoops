/** Tests for EventMultiplexer — merging N channel async streams into one labeled stream. */

import { describe, test, expect } from "vitest";
import { Room } from "../src/core/room.js";
import { EventMultiplexer } from "../src/agent/multiplexer.js";
import type { LabeledEvent } from "../src/agent/multiplexer.js";
import type { MessageSentEvent } from "../src/core/events.js";

/** Collect labeled events from the multiplexer until timeout. */
async function collectEvents(
  mux: EventMultiplexer,
  count: number,
  timeoutMs = 500,
): Promise<LabeledEvent[]> {
  const events: LabeledEvent[] = [];
  const iter = mux[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  for (let i = 0; i < count; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const result = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<LabeledEvent>>((resolve) =>
        setTimeout(() => resolve({ value: undefined as unknown as LabeledEvent, done: true }), remaining),
      ),
    ]);

    if (result.done) break;
    events.push(result.value);
  }

  return events;
}

// --- Adding channels and receiving labeled events ---

describe("adding channels and receiving labeled events", () => {
  test("events from a single channel are labeled with room ID and name", async () => {
    const room = new Room("room-1");
    const agentCh = await room.connect("agent", "Agent", "stoop");
    const humanCh = await room.connect("human", "Human", "human");

    // Drain join events from agentCh
    while ((await agentCh.receive(10)) !== null) {}

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", agentCh);

    // Send a message from the human
    await humanCh.sendMessage("hello from kitchen");

    const events = await collectEvents(mux, 1);
    expect(events).toHaveLength(1);
    expect(events[0].roomId).toBe("room-1");
    expect(events[0].roomName).toBe("Kitchen");
    expect(events[0].event.type).toBe("MessageSent");
    expect((events[0].event as MessageSentEvent).message.content).toBe("hello from kitchen");

    mux.close();
  });

  test("adding the same roomId twice is ignored", async () => {
    const room = new Room("room-1");
    const ch1 = await room.connect("agent1", "Agent1", "stoop");
    const ch2 = await room.connect("agent2", "Agent2", "stoop");

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", ch1);
    mux.addChannel("room-1", "Kitchen2", ch2); // same roomId — should be ignored

    // Only one channel entry — the second addChannel is a no-op
    // We verify by checking the mux still works with the first channel
    const humanCh = await room.connect("human", "Human", "human");
    // Drain join events
    while ((await ch1.receive(10)) !== null) {}

    await humanCh.sendMessage("test");

    const events = await collectEvents(mux, 1);
    expect(events).toHaveLength(1);
    expect(events[0].roomName).toBe("Kitchen"); // first add wins

    mux.close();
  });
});

// --- Removing a channel stops its events ---

describe("removing a channel stops its events", () => {
  test("events stop after removeChannel", async () => {
    const room = new Room("room-1");
    const agentCh = await room.connect("agent", "Agent", "stoop");
    const humanCh = await room.connect("human", "Human", "human");

    // Drain join events
    while ((await agentCh.receive(10)) !== null) {}

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", agentCh);

    // Send first message — should be received
    await humanCh.sendMessage("before remove");
    const before = await collectEvents(mux, 1);
    expect(before).toHaveLength(1);
    expect((before[0].event as MessageSentEvent).message.content).toBe("before remove");

    // Remove channel
    mux.removeChannel("room-1");

    // Send second message — should NOT be received
    await humanCh.sendMessage("after remove");
    const after = await collectEvents(mux, 1, 100);
    expect(after).toHaveLength(0);

    mux.close();
  });

  test("removing a non-existent channel is a no-op", () => {
    const mux = new EventMultiplexer();
    // Should not throw
    mux.removeChannel("nonexistent");
    mux.close();
  });
});

// --- close() terminates the iterator ---

describe("close() terminates the iterator", () => {
  test("close causes pending iterator to return done", async () => {
    const mux = new EventMultiplexer();
    const iter = mux[Symbol.asyncIterator]();

    // Start waiting for next event (will block)
    const nextPromise = iter.next();

    // Close the multiplexer
    mux.close();

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  test("iterator returns done immediately after close", async () => {
    const mux = new EventMultiplexer();
    mux.close();

    const iter = mux[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("addChannel after close is ignored", async () => {
    const room = new Room("room-1");
    const ch = await room.connect("agent", "Agent", "stoop");

    const mux = new EventMultiplexer();
    mux.close();

    // Should not throw, but should be a no-op
    mux.addChannel("room-1", "Kitchen", ch);

    const iter = mux[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("close aborts all channel listeners", async () => {
    const room1 = new Room("room-1");
    const room2 = new Room("room-2");
    const ch1 = await room1.connect("agent", "Agent", "stoop");
    const ch2 = await room2.connect("agent", "Agent", "stoop");

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", ch1);
    mux.addChannel("room-2", "Living Room", ch2);

    mux.close();

    // After close, iterating should return done immediately
    const iter = mux[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});

// --- Multiple channels interleave events ---

describe("multiple channels interleave events", () => {
  test("events from two rooms arrive in the multiplexer", async () => {
    const room1 = new Room("room-1");
    const room2 = new Room("room-2");

    const agentCh1 = await room1.connect("agent", "Agent", "stoop");
    const agentCh2 = await room2.connect("agent", "Agent", "stoop");
    const humanCh1 = await room1.connect("human1", "Human1", "human");
    const humanCh2 = await room2.connect("human2", "Human2", "human");

    // Drain join events
    while ((await agentCh1.receive(10)) !== null) {}
    while ((await agentCh2.receive(10)) !== null) {}

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", agentCh1);
    mux.addChannel("room-2", "Living Room", agentCh2);

    // Send messages from both rooms
    await humanCh1.sendMessage("kitchen message");
    await humanCh2.sendMessage("living room message");

    const events = await collectEvents(mux, 2);
    expect(events).toHaveLength(2);

    // Both rooms should be represented
    const roomNames = new Set(events.map((e) => e.roomName));
    expect(roomNames.has("Kitchen")).toBe(true);
    expect(roomNames.has("Living Room")).toBe(true);

    // Verify each event has the right room label
    const kitchenEvent = events.find((e) => e.roomName === "Kitchen")!;
    expect(kitchenEvent.roomId).toBe("room-1");
    expect((kitchenEvent.event as MessageSentEvent).message.content).toBe("kitchen message");

    const livingEvent = events.find((e) => e.roomName === "Living Room")!;
    expect(livingEvent.roomId).toBe("room-2");
    expect((livingEvent.event as MessageSentEvent).message.content).toBe("living room message");

    mux.close();
  });

  test("events from three rooms all arrive", async () => {
    const room1 = new Room("room-1");
    const room2 = new Room("room-2");
    const room3 = new Room("room-3");

    const agentCh1 = await room1.connect("agent", "Agent", "stoop");
    const agentCh2 = await room2.connect("agent", "Agent", "stoop");
    const agentCh3 = await room3.connect("agent", "Agent", "stoop");
    const humanCh1 = await room1.connect("h1", "H1", "human");
    const humanCh2 = await room2.connect("h2", "H2", "human");
    const humanCh3 = await room3.connect("h3", "H3", "human");

    // Drain join events
    while ((await agentCh1.receive(10)) !== null) {}
    while ((await agentCh2.receive(10)) !== null) {}
    while ((await agentCh3.receive(10)) !== null) {}

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Alpha", agentCh1);
    mux.addChannel("room-2", "Beta", agentCh2);
    mux.addChannel("room-3", "Gamma", agentCh3);

    await humanCh1.sendMessage("from alpha");
    await humanCh2.sendMessage("from beta");
    await humanCh3.sendMessage("from gamma");

    const events = await collectEvents(mux, 3);
    expect(events).toHaveLength(3);

    const roomNames = new Set(events.map((e) => e.roomName));
    expect(roomNames).toEqual(new Set(["Alpha", "Beta", "Gamma"]));

    mux.close();
  });

  test("removing one channel still delivers from the other", async () => {
    const room1 = new Room("room-1");
    const room2 = new Room("room-2");

    const agentCh1 = await room1.connect("agent", "Agent", "stoop");
    const agentCh2 = await room2.connect("agent", "Agent", "stoop");
    const humanCh1 = await room1.connect("h1", "H1", "human");
    const humanCh2 = await room2.connect("h2", "H2", "human");

    // Drain join events
    while ((await agentCh1.receive(10)) !== null) {}
    while ((await agentCh2.receive(10)) !== null) {}

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", agentCh1);
    mux.addChannel("room-2", "Living Room", agentCh2);

    // Remove kitchen
    mux.removeChannel("room-1");

    // Send from both rooms
    await humanCh1.sendMessage("kitchen msg");
    await humanCh2.sendMessage("living room msg");

    const events = await collectEvents(mux, 1);
    expect(events).toHaveLength(1);
    expect(events[0].roomName).toBe("Living Room");
    expect((events[0].event as MessageSentEvent).message.content).toBe("living room msg");

    mux.close();
  });

  test("buffered events drain before blocking", async () => {
    const room = new Room("room-1");
    const agentCh = await room.connect("agent", "Agent", "stoop");
    const humanCh = await room.connect("human", "Human", "human");

    // Drain join events
    while ((await agentCh.receive(10)) !== null) {}

    // Send messages BEFORE adding channel to multiplexer — they'll be buffered in the channel
    await humanCh.sendMessage("msg1");
    await humanCh.sendMessage("msg2");

    // Small delay to let events propagate to channel buffer
    await new Promise((r) => setTimeout(r, 20));

    const mux = new EventMultiplexer();
    mux.addChannel("room-1", "Kitchen", agentCh);

    // The buffered events should be picked up by the listen loop
    const events = await collectEvents(mux, 2);
    expect(events).toHaveLength(2);

    const contents = events.map((e) => (e.event as MessageSentEvent).message.content);
    expect(contents).toContain("msg1");
    expect(contents).toContain("msg2");

    mux.close();
  });
});
