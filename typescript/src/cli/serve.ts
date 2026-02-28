/**
 * stoops serve — headless room server.
 *
 * Creates a room, hosts an HTTP API for agent registration and human
 * participation. Humans connect via `stoops join`, agents via `stoops run claude`.
 * All event delivery happens over SSE (humans) or tmux injection (agents).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { Room } from "../core/room.js";
import { InMemoryStorage } from "../core/storage.js";
import { randomRoomName, randomName } from "../core/names.js";
import type { RoomEvent } from "../core/events.js";
import type { Channel } from "../core/channel.js";
import { EventProcessor } from "../agent/event-processor.js";
import { contentPartsToString, formatTimestamp } from "../agent/prompts.js";
import { handleSendMessage } from "../agent/tool-handlers.js";
import { tmuxInjectText, tmuxSessionExists, tmuxSendEnter } from "./tmux.js";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectedAgent {
  id: string;
  name: string;
  processor: EventProcessor;
  tmuxSession: string | null;
  tmpDir: string;
  running: boolean;
  runPromise: Promise<void> | null;
}

interface ConnectedHuman {
  id: string;
  name: string;
  channel: Channel;
}

interface ConnectedGuest {
  id: string;
  observer: Channel;
}

export interface ServeOptions {
  room?: string;
  port?: number;
  share?: boolean;
  quiet?: boolean;
}

// ── Snapshot helper ──────────────────────────────────────────────────────────

function formatSnapshotLine(event: RoomEvent): string {
  const ts = formatTimestamp(new Date(event.timestamp));
  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      if (msg.reply_to_id) {
        return `[${ts}] MSG #${msg.id.slice(0, 4)} ${msg.sender_name} → #${msg.reply_to_id.slice(0, 4)}: ${msg.content}`;
      }
      return `[${ts}] MSG #${msg.id.slice(0, 4)} ${msg.sender_name}: ${msg.content}`;
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

// ── SSE helper ───────────────────────────────────────────────────────────────

async function enrichAndSend(res: ServerResponse, event: RoomEvent, room: Room): Promise<void> {
  if (event.type === "MessageSent" && event.message.reply_to_id) {
    const replyMsg = await room.getMessage(event.message.reply_to_id);
    const enriched = {
      ...event,
      _replyToName: replyMsg?.sender_name ?? null,
    };
    res.write(`data: ${JSON.stringify(enriched)}\n\n`);
    return;
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Main serve command ───────────────────────────────────────────────────────

export interface ServeResult {
  serverUrl: string;
  publicUrl: string;
  roomName: string;
}

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const roomName = options.room ?? randomRoomName();
  const port = options.port ?? 7890;
  const serverUrl = `http://127.0.0.1:${port}`;

  // Public URL — either the tunnel URL (if --share) or the local server URL.
  // Updated once the tunnel is ready.
  let publicUrl = serverUrl;
  let tunnelProcess: ChildProcess | null = null;

  // Create room
  const storage = new InMemoryStorage();
  const room = new Room(roomName, storage);

  // Connected participants
  const agents = new Map<string, ConnectedAgent>();
  const humans = new Map<string, ConnectedHuman>();
  const guests = new Map<string, ConnectedGuest>();

  // Track active SSE connections for cleanup
  const sseConnections = new Map<string, ServerResponse>();

  // ── MCP tool registration helper ─────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function registerMcpTools(mcpServer: any, agent: ConnectedAgent): Promise<void> {
    const toolOptions = {
      assignRef: (id: string) => agent.processor.assignRef(id),
      resolveRef: (ref: string) => agent.processor.resolveRef(ref),
    };

    mcpServer.tool(
      "send_message",
      "Send a message to a specific room. Only use this when you have something genuinely worth saying — a reaction, an answer, a question, a joke. Most of the time, staying quiet is the right call. Not every message needs a response.",
      {
        room: z.string().describe("Name of the room to send to"),
        content: z.string().describe("Message content"),
        reply_to_id: z.string().optional()
          .describe("Only set this when replying to a specific earlier message adds clarity. Use the #XXXX ref shown in snapshot output."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => handleSendMessage(agent.processor, args, toolOptions) as any,
    );

    mcpServer.tool(
      "snapshot_room",
      "Get a searchable copy of the room's event history as a file. Use grep, tail, or Read on the returned path.",
      {
        room: z.string().describe("Name of the room to snapshot"),
      },
      async ({ room: roomArg }: { room: string }) => {
        const conn = agent.processor.resolve(roomArg);
        if (!conn) {
          return { content: [{ type: "text" as const, text: `Unknown room "${roomArg}".` }] };
        }

        const events = await conn.room.listEvents(undefined, 1000);
        const participants = conn.room.listParticipants();
        const pList = participants.map((p) => `${p.type} ${p.name}`).join(", ");

        const lines: string[] = [
          `=== ${roomArg} ===`,
          `participants: ${pList}`,
          `snapshot: ${events.items.length} events`,
          "===",
          "",
        ];

        for (const event of [...events.items].reverse()) {
          lines.push(formatSnapshotLine(event));
        }

        const filePath = join(agent.tmpDir, `${roomArg}.log`);
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

  // ── JSON body parser helper ──────────────────────────────────────────────

  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
  }

  // ── HTTP API ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // ── SSE event stream ───────────────────────────────────────────────────
    if (url.pathname === "/events" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing id parameter" }));
        return;
      }

      const human = humans.get(id);
      const guest = guests.get(id);
      const channel = human?.channel ?? guest?.observer;

      if (!channel) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Participant not found" }));
        return;
      }

      // SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      sseConnections.set(id, res);

      // Send recent history so the joiner has context
      const history = await room.listEvents(undefined, 50);
      for (const event of [...history.items].reverse()) {
        await enrichAndSend(res, event, room);
      }

      // Live event stream
      const streamEvents = async () => {
        try {
          for await (const event of channel) {
            await enrichAndSend(res, event, room);
          }
        } catch {
          // Channel disconnected
        }
      };
      streamEvents();

      // Cleanup on client disconnect
      req.on("close", () => {
        sseConnections.delete(id);
        if (human) {
          human.channel.disconnect().catch(() => {});
          humans.delete(id);
          logServer(`${human.name} disconnected`);
        }
        if (guest) {
          guest.observer.disconnect().catch(() => {});
          guests.delete(id);
        }
      });
      return;
    }

    // ── MCP endpoint — per-request McpServer, routed by agent ID ───────────
    if (url.pathname === "/mcp") {
      const agentId = url.searchParams.get("agent");
      const agent = agentId ? agents.get(agentId) : undefined;

      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return;
      }

      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
      );

      const mcpServer = new McpServer({ name: "stoops", version: "1.0.0" });
      await registerMcpTools(mcpServer, agent);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);

      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = undefined; }
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    // ── JSON API ────────────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await parseBody(req);

      // ── POST /join ──────────────────────────────────────────────────────
      if (url.pathname === "/join") {
        const type = String(body.type ?? "agent");

        if (type === "human") {
          const name = String(body.name ?? randomName());
          const id = `human_${randomUUID().slice(0, 8)}`;
          const channel = await room.connect(id, name, "human");
          humans.set(id, { id, name, channel });

          const participants = room.listParticipants().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
          }));

          logServer(`${name} joined`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ participantId: id, roomName, participants }));
          return;
        }

        if (type === "guest") {
          const id = `guest_${randomUUID().slice(0, 8)}`;
          const observer = room.observe();
          guests.set(id, { id, observer });

          const participants = room.listParticipants().map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ participantId: id, roomName, participants }));
          return;
        }

        // type === "agent" (default, backward compatible)
        const name = String(body.name ?? `agent-${agents.size + 1}`);
        const agentId = `agent_${randomUUID().slice(0, 8)}`;
        const tmpDir = `${tmpdir()}/stoops_${agentId}`;
        mkdirSync(tmpDir, { recursive: true });

        const processor = new EventProcessor(agentId, name, { defaultMode: "everyone" });
        await processor.connectRoom(room, roomName, "everyone");

        const agent: ConnectedAgent = {
          id: agentId,
          name,
          processor,
          tmuxSession: null,
          tmpDir,
          running: false,
          runPromise: null,
        };
        agents.set(agentId, agent);

        const mcpUrl = `${publicUrl}/mcp?agent=${agentId}`;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agentId, mcpUrl, tmpDir }));
        return;
      }

      // ── POST /message ───────────────────────────────────────────────────
      if (url.pathname === "/message") {
        const participantId = String(body.participantId ?? "");
        const content = String(body.content ?? "");
        const replyTo = body.replyTo ? String(body.replyTo) : undefined;

        const human = humans.get(participantId);
        if (!human) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not a human participant or not found" }));
          return;
        }

        if (!content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Empty message" }));
          return;
        }

        await human.channel.sendMessage(content, replyTo);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── POST /connect (agent tmux session) ──────────────────────────────
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

      // ── POST /disconnect ────────────────────────────────────────────────
      if (url.pathname === "/disconnect") {
        const id = String(body.agentId ?? body.participantId ?? "");

        const agent = agents.get(id);
        if (agent) {
          agent.running = false;
          await agent.processor.stop();
          agents.delete(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const human = humans.get(id);
        if (human) {
          await human.channel.disconnect();
          humans.delete(id);
          // Close SSE connection if open
          const sse = sseConnections.get(id);
          if (sse) {
            sse.end();
            sseConnections.delete(id);
          }
          logServer(`${human.name} disconnected`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const guest = guests.get(id);
        if (guest) {
          await guest.observer.disconnect();
          guests.delete(id);
          const sse = sseConnections.get(id);
          if (sse) {
            sse.end();
            sseConnections.delete(id);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    res.writeHead(404).end("Not found");
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Another stoops instance may be running.`);
      console.error(`  Kill it:   lsof -ti :${port} | xargs kill`);
      console.error(`  Or use:    stoops --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => resolve());
  });

  // Start tunnel if --share (always, regardless of quiet)
  if (options.share) {
    tunnelProcess = await startTunnel(port);
    if (tunnelProcess) {
      const tunnelUrl = await waitForTunnelUrl(tunnelProcess);
      if (tunnelUrl) {
        publicUrl = tunnelUrl;
      }
    }
  }

  if (!options.quiet) {
    const version = process.env.npm_package_version ?? "0.3.0";

    if (options.share && publicUrl !== serverUrl) {
      console.log(`
  stoops v${version}

  Room:    ${roomName}
  Server:  ${serverUrl}
  Share:   ${publicUrl}

  Join:    stoops join ${publicUrl}
  Agent:   stoops run claude --room ${roomName} --server ${publicUrl}
`);
    } else if (options.share) {
      console.log(`
  stoops v${version}

  Room:    ${roomName}
  Server:  ${serverUrl}
  Share:   (tunnel failed to start — falling back to local)

  Join:    stoops join ${serverUrl}
  Agent:   stoops run claude --room ${roomName}
`);
    } else {
      console.log(`
  stoops v${version}

  Room:    ${roomName}
  Server:  ${serverUrl}

  Join:    stoops join ${serverUrl}
  Agent:   stoops run claude --room ${roomName}
`);
    }
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async () => {
    logServer("shutting down...");

    // Kill tunnel
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
    }

    // Close all SSE connections
    for (const [id, sse] of sseConnections) {
      sse.end();
      sseConnections.delete(id);
    }

    // Disconnect all agents
    for (const agent of agents.values()) {
      await agent.processor.stop();
    }

    // Disconnect all humans
    for (const human of humans.values()) {
      await human.channel.disconnect();
    }

    // Disconnect all guests
    for (const guest of guests.values()) {
      await guest.observer.disconnect();
    }

    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { serverUrl, publicUrl, roomName };
}

// ── Server log ────────────────────────────────────────────────────────────────

function logServer(message: string): void {
  console.log(`  [${formatTimestamp(new Date())}] ${message}`);
}

// ── Cloudflared tunnel ───────────────────────────────────────────────────────

function cloudflaredAvailable(): boolean {
  try {
    execFileSync("which", ["cloudflared"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function startTunnel(port: number): Promise<ChildProcess | null> {
  if (!cloudflaredAvailable()) {
    console.error("  --share requires cloudflared. Install: brew install cloudflared");
    return null;
  }

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.on("error", () => {
    // cloudflared failed to start
  });

  return child;
}

function waitForTunnelUrl(child: ChildProcess, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      // Look for the tunnel URL in cloudflared output
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    });

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}
