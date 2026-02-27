/**
 * Lite MCP server — for coding/CLI agents with filesystem access.
 *
 * 2 tools: send_message, snapshot_room.
 *
 * Returns { url, instance, stop } — same StoopsMcpServer shape as full.
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RoomResolver, ToolHandlerOptions } from "../types.js";
import type { RoomEvent } from "../../core/events.js";
import { handleSendMessage } from "../tool-handlers.js";
import { formatTimestamp } from "../prompts.js";
import type { StoopsMcpServer } from "./full.js";

/** Format a single event as a grep-friendly snapshot line. */
function formatSnapshotLine(event: RoomEvent): string {
  const ts = formatTimestamp(new Date(event.timestamp));
  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const label = `${msg.sender_name}`;
      if (msg.reply_to_id) {
        return `[${ts}] MSG #${msg.id.slice(0, 4)} ${label} → #${msg.reply_to_id.slice(0, 4)}: ${msg.content}`;
      }
      return `[${ts}] MSG #${msg.id.slice(0, 4)} ${label}: ${msg.content}`;
    }
    case "ParticipantJoined":
      return `[${ts}] JOIN ${event.participant.name}`;
    case "ParticipantLeft":
      return `[${ts}] LEFT ${event.participant.name}`;
    case "ReactionAdded":
      return `[${ts}] REACT ${event.participant_id} ${event.emoji} → #${event.message_id.slice(0, 4)}`;
    default:
      return `[${ts}] ${event.type}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTools(server: any, resolver: RoomResolver, options: ToolHandlerOptions, snapshotDir: string): void {
  server.tool(
    "send_message",
    "Send a message to a specific room. Only use this when you have something genuinely worth saying — a reaction, an answer, a question, a joke. Most of the time, staying quiet is the right call. Not every message needs a response.",
    {
      room: z.string().describe("Name of the room to send to"),
      content: z.string().describe("Message content"),
      reply_to_id: z.string().optional()
        .describe("Only set this when replying to a specific earlier message adds clarity. Use the #XXXX ref shown in snapshot output."),
      image_url: z.string().url().optional().describe("URL of an image to attach"),
      image_mime_type: z.string().optional().describe("MIME type of the image"),
      image_size_bytes: z.number().int().positive().optional()
        .describe("Size of the image in bytes"),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSendMessage(resolver, args, options) as any,
  );

  server.tool(
    "snapshot_room",
    "Get a searchable copy of the room's event history as a file. Use grep, tail, or Read on the returned path.",
    {
      room: z.string().describe("Name of the room to snapshot"),
    },
    async ({ room: roomName }: { room: string }) => {
      const conn = resolver.resolve(roomName);
      if (!conn) {
        return { content: [{ type: "text" as const, text: `Unknown room "${roomName}".` }] };
      }

      const events = await conn.room.listEvents(undefined, 1000);
      const participants = conn.room.listParticipants();

      const pList = participants.map((p) => `${p.type} ${p.name}`).join(", ");

      const lines: string[] = [];
      lines.push(`=== ${roomName} ===`);
      lines.push(`participants: ${pList}`);
      lines.push(`snapshot: ${events.items.length} events`);
      lines.push("===");
      lines.push("");

      for (const event of [...events.items].reverse()) {
        lines.push(formatSnapshotLine(event));
      }

      const filePath = join(snapshotDir, `${roomName}.log`);
      writeFileSync(filePath, lines.join("\n") + "\n");

      return {
        content: [{
          type: "text" as const,
          text: [
            `Snapshot written to: ${filePath}`,
            `Events: ${events.items.length}`,
            "",
            "Tips:",
            `  grep 'MSG.*keyword' ${filePath}     # search content`,
            `  grep '#ref' ${filePath}              # find a message by ref`,
            `  tail -n 50 ${filePath}               # recent events`,
          ].join("\n"),
        }],
      };
    },
  );
}

/**
 * Start a lite stoops MCP server (2 tools: send_message, snapshot_room).
 */
export async function createLiteMcpServer(
  resolver: RoomResolver,
  options: ToolHandlerOptions,
  snapshotDir: string,
): Promise<StoopsMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const instance = new McpServer({ name: "stoops", version: "1.0.0" });
  registerTools(instance, resolver, options, snapshotDir);

  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Fresh McpServer per request — McpServer only allows one active transport
    // at a time. Tool registration is cheap; creating per-request is correct
    // for stateless HTTP MCP.
    const reqServer = new McpServer({ name: "stoops", version: "1.0.0" });
    registerTools(reqServer, resolver, options, snapshotDir);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await reqServer.connect(transport);

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

  return { url, instance, stop };
}
