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

  // Integration test — requires LangChain packages AND API keys.
  // Skipped in CI. Run manually with: ANTHROPIC_API_KEY=... npx vitest run -t "start()"
  test.skip("start() initializes graph with MCP tools (integration)", async () => {
    const { createLangGraphSession } = await import("../src/langgraph/session.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");
    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const session = createLangGraphSession("You are a test.", resolver, "anthropic:claude-sonnet-4-5-20250929", {});
    await session.start();
    await session.stop();
  });
});

describe("MCP server", () => {
  test("createFullMcpServer starts and returns url + instance", async () => {
    const { createFullMcpServer } = await import("../src/agent/mcp/full.js");
    const { Room } = await import("../src/core/room.js");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");
    const resolver = {
      resolve: () => ({ room, channel, name: "Test" }),
      listAll: () => [],
    };

    const mcp = await createFullMcpServer(resolver, {});
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.instance).toBeDefined();
    expect(typeof mcp.stop).toBe("function");
    await mcp.stop();
  });

  test("createLiteMcpServer starts and returns url + instance", async () => {
    const { createLiteMcpServer } = await import("../src/agent/mcp/lite.js");
    const { Room } = await import("../src/core/room.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const room = new Room("test");
    const channel = await room.connect("user1", "Alice");
    const resolver = {
      resolve: () => ({ room, channel, name: "test" }),
      listAll: () => [],
    };

    const snapshotDir = mkdtempSync(`${tmpdir()}/stoops_test_`);
    const mcp = await createLiteMcpServer(resolver, {}, snapshotDir);
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.instance).toBeDefined();
    expect(typeof mcp.stop).toBe("function");
    await mcp.stop();
  });
});
