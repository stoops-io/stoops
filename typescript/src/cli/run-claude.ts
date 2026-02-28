/**
 * stoops run claude — client-side agent runtime.
 *
 * Connects a Claude Code instance to one or more stoop servers.
 * Manages SSE connections, engagement classification, local MCP proxy,
 * and tmux delivery — all client-side.
 *
 * Flow:
 *   1. Join each --join URL → get session tokens + room metadata
 *   2. Create RemoteRoomDataSource per room
 *   3. Create SseMultiplexer with one SSE connection per room
 *   4. Create EventProcessor with connectRemoteRoom() per room
 *   5. Create local runtime MCP server
 *   6. Write MCP config file, launch `claude --mcp-config` in tmux
 *   7. Start EventProcessor.run(tmuxDeliver, sseMultiplexer)
 *   8. Block on tmux attach
 *   9. Cleanup: close SSE, disconnect from servers, kill tmux
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxInjectText,
  tmuxSendEnter,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
} from "./tmux.js";
import { randomName } from "../core/names.js";
import { extractToken } from "./auth.js";
import { RemoteRoomDataSource } from "../agent/remote-room-data-source.js";
import { SseMultiplexer } from "../agent/sse-multiplexer.js";
import { EventProcessor } from "../agent/event-processor.js";
import { contentPartsToString } from "../agent/prompts.js";
import { createRuntimeMcpServer, type RuntimeMcpServer } from "../agent/mcp/runtime.js";
import type { ContentPart } from "../agent/types.js";
import type { Participant } from "../core/types.js";

export interface RunClaudeOptions {
  /** URLs to join (repeatable, each may contain a share token). */
  joinUrls?: string[];
  /** Legacy: room name (used with --server). */
  room?: string;
  name?: string;
  /** Legacy: server URL. */
  server?: string;
  /** If true, register admin MCP tools. */
  admin?: boolean;
}

interface JoinResult {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
}

export async function runClaude(options: RunClaudeOptions): Promise<void> {
  const agentName = options.name ?? randomName();

  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  // ── Determine join targets ────────────────────────────────────────────

  interface JoinTarget {
    serverUrl: string;
    token: string | null;
  }

  const targets: JoinTarget[] = [];

  if (options.joinUrls && options.joinUrls.length > 0) {
    for (const url of options.joinUrls) {
      const token = extractToken(url);
      let serverUrl: string;
      try {
        const parsed = new URL(url);
        parsed.search = "";
        serverUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        serverUrl = url.replace(/\/$/, "");
      }
      targets.push({ serverUrl, token });
    }
  } else if (options.room) {
    // Legacy mode
    const serverUrl = options.server ?? "http://127.0.0.1:7890";
    targets.push({ serverUrl, token: null });
  }

  if (targets.length === 0) {
    console.error("No join targets specified. Use --join <url> or --room <name>.");
    process.exit(1);
  }

  // ── Join each target ──────────────────────────────────────────────────

  const joinResults: JoinResult[] = [];

  for (const target of targets) {
    console.log(`Joining ${target.serverUrl}...`);

    try {
      const joinBody: Record<string, unknown> = {
        type: "agent",
        name: agentName,
      };
      if (target.token) joinBody.token = target.token;

      const res = await fetch(`${target.serverUrl}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(joinBody),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Failed to join: ${err}`);
        process.exit(1);
      }

      const data = await res.json() as Record<string, unknown>;
      const sessionToken = String(data.sessionToken ?? "");
      const participantId = String(data.participantId ?? "");
      const roomName = String(data.roomName ?? "");
      const roomId = String(data.roomId ?? "");
      const authority = String(data.authority ?? "participant");
      const participants = (data.participants as Participant[]) ?? [];

      // Create RemoteRoomDataSource and seed participant cache
      const dataSource = new RemoteRoomDataSource(target.serverUrl, sessionToken, roomId);
      dataSource.setParticipants(participants);

      joinResults.push({
        serverUrl: target.serverUrl,
        sessionToken,
        participantId,
        roomName,
        roomId,
        authority,
        participants,
        dataSource,
      });

      console.log(`  Joined ${roomName} as ${agentName} (${authority})`);
    } catch {
      console.error(`Cannot reach stoops server at ${target.serverUrl}. Is it running?`);
      process.exit(1);
    }
  }

  // All join results should have the same participantId (same agent across rooms on same server)
  // but could be different across different servers. Use the first one.
  const primaryResult = joinResults[0];
  const participantId = primaryResult.participantId;

  // ── Create SSE multiplexer ──────────────────────────────────────────────

  const sseMux = new SseMultiplexer();
  for (const jr of joinResults) {
    sseMux.addConnection(jr.serverUrl, jr.sessionToken, jr.roomName, jr.roomId);
  }

  // ── Create EventProcessor ──────────────────────────────────────────────

  const processor = new EventProcessor(participantId, agentName, {
    defaultMode: "everyone",
  });

  // Register each room as a remote room
  for (const jr of joinResults) {
    processor.connectRemoteRoom(jr.dataSource, jr.roomName);
  }

  // ── Create local runtime MCP server ────────────────────────────────────

  let mcpServer: RuntimeMcpServer | null = null;

  mcpServer = await createRuntimeMcpServer({
    resolver: processor,
    toolOptions: {
      isEventSeen: (id) => processor.isEventSeen(id),
      markEventsSeen: (ids) => processor.markEventsSeen(ids),
      assignRef: (id) => processor.assignRef(id),
      resolveRef: (ref) => processor.resolveRef(ref),
    },
    admin: options.admin,
    onSetMode: async (room, mode) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      // Set mode locally in the EventProcessor
      processor.setModeForRoom(conn.dataSource.roomId, mode as any, false);
      // Notify the server
      try {
        const ds = conn.dataSource as RemoteRoomDataSource;
        const res = await fetch(`${ds.serverUrl}/set-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ds.sessionToken, mode }),
        });
        if (!res.ok) return { success: false, error: `Server rejected: ${await res.text()}` };
      } catch {
        // Server unreachable, local mode still set
      }
      return { success: true };
    },
    onJoinRoom: async (url, alias) => {
      const token = extractToken(url);
      let serverUrl: string;
      try {
        const parsed = new URL(url);
        parsed.search = "";
        serverUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        serverUrl = url.replace(/\/$/, "");
      }

      try {
        const joinBody: Record<string, unknown> = { type: "agent", name: agentName };
        if (token) joinBody.token = token;

        const res = await fetch(`${serverUrl}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(joinBody),
        });
        if (!res.ok) return { success: false, error: `Failed to join: ${await res.text()}` };

        const data = await res.json() as Record<string, unknown>;
        const sessionToken = String(data.sessionToken ?? "");
        const roomName = alias ?? String(data.roomName ?? "");
        const roomId = String(data.roomId ?? "");
        const participants = (data.participants as Participant[]) ?? [];

        const dataSource = new RemoteRoomDataSource(serverUrl, sessionToken, roomId);
        dataSource.setParticipants(participants);

        // Register in EventProcessor and SSE multiplexer
        processor.connectRemoteRoom(dataSource, roomName);
        sseMux.addConnection(serverUrl, sessionToken, roomName, roomId);

        // Track for cleanup
        joinResults.push({
          serverUrl,
          sessionToken,
          participantId: String(data.participantId ?? ""),
          roomName,
          roomId,
          authority: String(data.authority ?? "participant"),
          participants,
          dataSource,
        });

        return { success: true };
      } catch {
        return { success: false, error: `Cannot reach server at ${serverUrl}` };
      }
    },
    onLeaveRoom: async (room) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const roomId = conn.dataSource.roomId;

      // Find the join result for this room
      const idx = joinResults.findIndex((jr) => jr.roomId === roomId);
      if (idx >= 0) {
        const jr = joinResults[idx];
        sseMux.removeConnection(roomId);
        processor.disconnectRemoteRoom(roomId);

        try {
          await fetch(`${jr.serverUrl}/disconnect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: jr.sessionToken }),
          });
        } catch {
          // Server may be down
        }

        joinResults.splice(idx, 1);
      }
      return { success: true };
    },
    onAdminSetModeFor: options.admin ? async (room, participant, mode) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      // Find participant by name
      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/set-mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ds.sessionToken, participantId: p.id, mode }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
    onAdminKick: options.admin ? async (room, participant) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const ds = conn.dataSource as RemoteRoomDataSource;

      const p = conn.dataSource.listParticipants().find((pp) => pp.name === participant);
      if (!p) return { success: false, error: `Unknown participant "${participant}".` };

      try {
        const res = await fetch(`${ds.serverUrl}/kick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ds.sessionToken, participantId: p.id }),
        });
        if (!res.ok) return { success: false, error: await res.text() };
        return { success: true };
      } catch {
        return { success: false, error: "Server unreachable." };
      }
    } : undefined,
  });

  // ── Write MCP config file ──────────────────────────────────────────────

  const tmpDir = mkdtempSync(join(tmpdir(), "stoops_agent_"));
  const mcpConfigPath = join(tmpDir, "mcp.json");

  const mcpConfig = {
    mcpServers: {
      stoops: {
        url: mcpServer.url,
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // ── Create tmux session + launch Claude Code ───────────────────────────

  const primaryRoom = primaryResult.roomName;
  const tmuxSession = `stoops_${primaryRoom}_${agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession);

  // Launch claude with MCP config pointing at local runtime server
  tmuxSendCommand(tmuxSession, `claude --mcp-config ${mcpConfigPath}`);

  // ── Start EventProcessor with SSE source + tmux delivery ───────────────

  const tmuxDeliver = async (parts: ContentPart[]) => {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;
    // Inject event text wrapped in XML tags so Claude Code can parse it
    tmuxInjectText(tmuxSession, `<room-event>\n${text}\n</room-event>`);
    tmuxSendEnter(tmuxSession);
  };

  // Update participant caches as SSE events arrive
  // We do this by listening to the SSE multiplexer's events in the EventProcessor.
  // The EventProcessor will call _handleLabeledEvent which processes ParticipantJoined/Left.
  // But we also need to update the RemoteRoomDataSource participant cache.
  // We'll do this via a wrapper that intercepts participant events.

  // Create a wrapper around the SSE multiplexer that also updates participant caches
  const wrappedSource: AsyncIterable<import("../agent/multiplexer.js").LabeledEvent> = {
    [Symbol.asyncIterator]() {
      const inner = sseMux[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await inner.next();
          if (!result.done) {
            const { roomId, event } = result.value;
            // Update participant cache in RemoteRoomDataSource
            const jr = joinResults.find((j) => j.roomId === roomId);
            if (jr) {
              if (event.type === "ParticipantJoined") {
                jr.dataSource.addParticipant(event.participant);
              } else if (event.type === "ParticipantLeft") {
                jr.dataSource.removeParticipant(event.participant_id);
              }
            }
          }
          return result;
        },
      };
    },
  };

  // Start the event loop in the background
  const eventLoopPromise = processor.run(tmuxDeliver, wrappedSource);

  // ── Wait for Claude Code to be ready, then attach ───────────────────────

  await new Promise((r) => setTimeout(r, 2000));

  console.log("Attaching to Claude Code session...\n");

  try {
    tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  // Stop event processor and SSE
  await processor.stop();
  sseMux.close();

  // Stop MCP server
  if (mcpServer) {
    await mcpServer.stop();
  }

  // Disconnect from all servers
  for (const jr of joinResults) {
    try {
      await fetch(`${jr.serverUrl}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: jr.sessionToken }),
      });
    } catch {
      // Server may be down
    }
  }

  // Clean up tmux and temp files
  tmuxKillSession(tmuxSession);
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }

  console.log("Disconnected.");
}
