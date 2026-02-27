/**
 * stoops serve — room server process.
 *
 * Creates a room, hosts an HTTP API for agent registration + MCP tools,
 * runs EventProcessor per agent with tmux injection, and provides a
 * readline interface for human chat.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { Room } from "../core/room.js";
import { InMemoryStorage } from "../core/storage.js";
import type { RoomEvent } from "../core/events.js";
import { EventProcessor } from "../agent/event-processor.js";
import { contentPartsToString, participantLabel, formatTimestamp } from "../agent/prompts.js";
import { tmuxInjectText, tmuxSessionExists, tmuxSendEnter } from "./tmux.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ConnectedAgent {
  id: string;
  name: string;
  processor: EventProcessor;
  tmuxSession: string | null;
  tmpDir: string;
  running: boolean;
  runPromise: Promise<void> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpServer: any;
}

export interface ServeOptions {
  room?: string;
  port?: number;
}

// ── Snapshot formatting ──────────────────────────────────────────────────────

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

// ── Main serve command ───────────────────────────────────────────────────────

export async function serve(options: ServeOptions): Promise<void> {
  const roomName = options.room ?? "lobby";
  const port = options.port ?? 7890;

  // Create room
  const storage = new InMemoryStorage();
  const room = new Room(roomName, storage);

  // Connected agents
  const agents = new Map<string, ConnectedAgent>();

  // Human participant
  const humanId = "human_" + randomUUID().slice(0, 8);
  const humanChannel = await room.connect(humanId, "you", "human");

  // Log room events to stdout
  const observer = room.observe();
  (async () => {
    try {
      for await (const event of observer) {
        printEvent(event, roomName, room);
      }
    } catch {
      // Observer disconnected
    }
  })();

  // ── MCP server (per-agent tools) ────────────────────────────────────────

  async function createCliMcpServer(agent: ConnectedAgent) {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

    const mcpServer = new McpServer(
      { name: `stoops_${agent.id}`, version: "1.0.0" },
    );

    // ── send_message tool ──
    mcpServer.tool(
      "send_message",
      "Send a message to the room. Only when you have something genuinely worth saying.",
      {
        content: z.string().describe("Message content"),
        reply_to: z.string().optional()
          .describe("Optional #ref of message to reply to (e.g. '3847')"),
      },
      async ({ content, reply_to }) => {
        let replyToId: string | undefined;
        if (reply_to) {
          replyToId = agent.processor.resolveRef(reply_to.replace("#", ""));
        }
        const conn = agent.processor.resolve(roomName);
        if (!conn) return { content: [{ type: "text" as const, text: "Room not connected." }] };
        await conn.channel.sendMessage(content, replyToId);
        return { content: [{ type: "text" as const, text: "Message sent." }] };
      },
    );

    // ── snapshot_room tool ──
    mcpServer.tool(
      "snapshot_room",
      "Get a searchable copy of the room's event history as a file. Use grep, tail, or Read on the returned path.",
      {},
      async () => {
        const events = await room.listEvents(undefined, 1000);
        const participants = room.listParticipants();

        const pList = participants.map((p) =>
          `${p.type === "stoop" ? "🤖" : "👤"} ${p.name}`
        ).join(", ");

        const lines: string[] = [];
        lines.push(`=== ${roomName} ===`);
        lines.push(`participants: ${pList}`);
        lines.push(`snapshot: ${events.items.length} events`);
        lines.push("===");
        lines.push("");

        // Events are newest-first from storage, reverse for chronological
        for (const event of [...events.items].reverse()) {
          lines.push(formatSnapshotLine(event));
        }

        const filePath = join(agent.tmpDir, `${roomName}.log`);
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

    return mcpServer;
  }

  async function handleMcpRequest(
    agentId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent || !agent.mcpServer) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return;
    }

    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await agent.mcpServer.connect(transport);

    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = undefined; }
    }

    await transport.handleRequest(req, res, body);
  }

  // ── HTTP API ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // MCP endpoint — /mcp?agent=<id>
    if (url.pathname === "/mcp") {
      const agentId = url.searchParams.get("agent");
      if (!agentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing agent query param" }));
        return;
      }
      await handleMcpRequest(agentId, req, res);
      return;
    }

    // JSON API
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}

      if (url.pathname === "/join") {
        const name = String(body.name ?? `agent-${agents.size + 1}`);
        const agentId = `agent_${randomUUID().slice(0, 8)}`;
        const tmpDir = join(tmpdir(), `stoops_${agentId}`);
        mkdirSync(tmpDir, { recursive: true });

        // Create EventProcessor and connect to room (processor owns the channel)
        const processor = new EventProcessor(agentId, name, {
          defaultMode: "everyone",
        });
        await processor.connectRoom(room, roomName, "everyone");

        const agent: ConnectedAgent = {
          id: agentId,
          name,
          processor,
          tmuxSession: null,
          tmpDir,
          running: false,
          runPromise: null,
          mcpServer: null,
        };
        agent.mcpServer = await createCliMcpServer(agent);
        agents.set(agentId, agent);

        const mcpUrl = `http://127.0.0.1:${port}/mcp?agent=${agentId}`;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agentId, mcpUrl, tmpDir }));
        return;
      }

      if (url.pathname === "/connect") {
        const agentId = String(body.agentId ?? "");
        const tmuxSession = String(body.tmuxSession ?? "");
        const agent = agents.get(agentId);

        if (!agent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Agent not found" }));
          return;
        }

        agent.tmuxSession = tmuxSession;
        agent.running = true;

        // Start the event loop — deliver via tmux injection
        agent.runPromise = agent.processor.run(async (parts) => {
          if (!agent.tmuxSession || !tmuxSessionExists(agent.tmuxSession)) return;
          const text = contentPartsToString(parts);
          tmuxInjectText(agent.tmuxSession, `<room-event>\n${text}\n</room-event>`);
          tmuxSendEnter(agent.tmuxSession);
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === "/disconnect") {
        const agentId = String(body.agentId ?? "");
        const agent = agents.get(agentId);

        if (agent) {
          agent.running = false;
          await agent.processor.stop();
          agents.delete(agentId);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    res.writeHead(404).end("Not found");
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`
  stoops v${process.env.npm_package_version ?? "0.3.0"}

  Room: ${roomName}
  Server: http://127.0.0.1:${port}

  Connect an agent:
    stoops run claude --room ${roomName}
    stoops run claude --room ${roomName} --name agent
`);
    console.log(`[${formatTimestamp(new Date())}] Room "${roomName}" created`);
    console.log(`[${formatTimestamp(new Date())}] 👤 you joined`);
  });

  // ── Human readline ──────────────────────────────────────────────────────

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", (line) => {
    const content = line.trim();
    if (content) {
      humanChannel.sendMessage(content).catch((err) => {
        console.error("Failed to send message:", err);
      });
    }
    rl.prompt();
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async () => {
    console.log("\nShutting down...");
    rl.close();
    observer.disconnect();
    for (const agent of agents.values()) {
      await agent.processor.stop();
    }
    await humanChannel.disconnect();
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Event display ────────────────────────────────────────────────────────────

function printEvent(event: RoomEvent, roomName: string, room: Room): void {
  const ts = formatTimestamp(new Date(event.timestamp));

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const sender = room.listParticipants().find((p) => p.id === msg.sender_id);
      const icon = sender?.type === "stoop" ? "🤖" : "👤";
      console.log(`[${ts}] ${icon} ${msg.sender_name}: ${msg.content}`);
      break;
    }
    case "ParticipantJoined":
      console.log(`[${ts}] ${participantLabel(event.participant)} joined`);
      break;
    case "ParticipantLeft":
      console.log(`[${ts}] ${participantLabel(event.participant)} left`);
      break;
    case "Activity":
      if (event.action === "mode_changed") {
        console.log(`[${ts}] mode → ${event.detail?.mode}`);
      }
      break;
    default:
      break;
  }
}
