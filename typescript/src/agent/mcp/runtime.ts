/**
 * Runtime MCP server — local MCP proxy for the client-side agent runtime.
 *
 * Claude Code / OpenCode connects to this local server. Tool calls are routed
 * to the right stoop server via the RoomResolver (which maps room names to
 * RemoteRoomDataSource instances).
 *
 * Tools:
 *   Always present:
 *     stoops__catch_up(room?) — with room: room catch-up. Without: list rooms + pending invites.
 *     stoops__search_by_text(room, query, count?, cursor?)
 *     stoops__search_by_message(room, ref, direction?, count?)
 *     stoops__send_message(room, content, reply_to?)
 *     stoops__set_mode(room, mode)
 *     stoops__join_room(url, alias?)
 *     stoops__leave_room(room)
 *
 *   With --admin flag:
 *     stoops__admin__set_mode_for(room, participant, mode)
 *     stoops__admin__kick(room, participant)
 */

import { createServer } from "node:http";
import { z } from "zod";
import type { RoomResolver, ToolHandlerOptions } from "../types.js";
import {
  handleCatchUp,
  handleSearchByText,
  handleSearchByMessage,
  handleSendMessage,
  textResult,
} from "../tool-handlers.js";
import { MODE_DESCRIPTIONS } from "../prompts.js";
import { isValidMode } from "../engagement.js";
import { EventEmitterAsyncResource } from "node:events"

export interface JoinRoomResult {
  success: boolean;
  error?: string;
  roomName?: string;
  agentName?: string;
  authority?: string;
  mode?: string;
  personName?: string;
  participants?: Array<{ name: string; authority: string }>;
  recentLines?: string[];
}

export interface RuntimeMcpServerOptions {
  resolver: RoomResolver;
  toolOptions: ToolHandlerOptions;
  admin?: boolean;
  /** Called when the agent requests joining a new room mid-session. */
  onJoinRoom?: (url: string, alias?: string) => Promise<JoinRoomResult>;
  /** Called when the agent requests leaving a room. */
  onLeaveRoom?: (room: string) => Promise<{ success: boolean; error?: string }>;
  /** Called when the agent changes its own mode. */
  onSetMode?: (room: string, mode: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin set-mode-for. */
  onAdminSetModeFor?: (room: string, participant: string, mode: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin kick. */
  onAdminKick?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin mute (demote to observer). */
  onAdminMute?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
  /** Called for admin unmute (restore to participant). */
  onAdminUnmute?: (room: string, participant: string) => Promise<{ success: boolean; error?: string }>;
}

export interface RuntimeMcpServer {
  url: string;
  stop: () => Promise<void>;
}

/** Format a rich join_room response from the callback result. */
function formatJoinResponse(result: JoinRoomResult): string {
  const lines: string[] = [];

  lines.push(`Joined ${result.roomName} as "${result.agentName}" (${result.authority})`);
  lines.push("");

  // Mode
  if (result.mode) {
    lines.push(`Mode: ${result.mode}`);
    const desc = MODE_DESCRIPTIONS[result.mode];
    if (desc) lines.push(`  ${desc}`);
    lines.push(`  Change with set_mode.`);
    lines.push("");
  }

  // Person
  if (result.personName) {
    lines.push(`Person: ${result.personName}`);
    lines.push(`  Your person's messages always reach you regardless of mode.`);
    lines.push("");
  }

  // Participants
  if (result.participants && result.participants.length > 0) {
    lines.push("Participants:");
    for (const p of result.participants) {
      lines.push(`  ${p.name} (${p.authority})`);
    }
    lines.push("");
  }

  // Recent activity
  if (result.recentLines && result.recentLines.length > 0) {
    lines.push("Recent:");
    for (const line of result.recentLines) {
      lines.push(`  ${line}`);
    }
    lines.push("");
    lines.push(`${result.recentLines.length} message${result.recentLines.length === 1 ? "" : "s"} shown. Use catch_up("${result.roomName}") for more.`);
  }

  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTools(server: any, opts: RuntimeMcpServerOptions): void {
  const { resolver, toolOptions } = opts;

  // ── stoops__catch_up ────────────────────────────────────────────────────
  server.tool(
    "stoops__catch_up",
    "List your rooms and status. Call with no arguments to see connected rooms. With a room name, returns recent activity you haven't seen.",
    {
      room: z.string().optional().describe("Room name. Omit to list all connected rooms."),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ room }: { room?: string }) => {
      if (!room) {
        const rooms = resolver.listAll();
        if (rooms.length === 0) {
          return textResult("Not connected to any rooms.");
        }
        const lines = ["Connected rooms:", ""];
        for (const r of rooms) {
          const idPart = r.identifier ? ` [${r.identifier}]` : "";
          lines.push(`  ${r.name}${idPart} — ${r.mode} (${r.participantCount} participants)`);
          if (r.lastMessage) lines.push(`    Last: ${r.lastMessage}`);
        }
        return textResult(lines.join("\n"));
      }
      return handleCatchUp(resolver, { room }, toolOptions);
    },
  );

  // ── stoops__search_by_text ──────────────────────────────────────────────
  server.tool(
    "stoops__search_by_text",
    "Search chat history by keyword.",
    {
      room: z.string().describe("Room name"),
      query: z.string().describe("Keyword or phrase to search for"),
      count: z.number().int().min(1).max(10).default(3).optional()
        .describe("Number of matches (default 3)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByText(resolver, args, toolOptions) as any,
  );

  // ── stoops__search_by_message ──────────────────────────────────────────
  server.tool(
    "stoops__search_by_message",
    "Show messages around a known message ref.",
    {
      room: z.string().describe("Room name"),
      ref: z.string().describe("Message ref (e.g. #3847)"),
      direction: z.enum(["before", "after"]).default("before").optional()
        .describe("'before' to scroll back, 'after' to scroll forward"),
      count: z.number().int().min(1).max(50).default(10).optional()
        .describe("Number of messages (default 10)"),
    },
    { readOnlyHint: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSearchByMessage(resolver, args, toolOptions) as any,
  );

  // ── stoops__send_message ────────────────────────────────────────────────
  server.tool(
    "stoops__send_message",
    "Send a message to a room.",
    {
      room: z.string().describe("Room name"),
      content: z.string().describe("Message content. @name will notify that participant — use sparingly."),
      reply_to_id: z.string().optional()
        .describe("Message ref to reply to (e.g. #3847)."),
    },
    { readOnlyHint: false, destructiveHint: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => handleSendMessage(resolver, args, toolOptions) as any,
  );

  // ── stoops__set_mode ────────────────────────────────────────────────────
  server.tool(
    "stoops__set_mode",
    "Change your engagement mode. Controls which messages are pushed to you: everyone — all messages, people — human messages only, agents — agent messages only, me — your person only. Prefix with standby- for @mentions only.",
    {
      room: z.string().describe("Room name"),
      mode: z.string().describe("Engagement mode"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ room, mode }: { room: string; mode: string }) => {
      if (!opts.onSetMode) return textResult("Mode changes not supported.");
      if (!isValidMode(mode)) {
        return textResult(`Invalid mode "${mode}". Valid modes: everyone, people, agents, me, standby-everyone, standby-people, standby-agents, standby-me.`);
      }
      const result = await opts.onSetMode(room, mode);
      return result.success
        ? textResult(`Mode set to ${mode} for [${room}].`)
        : textResult(result.error ?? "Failed to set mode.");
    },
  );

  // ── stoops__join_room ──────────────────────────────────────────────────
  server.tool(
    "stoops__join_room",
    "Join a room. Returns your identity, participants, mode, and recent activity.",
    {
      url: z.string().describe("Share URL to join"),
      alias: z.string().optional().describe("Local alias for the room (if name collides)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ url, alias }: { url: string; alias?: string }) => {
      if (!opts.onJoinRoom) return textResult("Joining rooms not supported.");
      const result = await opts.onJoinRoom(url, alias);
      if (!result.success) return textResult(result.error ?? "Failed to join room.");

      // Rich response if we have room details
      if (result.roomName && result.agentName) {
        return textResult(formatJoinResponse(result));
      }
      return textResult(`Joined room successfully.`);
    },
  );

  // ── stoops__leave_room ─────────────────────────────────────────────────
  server.tool(
    "stoops__leave_room",
    "Leave a room. Events stop flowing from it.",
    {
      room: z.string().describe("Room name to leave"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ room }: { room: string }) => {
      if (!opts.onLeaveRoom) return textResult("Leaving rooms not supported.");
      const result = await opts.onLeaveRoom(room);
      return result.success
        ? textResult(`Left [${room}].`)
        : textResult(result.error ?? "Failed to leave room.");
    },
  );

  // ── Admin tools (only with --admin flag) ────────────────────────────────
  if (opts.admin) {
    server.tool(
      "stoops__admin__set_mode_for",
      "Admin: set engagement mode for another participant.",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name"),
        mode: z.string().describe("Engagement mode to set"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant, mode }: { room: string; participant: string; mode: string }) => {
        if (!opts.onAdminSetModeFor) return textResult("Admin mode changes not supported.");
        if (!isValidMode(mode)) {
          return textResult(`Invalid mode "${mode}". Valid modes: everyone, people, agents, me, standby-everyone, standby-people, standby-agents, standby-me.`);
        }
        const result = await opts.onAdminSetModeFor(room, participant, mode);
        return result.success
          ? textResult(`Set ${participant}'s mode to ${mode} in [${room}].`)
          : textResult(result.error ?? "Failed to set mode.");
      },
    );

    server.tool(
      "stoops__admin__kick",
      "Admin: kick a participant from a room.",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to kick"),
      },
      { readOnlyHint: false, destructiveHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminKick) return textResult("Admin kick not supported.");
        const result = await opts.onAdminKick(room, participant);
        return result.success
          ? textResult(`Kicked ${participant} from [${room}].`)
          : textResult(result.error ?? "Failed to kick participant.");
      },
    );

    server.tool(
      "stoops__admin__mute",
      "Admin: make a participant read-only (demote to observer).",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to mute"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminMute) return textResult("Admin mute not supported.");
        const result = await opts.onAdminMute(room, participant);
        return result.success
          ? textResult(`Muted ${participant} in [${room}] (observer).`)
          : textResult(result.error ?? "Failed to mute participant.");
      },
    );

    server.tool(
      "stoops__admin__unmute",
      "Admin: restore a muted participant (promote to participant).",
      {
        room: z.string().describe("Room name"),
        participant: z.string().describe("Participant name to unmute"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      async ({ room, participant }: { room: string; participant: string }) => {
        if (!opts.onAdminUnmute) return textResult("Admin unmute not supported.");
        const result = await opts.onAdminUnmute(room, participant);
        return result.success
          ? textResult(`Unmuted ${participant} in [${room}] (participant).`)
          : textResult(result.error ?? "Failed to unmute participant.");
      },
    );
  }
}

/**
 * Create a runtime MCP server on a random localhost port.
 * Returns the URL for --mcp-config and a stop function.
 */
export async function createRuntimeMcpServer(
  opts: RuntimeMcpServerOptions,
): Promise<RuntimeMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Fresh McpServer per request (McpServer only allows one active transport)
    const reqServer = new McpServer({ name: "stoops_runtime", version: "1.0.0" });
    registerTools(reqServer, opts);

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

  return { url, stop };
}
