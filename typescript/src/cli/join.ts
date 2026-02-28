/**
 * stoops join — connect to a room as a human participant.
 *
 * Opens the TUI and connects to a stoops server over HTTP.
 * Events stream in via SSE, messages sent via POST /message.
 */

import { randomUUID } from "node:crypto";
import { randomName } from "../core/names.js";
import type { RoomEvent } from "../core/events.js";
import { formatTimestamp } from "../agent/prompts.js";
import { startTUI, type TUIHandle, type DisplayEvent } from "./tui.js";

export interface JoinOptions {
  server: string;
  name?: string;
  guest?: boolean;
  /** Tunnel URL to display in the TUI banner (for host+join mode with --share). */
  shareUrl?: string;
}

export async function join(options: JoinOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, "");
  const name = options.name ?? randomName();
  const isGuest = options.guest ?? false;

  // ── Register with server ────────────────────────────────────────────────

  let participantId: string;
  let roomName: string;
  let participants: Array<{ id: string; name: string; type: string }>;

  try {
    const res = await fetch(`${serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: isGuest ? undefined : name,
        type: isGuest ? "guest" : "human",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Failed to join: ${err}`);
      process.exit(1);
    }

    const data = await res.json() as Record<string, unknown>;
    participantId = String(data.participantId);
    roomName = String(data.roomName);
    participants = (data.participants as Array<{ id: string; name: string; type: string }>) ?? [];
  } catch {
    console.error(`Cannot reach stoops server at ${serverUrl}. Is it running?`);
    process.exit(1);
  }

  // ── Disconnect helper ───────────────────────────────────────────────────

  let disconnected = false;
  const disconnect = async () => {
    if (disconnected) return;
    disconnected = true;
    try {
      await fetch(`${serverUrl}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId }),
      });
    } catch {
      // Server may be down
    }
  };

  // ── Start TUI ───────────────────────────────────────────────────────────

  const tui = startTUI({
    roomName,
    serverUrl,
    shareUrl: options.shareUrl,
    readOnly: isGuest,
    onSend: isGuest ? undefined : async (content: string) => {
      try {
        await fetch(`${serverUrl}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId, content }),
        });
      } catch {
        // Server may be down — silently fail
      }
    },
    onCtrlC: async () => {
      await disconnect();
      tui.stop();
      process.exit(0);
    },
  });

  // Set initial agent names
  const agentNames = participants
    .filter((p) => p.type === "agent")
    .map((p) => p.name);
  if (agentNames.length > 0) {
    tui.setAgentNames(agentNames);
  }

  // ── Connect SSE event stream ────────────────────────────────────────────

  try {
    const res = await fetch(`${serverUrl}/events?id=${participantId}`, {
      headers: { Accept: "text/event-stream" },
    });

    if (!res.ok || !res.body) {
      console.error("Failed to connect event stream");
      await disconnect();
      process.exit(1);
    }

    // Track participant types and agent names from live events
    const participantTypes = new Map<string, "human" | "agent">();
    for (const p of participants) {
      participantTypes.set(p.id, p.type as "human" | "agent");
    }
    const currentAgents = new Set(agentNames);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processEvents = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE: split on double newline
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // keep incomplete chunk

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as RoomEvent & { _replyToName?: string };

              // Track participant types from presence events
              if (event.type === "ParticipantJoined") {
                participantTypes.set(event.participant.id, event.participant.type);
              }

              const displayEvent = toDisplayEvent(event, participantId, participantTypes);
              if (displayEvent) {
                tui.push(displayEvent);
              }

              // Update agent names on join/leave
              if (event.type === "ParticipantJoined" && event.participant.type === "agent") {
                currentAgents.add(event.participant.name);
                tui.setAgentNames([...currentAgents]);
              }
              if (event.type === "ParticipantLeft" && event.participant.type === "agent") {
                currentAgents.delete(event.participant.name);
                tui.setAgentNames([...currentAgents]);
              }
              if (event.type === "ParticipantLeft") {
                participantTypes.delete(event.participant.id);
              }
            } catch {
              // Malformed event — skip
            }
          }
        }
      } catch {
        // Stream ended
      }

      // Server disconnected — clean exit
      if (!disconnected) {
        tui.stop();
        console.log("\nServer disconnected.");
        process.exit(0);
      }
    };

    processEvents();
  } catch {
    console.error("Failed to connect event stream");
    await disconnect();
    process.exit(1);
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────

  process.on("SIGINT", async () => {
    await disconnect();
    tui.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await disconnect();
    tui.stop();
    process.exit(0);
  });
}

// ── RoomEvent → DisplayEvent conversion ───────────────────────────────────────

function toDisplayEvent(
  event: RoomEvent & { _replyToName?: string },
  selfId: string,
  participantTypes: Map<string, "human" | "agent">,
): DisplayEvent | null {
  const ts = formatTimestamp(new Date(event.timestamp));

  switch (event.type) {
    case "MessageSent": {
      const msg = event.message;
      const senderType = participantTypes.get(msg.sender_id) ?? "human";
      return {
        id: msg.id,
        ts,
        kind: "message",
        senderName: msg.sender_name,
        senderType,
        isSelf: msg.sender_id === selfId,
        content: msg.content,
        replyToName: event._replyToName ?? undefined,
      };
    }
    case "ParticipantJoined":
      return {
        id: randomUUID(),
        ts,
        kind: "join",
        name: event.participant.name,
        participantType: event.participant.type,
      };
    case "ParticipantLeft":
      return {
        id: randomUUID(),
        ts,
        kind: "leave",
        name: event.participant.name,
        participantType: event.participant.type,
      };
    case "Activity":
      if (event.action === "mode_changed") {
        return {
          id: randomUUID(),
          ts,
          kind: "mode",
          mode: String((event.detail as Record<string, unknown>)?.mode ?? ""),
        };
      }
      return null;
    default:
      return null;
  }
}
