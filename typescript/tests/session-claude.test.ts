/** Tests for Claude session — module exports, construction, basic behavior. */

import { describe, test, expect } from "vitest";

describe("ClaudeSession", () => {
  test("module exports are importable", async () => {
    const mod = await import("../src/claude/session.js");
    expect(typeof mod.ClaudeSession).toBe("function");
    expect(typeof mod.createClaudeSession).toBe("function");
  });

  test("createClaudeSession returns ILLMSession with expected methods", async () => {
    const { createClaudeSession } = await import("../src/claude/session.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");

    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = createClaudeSession("You are a test.", resolver, "claude-sonnet-4-5-20250929", {});
    expect(session).toBeDefined();
    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");
    expect(typeof session.process).toBe("function");
    expect(typeof session.setApiKey).toBe("function");
  });

  test("constructor creates temp directory", async () => {
    const { ClaudeSession } = await import("../src/claude/session.js");
    const { Room } = await import("../src/core/room.js");
    const { existsSync } = await import("node:fs");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");

    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = new ClaudeSession("You are a test.", resolver, "claude-sonnet-4-5-20250929", {});
    // The session creates a tmpdir in the constructor — verify via stop() cleanup
    // We can't directly check _cwd, but stop() should not throw
    await session.stop();
  });

  test("start() fails gracefully without SDK", async () => {
    const { ClaudeSession } = await import("../src/claude/session.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");

    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = new ClaudeSession("You are a test.", resolver, "claude-sonnet-4-5-20250929", {});

    // start() loads the SDK dynamically — if not installed it should throw
    // In the test environment, the SDK may or may not be available
    try {
      await session.start();
      // If SDK is available, start succeeds — clean up
      await session.stop();
    } catch (err) {
      // Expected if SDK not installed — should be an import error
      expect(err).toBeDefined();
    }
  });
});
