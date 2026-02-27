/**
 * stoops serve — room server process.
 *
 * Creates a room, hosts an HTTP API for agent registration,
 * runs EventProcessor per agent with tmux injection, and provides a
 * readline interface for human chat.
 */

import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { Room } from "../core/room.js";
import { InMemoryStorage } from "../core/storage.js";
import type { RoomEvent } from "../core/events.js";
import { EventProcessor } from "../agent/event-processor.js";
import { createFullMcpServer, createLiteMcpServer, type StoopsMcpServer } from "../agent/mcp/index.js";
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
  mcpServer: StoopsMcpServer | null;
}

export interface ServeOptions {
  room?: string;
  port?: number;
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

  // ── HTTP API ────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // JSON API
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}

      if (url.pathname === "/join") {
        const name = String(body.name ?? `agent-${agents.size + 1}`);
        const agentId = `agent_${randomUUID().slice(0, 8)}`;
        const tmpDir = `${tmpdir()}/stoops_${agentId}`;
        mkdirSync(tmpDir, { recursive: true });

        // Create EventProcessor and connect to room (processor owns the channel)
        const processor = new EventProcessor(agentId, name, {
          defaultMode: "everyone",
        });
        await processor.connectRoom(room, roomName, "everyone");

        const mcpMode = body.mcp === "full" ? "full" : "lite";
        const toolOptions = {
          assignRef: (id: string) => processor.assignRef(id),
          resolveRef: (ref: string) => processor.resolveRef(ref),
        };

        const mcpServer = mcpMode === "full"
          ? await createFullMcpServer(processor, toolOptions)
          : await createLiteMcpServer(processor, toolOptions, tmpDir);

        const agent: ConnectedAgent = {
          id: agentId,
          name,
          processor,
          tmuxSession: null,
          tmpDir,
          running: false,
          runPromise: null,
          mcpServer,
        };
        agents.set(agentId, agent);

        const mcpUrl = mcpServer.url;

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
          await agent.mcpServer?.stop();
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
      await agent.mcpServer?.stop();
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
      const typeLabel = sender?.type ?? "human";
      console.log(`[${ts}] ${typeLabel} ${msg.sender_name}: ${msg.content}`);
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
