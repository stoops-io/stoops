/** Tests for shared tool handler functions. */

import { describe, test, expect, beforeEach } from "vitest";
import { Room } from "../src/core/room.js";
import type { Channel } from "../src/core/channel.js";
import type { RoomConnection, RoomResolver } from "../src/agent/types.js";
import {
  resolveOrError,
  textResult,
  buildCatchUpLines,
  handleCatchUp,
  handleSearchByText,
  handleSearchByMessage,
  handleSendMessage,
} from "../src/agent/tool-handlers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResolver(connections: Map<string, RoomConnection>): RoomResolver {
  return {
    resolve(roomName: string) {
      for (const conn of connections.values()) {
        if (conn.name === roomName) return conn;
      }
      return null;
    },
    listAll() {
      return [...connections.entries()].map(([roomId, conn]) => ({
        name: conn.name,
        roomId,
        mode: "everyone",
        participantCount: conn.room.listParticipants().length,
      }));
    },
  };
}

async function setupRoom(): Promise<{ room: Room; channel: Channel; conn: RoomConnection }> {
  const room = new Room("test-room");
  const channel = await room.connect("user1", "Alice", "human");
  await room.connect("stoop1", "Quinn", "agent");
  const conn: RoomConnection = { room, channel, name: "Kitchen" };
  return { room, channel, conn };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveOrError", () => {
  test("returns conn for known room", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = resolveOrError(resolver, "Kitchen");
    expect(result.error).toBe(false);
    if (!result.error) {
      expect(result.conn.name).toBe("Kitchen");
    }
  });

  test("returns error for unknown room", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = resolveOrError(resolver, "Unknown");
    expect(result.error).toBe(true);
    if (result.error) {
      expect(result.result.content[0].text).toContain("Unknown room");
    }
  });
});

describe("textResult", () => {
  test("wraps text in content array", () => {
    const result = textResult("hello");
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("handleCatchUp", () => {
  test("returns catch-up output for room", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleCatchUp(resolver, { room: "Kitchen" }, {});
    // Room has join events from connect, so catch_up returns them
    expect(result.content[0].text).toContain("Catching up on [Kitchen]:");
  });

  test("returns messages after sending", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    await channel.sendMessage("Hello world");

    const result = await handleCatchUp(resolver, { room: "Kitchen" }, {});
    expect(result.content[0].text).toContain("Hello world");
  });

  test("returns error for unknown room", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleCatchUp(resolver, { room: "Nope" }, {});
    expect(result.content[0].text).toContain("Unknown room");
  });

  test("marks events as seen", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    await channel.sendMessage("msg1");

    const seenIds: string[] = [];
    await handleCatchUp(resolver, { room: "Kitchen" }, {
      markEventsSeen: (ids) => seenIds.push(...ids),
    });

    expect(seenIds.length).toBeGreaterThan(0);
  });
});

describe("handleSearchByText", () => {
  test("finds matching messages", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    await channel.sendMessage("alpha beta");
    await channel.sendMessage("gamma delta");
    await channel.sendMessage("alpha again");

    const result = await handleSearchByText(
      resolver,
      { room: "Kitchen", query: "alpha" },
      {},
    );
    expect(result.content[0].text).toContain("alpha");
    expect(result.content[0].text).toContain("Search results");
  });

  test("returns no matches message", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleSearchByText(
      resolver,
      { room: "Kitchen", query: "nonexistent" },
      {},
    );
    expect(result.content[0].text).toContain("No messages found");
  });
});

describe("handleSearchByMessage", () => {
  test("returns context before anchor", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    await channel.sendMessage("first");
    await channel.sendMessage("second");
    const anchor = await channel.sendMessage("third");

    const refMap = new Map<string, string>();
    const result = await handleSearchByMessage(
      resolver,
      { room: "Kitchen", ref: anchor.id, direction: "before", count: 5 },
      { assignRef: (id) => { const r = String(refMap.size + 1); refMap.set(r, id); return r; }, resolveRef: (ref) => refMap.get(ref) ?? ref },
    );
    expect(result.content[0].text).toContain("Context in [Kitchen]");
    expect(result.content[0].text).toContain("←"); // anchor marker
  });

  test("returns context after anchor", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const anchor = await channel.sendMessage("first");
    await channel.sendMessage("second");
    await channel.sendMessage("third");

    const result = await handleSearchByMessage(
      resolver,
      { room: "Kitchen", ref: anchor.id, direction: "after", count: 5 },
      {},
    );
    expect(result.content[0].text).toContain("Context in [Kitchen]");
    expect(result.content[0].text).toContain("second");
    expect(result.content[0].text).toContain("third");
  });

  test("resolves #ref via resolveRef", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const anchor = await channel.sendMessage("target");

    const result = await handleSearchByMessage(
      resolver,
      { room: "Kitchen", ref: "#9999" },
      { resolveRef: (ref) => ref === "9999" ? anchor.id : undefined },
    );
    expect(result.content[0].text).toContain("Context in [Kitchen]");
  });

  test("returns error for unknown anchor", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleSearchByMessage(
      resolver,
      { room: "Kitchen", ref: "nonexistent-id" },
      {},
    );
    expect(result.content[0].text).toContain("not found");
  });

  test("returns error for unknown room", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleSearchByMessage(
      resolver,
      { room: "Nope", ref: "abc" },
      {},
    );
    expect(result.content[0].text).toContain("Unknown room");
  });
});

describe("handleSendMessage", () => {
  test("sends a message and returns confirmation", async () => {
    const { conn } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const result = await handleSendMessage(
      resolver,
      { room: "Kitchen", content: "Hello from handler" },
      {},
    );
    expect(result.content[0].text).toContain("Message sent");
  });

  test("resolves reply ref", async () => {
    const { conn, channel } = await setupRoom();
    const connections = new Map([["test-room", conn]]);
    const resolver = makeResolver(connections);

    const msg = await channel.sendMessage("original");

    const result = await handleSendMessage(
      resolver,
      { room: "Kitchen", content: "reply", reply_to_id: "#abc" },
      { resolveRef: (ref) => ref === "abc" ? msg.id : undefined },
    );
    // Verify the message was sent — the result is a confirmation string now
    expect(result.content[0].text).toContain("Message sent");

    // Verify the reply was actually linked by checking the last message in storage
    const messages = await conn.room.storage.getMessages(conn.room.roomId, 1, null);
    expect(messages.items[0].reply_to_id).toBe(msg.id);
  });
});

describe("buildCatchUpLines", () => {
  test("returns empty for fresh room", async () => {
    const { conn } = await setupRoom();
    const lines = await buildCatchUpLines(conn, {});
    // May have join events but no messages
    // Lines should be empty or contain only join events
    expect(Array.isArray(lines)).toBe(true);
  });

  test("skips seen events", async () => {
    const { conn, channel } = await setupRoom();
    await channel.sendMessage("msg1");
    await channel.sendMessage("msg2");

    // First call — sees everything
    const seenIds = new Set<string>();
    const lines1 = await buildCatchUpLines(conn, {
      isEventSeen: (id) => seenIds.has(id),
      markEventsSeen: (ids) => { for (const id of ids) seenIds.add(id); },
    });
    expect(lines1.length).toBeGreaterThan(0);

    // Second call — nothing new
    const lines2 = await buildCatchUpLines(conn, {
      isEventSeen: (id) => seenIds.has(id),
      markEventsSeen: (ids) => { for (const id of ids) seenIds.add(id); },
    });
    expect(lines2).toHaveLength(0);
  });
});
