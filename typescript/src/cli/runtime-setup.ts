/**
 * Shared agent runtime setup — extracted from cli/claude/run.ts.
 *
 * Both `stoops run claude` and `stoops run opencode` use this to:
 *   1. Join servers via HTTP
 *   2. Create SSE multiplexer + EventProcessor
 *   3. Create local runtime MCP server
 *   4. Wire up participant cache updates
 *   5. Provide cleanup
 *
 * Each runtime only needs to provide its own delivery mechanism
 * (TmuxBridge for Claude, HTTP API for OpenCode).
 */

import { randomName } from "../core/names.js";
import { extractToken } from "./auth.js";
import { RemoteRoomDataSource } from "../agent/remote-room-data-source.js";
import { SseMultiplexer } from "../agent/sse-multiplexer.js";
import { EventProcessor } from "../agent/event-processor.js";
import { createRuntimeMcpServer, type RuntimeMcpServer, type JoinRoomResult } from "../agent/mcp/runtime.js";
import { buildCatchUpLines } from "../agent/tool-handlers.js";
import type { Participant } from "../core/types.js";
import type { LabeledEvent } from "../agent/multiplexer.js";
import type { ContentPart } from "../agent/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentRuntimeOptions {
  joinUrls?: string[];
  room?: string;
  name?: string;
  server?: string;
  admin?: boolean;
  extraArgs?: string[];
}

export interface JoinResult {
  serverUrl: string;
  sessionToken: string;
  participantId: string;
  roomName: string;
  roomId: string;
  authority: string;
  participants: Participant[];
  dataSource: RemoteRoomDataSource;
}

export interface AgentRuntimeSetup {
  agentName: string;
  participantId: string;
  joinResults: JoinResult[];
  initialParts: ContentPart[] | undefined;
  processor: EventProcessor;
  sseMux: SseMultiplexer;
  mcpServer: RuntimeMcpServer;
  wrappedSource: AsyncIterable<LabeledEvent>;
  cleanup(): Promise<void>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export async function setupAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntimeSetup> {
  const agentName = options.name ?? randomName();

  // ── Determine join targets ──────────────────────────────────────────────

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

  // ── Join each target ────────────────────────────────────────────────────

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

  const participantId = joinResults[0].participantId;

  // ── Create SSE multiplexer ────────────────────────────────────────────

  const sseMux = new SseMultiplexer();
  for (const jr of joinResults) {
    sseMux.addConnection(jr.serverUrl, jr.sessionToken, jr.roomName, jr.roomId);
  }

  // ── Create EventProcessor ─────────────────────────────────────────────

  const processor = new EventProcessor(participantId, agentName, {
    defaultMode: "everyone",
  });

  // Register each room as a remote room
  for (const jr of joinResults) {
    processor.connectRemoteRoom(jr.dataSource, jr.roomName);
  }

  // ── Create local runtime MCP server ───────────────────────────────────

  const mcpServer = await createRuntimeMcpServer({
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
        const authority = String(data.authority ?? "participant");
        const participants = (data.participants as Participant[]) ?? [];
        const newParticipantId = String(data.participantId ?? "");

        const dataSource = new RemoteRoomDataSource(serverUrl, sessionToken, roomId);
        dataSource.setParticipants(participants);

        // Register in EventProcessor and SSE multiplexer
        const mode = processor.getModeForRoom(roomId) ?? "everyone";
        processor.connectRemoteRoom(dataSource, roomName);
        sseMux.addConnection(serverUrl, sessionToken, roomName, roomId);

        // Track for cleanup
        const jr: JoinResult = {
          serverUrl,
          sessionToken,
          participantId: newParticipantId,
          roomName,
          roomId,
          authority,
          participants,
          dataSource,
        };
        joinResults.push(jr);

        // Build recent activity lines for the response
        const conn = processor.resolve(roomName);
        let recentLines: string[] = [];
        if (conn) {
          recentLines = await buildCatchUpLines(conn, {
            isEventSeen: (id) => processor.isEventSeen(id),
            markEventsSeen: (ids) => processor.markEventsSeen(ids),
            assignRef: (id) => processor.assignRef(id),
          });
        }

        return {
          success: true,
          roomName,
          agentName,
          authority,
          mode,
          participants: participants
            .filter((p) => p.id !== newParticipantId)
            .map((p) => ({ name: p.name, authority: (p as any).authority ?? "participant" })),
          recentLines,
        } as JoinRoomResult;
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

  // ── Wrap SSE source for participant cache updates ─────────────────────

  const wrappedSource: AsyncIterable<LabeledEvent> = {
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

  // ── Cleanup function ──────────────────────────────────────────────────

  async function cleanup(): Promise<void> {
    await processor.stop();
    sseMux.close();
    await mcpServer.stop();

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
  }

  // ── Build auto-join startup message (if any rooms were auto-joined) ──

  let initialParts: ContentPart[] | undefined;
  if (joinResults.length > 0) {
    const roomSummaries = joinResults.map((jr) => {
      const mode = processor.getModeForRoom(jr.roomId);
      const pCount = jr.participants.length;
      return `${jr.roomName} (${mode} mode, ${pCount} participant${pCount === 1 ? "" : "s"})`;
    });
    const text = `Auto-joined ${roomSummaries.join(" and ")}.`;
    initialParts = [{ type: "text", text }];
  }

  return {
    agentName,
    participantId,
    joinResults,
    initialParts,
    processor,
    sseMux,
    mcpServer,
    wrappedSource,
    cleanup,
  };
}
