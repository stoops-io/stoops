/**
 * Full MCP server — for embedded/API agents without filesystem access.
 *
 * Creates a proper MCP server using @modelcontextprotocol/sdk with
 * StreamableHTTP transport on a random localhost port.
 *
 * 4 tools: catch_up, search_by_text, search_by_message, send_message.
 *
 * Returns { url, instance, stop } where:
 *   url      — http://127.0.0.1:PORT/mcp (for any MCP-capable client)
 *   instance — McpServer instance (for Claude SDK in-process shortcut)
 *   stop     — shuts down the HTTP listener
 */

import { createServer } from "node:http";
import { z } from "zod";
import type { RoomResolver, ToolHandlerOptions } from "../types.js";
import {
  handleCatchUp,
  handleSearchByText,
  handleSearchByMessage,
  handleSendMessage,
} from "../tool-handlers.js";

export interface StoopsMcpServer {
  /** HTTP URL for URL-based MCP clients (e.g. LangGraph, external tools). */
  url: string;
  /**
   * Raw McpServer instance — passed to Claude SDK as
   * `{ type: 'sdk', name: 'stoops_tools', instance }` to avoid HTTP overhead.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any;
  /** Shut down the HTTP listener. */
  stop: () => Promise<void>;
}

/**
 * Start a full stoops MCP server (all 4 tools).
 * Call once per session start; call stop() on session stop.
 */
export async function createFullMcpServer(
  resolver: RoomResolver,
  options: ToolHandlerOptions,
): Promise<StoopsMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  // ── Build McpServer with all 4 tools ─────────────────────────────────────

  const server = new McpServer(
    { name: "stoops_tools", version: "1.0.0" },
  );

  server.tool(
    "catch_up",
    "Catch up on recent activity in a room. Returns unseen events, oldest first.",
    { room: z.string().describe("Name of the room to catch up on") },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ room }) => handleCatchUp(resolver, { room }, options) as any,
  );

  server.tool(
    "search_by_text",
    "Search chat history by keyword. Returns the most recent matches, each shown with 1 message of context before and after.",
    {
      room: z.string().describe("Name of the room to search"),
      query: z.string().describe("Keyword or phrase to search for"),
      count: z.number().int().min(1).max(10).default(3).optional()
        .describe("Number of matches to return (default 3)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous search"),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args) => handleSearchByText(resolver, args, options) as any,
  );

  server.tool(
    "search_by_message",
    "Show messages around a known message ref. Use to scroll back ('before') or forward ('after') from a message you've seen.",
    {
      room: z.string().describe("Name of the room"),
      ref: z.string().describe("The #XXXX message ref (e.g. #3847)"),
      direction: z.enum(["before", "after"]).default("before").optional()
        .describe("'before' to scroll back (default), 'after' to scroll forward"),
      count: z.number().int().min(1).max(50).default(10).optional()
        .describe("Number of messages to return (not counting anchor, default 10)"),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args) => handleSearchByMessage(resolver, args, options) as any,
  );

  server.tool(
    "send_message",
    "Send a message to a specific room. Only use this when you have something genuinely worth saying — a reaction, an answer, a question, a joke. Most of the time, staying quiet is the right call. Not every message needs a response.",
    {
      room: z.string().describe("Name of the room to send to"),
      content: z.string().describe("Message content"),
      reply_to_id: z.string().optional()
        .describe("Only set this when replying to a specific earlier message adds clarity. Use the #XXXX ref shown in catch_up or search results."),
      image_url: z.string().url().optional().describe("URL of an image to attach"),
      image_mime_type: z.string().optional().describe("MIME type of the image"),
      image_size_bytes: z.number().int().positive().optional()
        .describe("Size of the image in bytes"),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args) => handleSendMessage(resolver, args, options) as any,
  );

  // ── Start HTTP server on random port ─────────────────────────────────────

  // One transport per connection (stateless mode — no session IDs needed since
  // each stoop session is independent and state lives in the McpServer handlers).
  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Stateless mode: fresh transport per request, no session tracking needed
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await server.connect(transport);

    // Collect body for POST requests
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = undefined; }
    }

    await transport.handleRequest(req, res, body);
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("Could not determine server port"));
    });
    httpServer.once("error", reject);
  });

  const url = `http://127.0.0.1:${port}/mcp`;

  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (!stopPromise) {
      stopPromise = new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
    return stopPromise;
  };

  return { url, instance: server, stop };
}
