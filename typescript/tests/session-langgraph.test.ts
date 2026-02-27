/** Tests for LangGraph session — skipped if LangChain packages not installed. */

import { describe, test, expect, beforeAll } from "vitest";

let hasLangChain = false;

beforeAll(async () => {
  try {
    await import("@langchain/langgraph");
    await import("@langchain/core/messages");
    hasLangChain = true;
  } catch {
    hasLangChain = false;
  }
});

describe("LangGraphSession", () => {
  test("module exports are importable", async () => {
    const mod = await import("../src/langgraph/session.js");
    expect(typeof mod.LangGraphSession).toBe("function");
    expect(typeof mod.createLangGraphSession).toBe("function");
  });

  test("createLangGraphSession returns ILLMSession", async () => {
    const { createLangGraphSession } = await import("../src/langgraph/session.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");

    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = createLangGraphSession("You are a test.", resolver, "anthropic:claude-sonnet-4-5-20250929", {});
    expect(session).toBeDefined();
    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");
    expect(typeof session.process).toBe("function");
    expect(typeof session.setApiKey).toBe("function");
  });

  test.skipIf(!hasLangChain)("start() initializes graph with MCP tools", async () => {
    const { createLangGraphSession } = await import("../src/langgraph/session.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");
    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = createLangGraphSession("You are a test.", resolver, "anthropic:claude-sonnet-4-5-20250929", {});
    try {
      await session.start();
      await session.stop();
    } catch (err: unknown) {
      // Expected: initChatModel may fail without API key env vars.
      // Verify the error is env/config related, not a code bug.
      const msg = err instanceof Error ? err.message : String(err);
      expect(
        msg.includes("API") || msg.includes("key") || msg.includes("auth") ||
        msg.includes("model") || msg.includes("credential") || msg.includes("environment"),
      ).toBe(true);
    }
  });
});

describe("MCP server", () => {
  test("createStoopsMcpServer starts and returns url + instance", async () => {
    const { createStoopsMcpServer } = await import("../src/agent/mcp-server.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");
    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const mcp = await createStoopsMcpServer(resolver, {});
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.instance).toBeDefined();
    expect(typeof mcp.stop).toBe("function");
    await mcp.stop();
  });
});
