/**
 * Shared agent runtime setup — extracted from cli/claude/run.ts.
 *
 * Both `stoops run claude` and `stoops run opencode` use this to:
 *   1. Create SSE multiplexer + EventProcessor
 *   2. Create local runtime MCP server
 *   3. Wire up participant cache updates
 *   4. Provide cleanup
 *
 * Rooms are NOT joined during setup. The agent joins rooms by calling
 * join_room() via MCP. If --join URLs are provided, the startup event
 * asks the agent to call join_room for each URL.
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
  name?: string;
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

  // ── Pending join URLs (not joined yet — agent calls join_room) ─────────

  const pendingUrls = options.joinUrls ?? [];

  // ── Mutable join results (populated as agent calls join_room) ──────────

  const joinResults: JoinResult[] = [];

  // ── Create SSE multiplexer (starts empty) ──────────────────────────────

  const sseMux = new SseMultiplexer();

  // ── Create EventProcessor (selfId set on first join_room) ──────────────

  const processor = new EventProcessor("", agentName, {
    defaultMode: "everyone",
  });

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
      processor.setModeForRoom(conn.dataSource.roomId, mode as any, false);
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
          signal: AbortSignal.timeout(15_000),
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
        dataSource.setSelf(newParticipantId, agentName);

        // Set selfId on first join
        if (joinResults.length === 0) {
          processor.participantId = newParticipantId;
        }

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Unable to connect. Is the server running? (${serverUrl}) — ${msg}` };
      }
    },
    onLeaveRoom: async (room) => {
      const conn = processor.resolve(room);
      if (!conn) return { success: false, error: `Unknown room "${room}".` };
      const roomId = conn.dataSource.roomId;

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

  // ── Build startup event (if --join URLs were provided) ────────────────

  let initialParts: ContentPart[] | undefined;
  if (pendingUrls.length > 0) {
    if (pendingUrls.length === 1) {
      initialParts = [{ type: "text", text: `Use join_room("${pendingUrls[0]}") to connect.` }];
    } else {
      const lines = pendingUrls.map((u) => `  join_room("${u}")`);
      initialParts = [{ type: "text", text: `Rooms to join:\n${lines.join("\n")}` }];
    }
  }

  return {
    agentName,
    joinResults,
    initialParts,
    processor,
    sseMux,
    mcpServer,
    wrappedSource,
    cleanup,
  };
}
