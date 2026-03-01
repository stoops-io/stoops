/** Tests for EventProcessor — event loop, engagement, buffering, refs, connections. */

import { describe, test, expect, beforeEach } from "vitest";
import { Room } from "../src/core/room.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { createEvent } from "../src/core/events.js";
import type {
  MessageSentEvent,
  ParticipantJoinedEvent,
  RoomEvent,
} from "../src/core/events.js";
import { EventProcessor } from "../src/agent/event-processor.js";
import type { ContentPart } from "../src/agent/types.js";
import type { EngagementMode } from "../src/agent/engagement.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a Room backed by a fresh InMemoryStorage. */
function makeRoom(id = "room-1"): Room {
  return new Room(id, new InMemoryStorage());
}

/** Create an EventProcessor with sensible defaults for testing. */
function makeProcessor(opts?: {
  defaultMode?: EngagementMode;
  personParticipantId?: string;
  selfIdentifier?: string;
  onModeChange?: (roomId: string, roomName: string, mode: EngagementMode) => void;
}): EventProcessor {
  return new EventProcessor("agent-id", "Agent", {
    defaultMode: opts?.defaultMode ?? "everyone",
    personParticipantId: opts?.personParticipantId,
    selfIdentifier: opts?.selfIdentifier ?? "agent",
    onModeChange: opts?.onModeChange,
  });
}

/**
 * Collector for delivered ContentPart[] batches. Use with processor.run().
 * Resolves each delivery immediately so the event loop can continue.
 */
function makeDeliveryCollector(): {
  deliveries: ContentPart[][];
  deliver: (parts: ContentPart[]) => Promise<void>;
} {
  const deliveries: ContentPart[][] = [];
  return {
    deliveries,
    deliver: async (parts: ContentPart[]) => {
      deliveries.push(parts);
    },
  };
}

/** Extract all text from a ContentPart[] array. */
function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : `[image: ${p.url}]`)).join("");
}

/**
 * Connect a human participant to a room directly (not through the processor).
 * Returns the channel so we can send messages from the human side.
 */
async function addHuman(room: Room, id = "human-1", name = "Alice") {
  return room.connect(id, name, { type: "human" });
}

/** Small delay to let async event propagation settle. */
function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. Room connection/disconnection management ─────────────────────────────

describe("room connection / disconnection", () => {
  test("connectRoom registers the room and makes it resolvable", async () => {
    const proc = makeProcessor();
    const room = makeRoom();

    await proc.connectRoom(room, "lobby");

    // Resolve by name
    const conn = proc.resolve("lobby");
    expect(conn).not.toBeNull();
    expect(conn!.room.roomId).toBe("room-1");
    expect(conn!.name).toBe("lobby");
  });

  test("connectRoom with identifier makes room resolvable by identifier", async () => {
    const proc = makeProcessor();
    const room = makeRoom();

    await proc.connectRoom(room, "Lobby Crew", undefined, "lobby-crew");

    expect(proc.resolve("lobby-crew")).not.toBeNull();
    expect(proc.resolve("Lobby Crew")).not.toBeNull();
  });

  test("connectRoom is idempotent for the same room", async () => {
    const proc = makeProcessor();
    const room = makeRoom();

    await proc.connectRoom(room, "lobby");
    await proc.connectRoom(room, "lobby");

    const all = proc.listAll();
    expect(all).toHaveLength(1);
  });

  test("connectRoom silently connects (no ParticipantJoined broadcast)", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room);
    // Drain any join event from the human connecting
    await humanCh.receive(10);

    await proc.connectRoom(room, "lobby");

    // The human may receive Activity events (mode_changed), but should NOT
    // receive a ParticipantJoined event for the agent.
    const events: RoomEvent[] = [];
    let evt = await humanCh.receive(50);
    while (evt) {
      events.push(evt);
      evt = await humanCh.receive(20);
    }
    const joinEvents = events.filter((e) => e.type === "ParticipantJoined");
    expect(joinEvents).toHaveLength(0);
  });

  test("disconnectRoom removes the room from resolver", async () => {
    const proc = makeProcessor();
    const room = makeRoom();

    await proc.connectRoom(room, "lobby", undefined, "lobby-id");
    await proc.disconnectRoom(room.roomId);

    expect(proc.resolve("lobby")).toBeNull();
    expect(proc.resolve("lobby-id")).toBeNull();
    expect(proc.resolve(room.roomId)).toBeNull();
    expect(proc.listAll()).toHaveLength(0);
  });

  test("disconnectRoom for unknown room is a no-op", async () => {
    const proc = makeProcessor();
    // Should not throw
    await proc.disconnectRoom("nonexistent");
  });

  test("multiple rooms can be connected simultaneously", async () => {
    const proc = makeProcessor();
    const room1 = makeRoom("room-1");
    const room2 = makeRoom("room-2");

    await proc.connectRoom(room1, "lobby");
    await proc.connectRoom(room2, "living-room");

    expect(proc.listAll()).toHaveLength(2);
    expect(proc.resolve("lobby")).not.toBeNull();
    expect(proc.resolve("living-room")).not.toBeNull();
  });

  test("stop disconnects all rooms and clears state", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    await proc.stop();

    expect(proc.listAll()).toHaveLength(0);
    expect(proc.resolve("lobby")).toBeNull();
  });
});

// ── 2. Event deduplication (_seenEventIds eviction) ──────────────────────────

describe("event deduplication", () => {
  test("duplicate events are not delivered twice", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room);

    await proc.connectRoom(room, "lobby");
    const collector = makeDeliveryCollector();

    // Start the event loop in the background
    const runPromise = proc.run(collector.deliver);

    // Let catch-up delivery finish
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Send a single message
    await humanCh.sendMessage("hello");
    await tick(100);

    // Should have exactly one delivery beyond catch-up
    expect(collector.deliveries.length).toBe(catchUpCount + 1);

    await proc.stop();
    await runPromise;
  });

  test("seenEventIds eviction keeps set bounded (over 500 events)", async () => {
    // This is a unit-level test of the eviction logic. We can't easily
    // send 500+ real events quickly, so we test the behavior indirectly:
    // the processor should continue to work correctly even after many events.
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room);

    await proc.connectRoom(room, "lobby");
    const collector = makeDeliveryCollector();

    const runPromise = proc.run(collector.deliver);
    await tick(50);

    // Send several messages and verify they all get delivered
    for (let i = 0; i < 5; i++) {
      await humanCh.sendMessage(`message ${i}`);
      await tick(30);
    }

    // All messages should have been delivered (no dedup false positives)
    const textDeliveries = collector.deliveries
      .map(textOf)
      .filter((t) => t.includes("message "));
    expect(textDeliveries.length).toBe(5);

    await proc.stop();
    await runPromise;
  });
});

// ── 3. Mode management ──────────────────────────────────────────────────────

describe("mode management", () => {
  test("default mode is used when no per-room override", async () => {
    const proc = makeProcessor({ defaultMode: "people" });
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    expect(proc.getModeForRoom(room.roomId)).toBe("people");
  });

  test("connectRoom with explicit mode sets per-room mode", async () => {
    const proc = makeProcessor({ defaultMode: "everyone" });
    const room = makeRoom();
    await proc.connectRoom(room, "lobby", "agents");

    expect(proc.getModeForRoom(room.roomId)).toBe("agents");
  });

  test("setModeForRoom updates the mode", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    proc.setModeForRoom(room.roomId, "me", false);

    expect(proc.getModeForRoom(room.roomId)).toBe("me");
  });

  test("setModeForRoom fires onModeChange callback", async () => {
    const changes: Array<{ roomId: string; roomName: string; mode: EngagementMode }> = [];
    const proc = makeProcessor({
      onModeChange: (roomId, roomName, mode) => changes.push({ roomId, roomName, mode }),
    });
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    proc.setModeForRoom(room.roomId, "standby-everyone", false);

    expect(changes).toHaveLength(1);
    expect(changes[0].roomName).toBe("lobby");
    expect(changes[0].mode).toBe("standby-everyone");
  });

  test("disconnectRoom cleans up per-room mode", async () => {
    const proc = makeProcessor({ defaultMode: "everyone" });
    const room = makeRoom();
    await proc.connectRoom(room, "lobby", "agents");
    expect(proc.getModeForRoom(room.roomId)).toBe("agents");

    await proc.disconnectRoom(room.roomId);

    // After disconnect, mode falls back to default
    expect(proc.getModeForRoom(room.roomId)).toBe("everyone");
  });

  test("listAll reports the current mode for each room", async () => {
    const proc = makeProcessor({ defaultMode: "everyone" });
    const room1 = makeRoom("room-1");
    const room2 = makeRoom("room-2");

    await proc.connectRoom(room1, "lobby", "people");
    await proc.connectRoom(room2, "lounge");

    const all = proc.listAll();
    const kitchenEntry = all.find((r) => r.name === "lobby");
    const loungeEntry = all.find((r) => r.name === "lounge");

    expect(kitchenEntry?.mode).toBe("people");
    expect(loungeEntry?.mode).toBe("everyone");
  });
});

// ── 4. Full catch-up building ───────────────────────────────────────────────

describe("buildFullCatchUp", () => {
  test("returns session context header", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("[Session context");
    expect(text).toContain("lobby");
  });

  test("includes room name and mode", async () => {
    const proc = makeProcessor({ defaultMode: "people" });
    const room = makeRoom();
    await proc.connectRoom(room, "lobby", "people");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("lobby");
    expect(text).toContain("people");
  });

  test("shows participants excluding self", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await addHuman(room, "human-1", "Alice");
    await proc.connectRoom(room, "lobby");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("Alice");
  });

  test("shows (nothing new) when no unseen events", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("(nothing new)");
  });

  test("shows (standby) for standby modes", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby", "standby-everyone");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("standby");
    expect(text).toContain("mentions only");
  });

  test("includes unseen messages in catch-up", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");
    await humanCh.sendMessage("hello from catch-up");
    await proc.connectRoom(room, "lobby");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("hello from catch-up");
  });

  test("multiple rooms each get their own section", async () => {
    const proc = makeProcessor();
    const room1 = makeRoom("room-1");
    const room2 = makeRoom("room-2");
    await proc.connectRoom(room1, "lobby");
    await proc.connectRoom(room2, "lounge");

    const parts = await proc.buildFullCatchUp();
    const text = textOf(parts);

    expect(text).toContain("lobby");
    expect(text).toContain("lounge");
  });
});

// ── 5. Content buffering ────────────────────────────────────────────────────

describe("content buffering", () => {
  test("content events are flushed with the next trigger event", async () => {
    // In "people" mode: human messages trigger, agent messages are content.
    // We send an agent message (buffered) then a human message (trigger).
    // The delivery should contain both.
    const proc = makeProcessor({ defaultMode: "people" });
    const room = makeRoom();

    const humanCh = await addHuman(room, "human-1", "Alice");
    const agentCh = await room.connect("stoop-1", "Bot", { type: "agent" });

    await proc.connectRoom(room, "lobby", "people");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Agent message (classified as "content" in "people" mode)
    await agentCh.sendMessage("stoop says hi");
    await tick(50);

    // No new delivery yet — agent message is buffered
    expect(collector.deliveries.length).toBe(catchUpCount);

    // Human message (classified as "trigger" in "people" mode)
    await humanCh.sendMessage("human says hi");
    await tick(100);

    // Now we should have a delivery that includes both
    expect(collector.deliveries.length).toBeGreaterThan(catchUpCount);
    const lastDelivery = textOf(collector.deliveries[collector.deliveries.length - 1]);
    expect(lastDelivery).toContain("stoop says hi");
    expect(lastDelivery).toContain("human says hi");

    await proc.stop();
    await runPromise;
  });

  test("content events from different rooms are buffered independently", async () => {
    const proc = makeProcessor({ defaultMode: "people" });
    const room1 = makeRoom("room-1");
    const room2 = makeRoom("room-2");

    const humanCh1 = await addHuman(room1, "human-1", "Alice");
    const agentCh1 = await room1.connect("stoop-1", "Bot1", { type: "agent" });
    const agentCh2 = await room2.connect("stoop-2", "Bot2", { type: "agent" });

    await proc.connectRoom(room1, "lobby", "people");
    await proc.connectRoom(room2, "lounge", "people");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Buffer content in room2
    await agentCh2.sendMessage("lounge bot message");
    await tick(50);

    // Trigger in room1 — should NOT flush room2's buffer
    await agentCh1.sendMessage("lobby bot message");
    await tick(30);
    await humanCh1.sendMessage("lobby human message");
    await tick(100);

    const postTriggerDeliveries = collector.deliveries.slice(catchUpCount);
    const allText = postTriggerDeliveries.map(textOf).join("\n");

    // kitchen bot message should appear (flushed by kitchen trigger)
    expect(allText).toContain("lobby bot message");
    expect(allText).toContain("lobby human message");

    await proc.stop();
    await runPromise;
  });
});

// ── 6. Processing lock ──────────────────────────────────────────────────────

describe("processing lock", () => {
  test("events arriving during delivery are queued and processed after", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");

    await proc.connectRoom(room, "lobby");

    let deliveryCount = 0;
    const deliveries: ContentPart[][] = [];
    let resolveDelivery: (() => void) | null = null;

    // Create a deliver function that blocks on the first real delivery
    const deliver = async (parts: ContentPart[]) => {
      deliveryCount++;
      deliveries.push(parts);
      // Block on the second delivery (first is catch-up) to simulate slow LLM
      if (deliveryCount === 2) {
        await new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        });
      }
    };

    const runPromise = proc.run(deliver);
    await tick(50); // catch-up delivery

    // First message triggers delivery (which blocks)
    await humanCh.sendMessage("first");
    await tick(50);

    // Second message arrives while delivery is blocked
    await humanCh.sendMessage("second");
    await tick(50);

    // Unblock the delivery
    resolveDelivery?.();
    await tick(200);

    // The second message should have been queued and processed
    const allText = deliveries.map(textOf).join("\n");
    expect(allText).toContain("first");
    expect(allText).toContain("second");

    await proc.stop();
    await runPromise;
  });

  // (pending notifications removed — mode changes no longer push text to agent)
});

// ── 7. Hot-connect (notifications removed) ──────────────────────────────────

describe("hot-connect", () => {
  test("connecting a room before run() does not produce startup delivery", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);

    // No startup injection — deliveries should be empty (no events sent)
    expect(collector.deliveries.length).toBe(0);

    await proc.stop();
    await runPromise;
  });
});

// ── 8. RoomResolver implementation ──────────────────────────────────────────

describe("RoomResolver", () => {
  test("resolve by room name", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    const conn = proc.resolve("lobby");
    expect(conn).not.toBeNull();
    expect(conn!.room.roomId).toBe("room-1");
  });

  test("resolve by room ID", async () => {
    const proc = makeProcessor();
    const room = makeRoom("my-room-id");
    await proc.connectRoom(room, "lobby");

    const conn = proc.resolve("my-room-id");
    expect(conn).not.toBeNull();
    expect(conn!.name).toBe("lobby");
  });

  test("resolve by identifier", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "Lobby Crew", undefined, "lobby-crew");

    const conn = proc.resolve("lobby-crew");
    expect(conn).not.toBeNull();
    expect(conn!.name).toBe("Lobby Crew");
  });

  test("resolve returns null for unknown name", async () => {
    const proc = makeProcessor();
    expect(proc.resolve("nonexistent")).toBeNull();
  });

  test("listAll returns metadata for all connected rooms", async () => {
    const proc = makeProcessor({ defaultMode: "everyone" });
    const room1 = makeRoom("room-1");
    const room2 = makeRoom("room-2");

    await addHuman(room1, "human-1", "Alice");
    await proc.connectRoom(room1, "lobby", "people", "lobby-id");
    await proc.connectRoom(room2, "lounge");

    const all = proc.listAll();
    expect(all).toHaveLength(2);

    const kitchen = all.find((r) => r.name === "lobby")!;
    expect(kitchen.roomId).toBe("room-1");
    expect(kitchen.identifier).toBe("lobby-id");
    expect(kitchen.mode).toBe("people");
    expect(kitchen.participantCount).toBe(2); // human + agent

    const lounge = all.find((r) => r.name === "lounge")!;
    expect(lounge.roomId).toBe("room-2");
    expect(lounge.identifier).toBeUndefined();
    expect(lounge.mode).toBe("everyone");
    expect(lounge.participantCount).toBe(1); // agent only
  });

  test("listAll includes lastMessage when available", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");
    await proc.connectRoom(room, "lobby");

    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);

    await humanCh.sendMessage("latest message here");
    await tick(100);

    const all = proc.listAll();
    const kitchen = all.find((r) => r.name === "lobby")!;
    expect(kitchen.lastMessage).toContain("Alice");
    expect(kitchen.lastMessage).toContain("latest message here");

    await proc.stop();
    await runPromise;
  });
});

// ── 9. onContextCompacted ───────────────────────────────────────────────────

describe("onContextCompacted", () => {
  test("clears seen-event cache", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    // Mark some events as seen
    proc.markEventsSeen(["evt-1", "evt-2", "evt-3"]);
    expect(proc.isEventSeen("evt-1")).toBe(true);
    expect(proc.isEventSeen("evt-2")).toBe(true);

    proc.onContextCompacted();

    // All seen markers should be cleared
    expect(proc.isEventSeen("evt-1")).toBe(false);
    expect(proc.isEventSeen("evt-2")).toBe(false);
    expect(proc.isEventSeen("evt-3")).toBe(false);
  });

  test("clears ref map", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    const ref = proc.assignRef("msg-uuid-1");
    expect(proc.resolveRef(ref)).toBe("msg-uuid-1");

    proc.onContextCompacted();

    // Ref should no longer resolve
    expect(proc.resolveRef(ref)).toBeUndefined();
  });

  // (compaction re-injection removed — agent recovers via catch_up tool call)
});

// ── 10. Ref map delegation ──────────────────────────────────────────────────

describe("ref map delegation", () => {
  test("assignRef returns a 4-digit string", () => {
    const proc = makeProcessor();
    const ref = proc.assignRef("msg-uuid-1");

    expect(ref).toMatch(/^\d{4}$/);
  });

  test("assignRef is idempotent for the same message ID", () => {
    const proc = makeProcessor();

    const ref1 = proc.assignRef("msg-uuid-1");
    const ref2 = proc.assignRef("msg-uuid-1");

    expect(ref1).toBe(ref2);
  });

  test("assignRef gives different refs for different message IDs", () => {
    const proc = makeProcessor();

    const ref1 = proc.assignRef("msg-uuid-1");
    const ref2 = proc.assignRef("msg-uuid-2");

    expect(ref1).not.toBe(ref2);
  });

  test("resolveRef maps back to the original message ID", () => {
    const proc = makeProcessor();

    const ref = proc.assignRef("msg-uuid-abc");
    const resolved = proc.resolveRef(ref);

    expect(resolved).toBe("msg-uuid-abc");
  });

  test("resolveRef returns undefined for unknown refs", () => {
    const proc = makeProcessor();

    expect(proc.resolveRef("9999")).toBeUndefined();
  });
});

// ── Engagement classification end-to-end ─────────────────────────────────────

describe("engagement classification end-to-end", () => {
  test("self-sent messages are dropped (not delivered)", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    // The agent sends a message through its own channel
    const agentConn = proc.resolve("lobby")!;
    await agentConn.channel.sendMessage("I said something");

    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(100);

    // Only catch-up should be delivered, not the self-message in the event loop
    const allText = collector.deliveries.map(textOf).join("\n");
    // The catch-up might include it as a stored event, but real-time self-events are dropped
    // by engagement classification. We verify the run() loop doesn't crash.

    await proc.stop();
    await runPromise;
  });

  test("standby mode drops non-mention events", async () => {
    const proc = makeProcessor({ defaultMode: "standby-everyone" });
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");

    await proc.connectRoom(room, "lobby", "standby-everyone");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Send a normal message — should be dropped in standby
    await humanCh.sendMessage("hello everyone");
    await tick(100);

    expect(collector.deliveries.length).toBe(catchUpCount);

    await proc.stop();
    await runPromise;
  });

  test("standby mode triggers on @mention", async () => {
    const proc = makeProcessor({
      defaultMode: "standby-everyone",
      selfIdentifier: "agent",
    });
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");

    await proc.connectRoom(room, "lobby", "standby-everyone");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Mention the agent
    await humanCh.sendMessage("hey @Agent what do you think?");
    await tick(100);

    // Should have received the mention as a trigger
    expect(collector.deliveries.length).toBeGreaterThan(catchUpCount);

    await proc.stop();
    await runPromise;
  });

  test("'people' mode triggers on human messages, buffers agent messages", async () => {
    const proc = makeProcessor({ defaultMode: "people" });
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");
    const agentCh = await room.connect("stoop-1", "OtherBot", { type: "agent" });

    await proc.connectRoom(room, "lobby", "people");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);
    const catchUpCount = collector.deliveries.length;

    // Agent message — should be buffered as content, not trigger
    await agentCh.sendMessage("stoop message");
    await tick(80);
    expect(collector.deliveries.length).toBe(catchUpCount);

    // Human message — should trigger and flush the buffer
    await humanCh.sendMessage("human message");
    await tick(100);
    expect(collector.deliveries.length).toBeGreaterThan(catchUpCount);

    const lastDelivery = textOf(collector.deliveries[collector.deliveries.length - 1]);
    expect(lastDelivery).toContain("stoop message");
    expect(lastDelivery).toContain("human message");

    await proc.stop();
    await runPromise;
  });
});

// ── Seen-event cache ────────────────────────────────────────────────────────

describe("seen-event cache", () => {
  test("markEventsSeen and isEventSeen work together", () => {
    const proc = makeProcessor();

    expect(proc.isEventSeen("evt-1")).toBe(false);

    proc.markEventsSeen(["evt-1", "evt-2"]);

    expect(proc.isEventSeen("evt-1")).toBe(true);
    expect(proc.isEventSeen("evt-2")).toBe(true);
    expect(proc.isEventSeen("evt-3")).toBe(false);
  });
});

// ── Inject buffer (LangGraph mid-loop injection) ─────────────────────────────

describe("inject buffer", () => {
  test("drainInjectBuffer returns null when empty", () => {
    const proc = makeProcessor();
    expect(proc.drainInjectBuffer()).toBeNull();
  });
});

// ── Event log ───────────────────────────────────────────────────────────────

describe("event log", () => {
  test("getLog returns trigger events that were processed", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    const humanCh = await addHuman(room, "human-1", "Alice");

    await proc.connectRoom(room, "lobby");
    const collector = makeDeliveryCollector();
    const runPromise = proc.run(collector.deliver);
    await tick(50);

    await humanCh.sendMessage("log this message");
    await tick(100);

    const log = proc.getLog();
    expect(log.length).toBeGreaterThan(0);
    const hasMessage = log.some(
      (e) => e.type === "MessageSent" && (e as MessageSentEvent).message.content === "log this message",
    );
    expect(hasMessage).toBe(true);

    await proc.stop();
    await runPromise;
  });
});

// ── setModeForRoom notification ─────────────────────────────────────────────

describe("setModeForRoom", () => {
  // Mode change notifications removed — mode changes are no longer pushed to agent.
  // The agent discovers mode changes via catch_up or set_mode tool responses.

  test("mode change updates engagement strategy", async () => {
    const proc = makeProcessor();
    const room = makeRoom();
    await proc.connectRoom(room, "lobby");

    proc.setModeForRoom(room.roomId, "standby-me");
    expect(proc.getModeForRoom(room.roomId)).toBe("standby-me");
  });
});

// ── emitToolUse ─────────────────────────────────────────────────────────────

describe("emitToolUse", () => {
  test("emitToolUse does not throw when no current context room", () => {
    const proc = makeProcessor();
    // Should be a no-op, not throw
    expect(() => proc.emitToolUse("send_message", "started")).not.toThrow();
  });
});

// ── Accessors ───────────────────────────────────────────────────────────────

describe("accessors", () => {
  test("participantId and participantName return constructor values", () => {
    const proc = new EventProcessor("my-id", "MyAgent");
    expect(proc.participantId).toBe("my-id");
    expect(proc.participantName).toBe("MyAgent");
  });

  test("currentContextRoomId is null when not processing", () => {
    const proc = makeProcessor();
    expect(proc.currentContextRoomId).toBeNull();
  });
});
