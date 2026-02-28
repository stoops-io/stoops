/**
 * stoops run claude — connect a Claude Code instance to a room.
 *
 * Thin client: registers with the stoops server, launches Claude in tmux
 * with the stoops MCP server configured via --mcp-config (session-scoped,
 * nothing written to ~/.claude.json).
 */

import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
} from "./tmux.js";
import { randomName } from "../core/names.js";

export interface RunClaudeOptions {
  room: string;
  name?: string;
  server?: string;
}

export async function runClaude(options: RunClaudeOptions): Promise<void> {
  const serverUrl = options.server ?? "http://127.0.0.1:7890";
  const agentName = options.name ?? randomName();

  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  // ── Register with server ────────────────────────────────────────────────

  console.log(`Connecting to ${options.room}...`);

  let agentId: string;
  let mcpUrl: string;

  try {
    const res = await fetch(`${serverUrl}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: options.room, name: agentName }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Failed to join room: ${err}`);
      process.exit(1);
    }

    const data = await res.json() as Record<string, unknown>;
    if (typeof data.agentId !== "string" || typeof data.mcpUrl !== "string") {
      console.error("Invalid response from server: missing agentId or mcpUrl");
      process.exit(1);
    }
    agentId = data.agentId;
    mcpUrl = data.mcpUrl;
  } catch (err) {
    console.error(`Cannot reach stoops server at ${serverUrl}. Is it running?`);
    process.exit(1);
  }

  console.log(`  Joined as ${agentName} (${agentId})`);

  // ── Create tmux session ─────────────────────────────────────────────────

  const tmuxSession = `stoops_${options.room}_${agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  // Build --mcp-config JSON — session-scoped, never saved to ~/.claude.json
  const mcpConfig = JSON.stringify({
    mcpServers: { stoops: { type: "http", url: mcpUrl } },
  });

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession);
  tmuxSendCommand(tmuxSession, `claude --mcp-config '${mcpConfig}'`);

  // ── Tell server about our tmux session ──────────────────────────────────

  try {
    await fetch(`${serverUrl}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, tmuxSession }),
    });
  } catch {
    console.error("Failed to notify server about tmux session.");
    await cleanup(serverUrl, agentId, tmuxSession);
    process.exit(1);
  }

  // ── Wait for Claude Code to be ready, then attach ───────────────────────

  await new Promise((r) => setTimeout(r, 2000));

  console.log("Attaching to Claude Code session...\n");

  try {
    tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  await cleanup(serverUrl, agentId, tmuxSession);
  console.log("Disconnected.");
}

async function cleanup(serverUrl: string, agentId: string, tmuxSession: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
  } catch {
    // Server may be down
  }

  tmuxKillSession(tmuxSession);
}
