/**
 * stoops join — connect to a room as a human participant.
 *
 * Opens the TUI and connects to a stoops server over HTTP.
 * Events stream in via SSE, messages sent via POST /message.
 */

import { randomUUID } from "node:crypto";
import { randomName } from "../core/names.js";
import type { RoomEvent } from "../core/events.js";
import type { AuthorityLevel } from "../core/types.js";
import { formatTimestamp } from "../agent/prompts.js";
import { startTUI, type TUIHandle, type DisplayEvent } from "./tui.js";
import { extractToken, buildShareUrl } from "./auth.js";

export interface JoinOptions {
  server: string;
  name?: string;
  guest?: boolean;
  /** Tunnel URL to display in the TUI banner (for host+join mode with --share). */
  shareUrl?: string;
}

export async function join(options: JoinOptions): Promise<void> {
  // Extract token from URL if present
  const token = extractToken(options.server);
  // Strip query params to get clean server URL
  let serverUrl: string;
  try {
    const parsed = new URL(options.server);
    parsed.search = "";
    serverUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    serverUrl = options.server.replace(/\/$/, "");
  }

  const name = options.name ?? randomName();
  const isGuest = options.guest ?? false;

  // ── Register with server ────────────────────────────────────────────────

  let sessionToken: string;
  let participantId: string;
  let roomName: string;
  let authority: AuthorityLevel;
  let participants: Array<{ id: string; name: string; type: string; authority?: string }>;

  try {
    const joinBody: Record<string, unknown> = {};
    if (token) {
      joinBody.token = token;
      joinBody.type = "human";
      joinBody.name = name;
    } else if (isGuest) {
      joinBody.type = "guest";
    } else {
      joinBody.type = "human";
      joinBody.name = name;
    }

    const res = await fetch(`${serverUrl}/join`, {
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
    sessionToken = String(data.sessionToken ?? "");
    participantId = String(data.participantId);
    roomName = String(data.roomName);
    authority = (data.authority as AuthorityLevel) ?? "participant";
    participants = (data.participants as Array<{ id: string; name: string; type: string; authority?: string }>) ?? [];
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
        body: JSON.stringify({ token: sessionToken }),
      });
    } catch {
      // Server may be down
    }
  };

  // ── Start TUI ───────────────────────────────────────────────────────────

  const isReadOnly = authority === "observer" || isGuest;

  // ── Slash command helper ──────────────────────────────────────────────

  function systemEvent(content: string): void {
    tui.push({
      id: randomUUID(),
      ts: formatTimestamp(new Date()),
      kind: "system",
      content,
    });
  }

  async function handleSlashCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      // ── /who ──────────────────────────────────────────────────────
      case "who": {
        try {
          const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string; type: string; authority?: string }> };
          const lines = data.participants.map((p) => {
            const auth = p.authority ?? "participant";
            return `  ${p.type === "agent" ? "agent" : "human"} ${p.name} (${auth})`;
          });
          systemEvent(`Participants:\n${lines.join("\n")}`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /leave ────────────────────────────────────────────────────
      case "leave": {
        await disconnect();
        tui.stop();
        process.exit(0);
        return;
      }

      // ── /kick <name> (admin only) ─────────────────────────────────
      case "kick": {
        if (authority !== "admin") { systemEvent("Only admins can kick."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /kick <name>"); return; }

        // Look up participant by name
        try {
          const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const kickRes = await fetch(`${serverUrl}/kick`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: sessionToken, participantId: target.id }),
          });
          if (!kickRes.ok) { systemEvent(`Failed to kick: ${await kickRes.text()}`); return; }
          systemEvent(`Kicked ${targetName}.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /mute <name> (admin only) ─────────────────────────────────
      case "mute": {
        if (authority !== "admin") { systemEvent("Only admins can mute."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /mute <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const modeRes = await fetch(`${serverUrl}/set-mode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: sessionToken, participantId: target.id, mode: "standby-everyone" }),
          });
          if (!modeRes.ok) { systemEvent(`Failed to mute: ${await modeRes.text()}`); return; }
          systemEvent(`Muted ${targetName} (standby-everyone).`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /wake <name> (admin only) ─────────────────────────────────
      case "wake": {
        if (authority !== "admin") { systemEvent("Only admins can wake."); return; }
        const targetName = args[0];
        if (!targetName) { systemEvent("Usage: /wake <name>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const modeRes = await fetch(`${serverUrl}/set-mode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: sessionToken, participantId: target.id, mode: "everyone" }),
          });
          if (!modeRes.ok) { systemEvent(`Failed to wake: ${await modeRes.text()}`); return; }
          systemEvent(`Woke ${targetName} (everyone).`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /setmode <name> <mode> (admin only) ───────────────────────
      case "setmode": {
        if (authority !== "admin") { systemEvent("Only admins can set modes."); return; }
        const targetName = args[0];
        const mode = args[1];
        if (!targetName || !mode) { systemEvent("Usage: /setmode <name> <mode>"); return; }

        try {
          const res = await fetch(`${serverUrl}/participants?token=${sessionToken}`);
          if (!res.ok) { systemEvent("Failed to get participant list."); return; }
          const data = (await res.json()) as { participants: Array<{ id: string; name: string }> };
          const target = data.participants.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
          if (!target) { systemEvent(`Participant "${targetName}" not found.`); return; }

          const modeRes = await fetch(`${serverUrl}/set-mode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: sessionToken, participantId: target.id, mode }),
          });
          if (!modeRes.ok) { systemEvent(`Failed to set mode: ${await modeRes.text()}`); return; }
          systemEvent(`Set ${targetName} to ${mode}.`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      // ── /share [--as <tier>] ──────────────────────────────────────
      case "share": {
        if (authority === "observer") { systemEvent("Observers cannot create share links."); return; }

        let targetAuthority: string | undefined;
        if (args[0] === "--as" && args[1]) {
          targetAuthority = args[1];
        }

        try {
          const body: Record<string, unknown> = { token: sessionToken };
          if (targetAuthority) body.authority = targetAuthority;

          const res = await fetch(`${serverUrl}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) { systemEvent(`Failed: ${await res.text()}`); return; }
          const data = (await res.json()) as { links: Record<string, string> };
          const lines = Object.entries(data.links).map(([tier, url]) =>
            `  ${tier}: stoops join ${url}`
          );
          systemEvent(`Share links:\n${lines.join("\n")}`);
        } catch {
          systemEvent("Failed to reach server.");
        }
        return;
      }

      default:
        systemEvent(`Unknown command: /${cmd}`);
    }
  }

  const tui = startTUI({
    roomName,
    serverUrl,
    shareUrl: options.shareUrl,
    readOnly: isReadOnly,
    onSend: isReadOnly ? undefined : async (content: string) => {
      // Intercept slash commands
      if (content.startsWith("/")) {
        await handleSlashCommand(content);
        return;
      }

      try {
        await fetch(`${serverUrl}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: sessionToken, content }),
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
    const res = await fetch(`${serverUrl}/events?token=${sessionToken}`, {
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
