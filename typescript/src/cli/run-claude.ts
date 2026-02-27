/**
 * stoops run claude — connect a Claude Code instance to a room.
 *
 * Thin client: registers with the stoops server, sets up MCP in Claude Code,
 * creates a tmux session, and blocks until the user exits.
 */

import { execSync, execFileSync } from "node:child_process";
import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
} from "./tmux.js";

export interface RunClaudeOptions {
  room: string;
  name?: string;
  server?: string;
}

export async function runClaude(options: RunClaudeOptions): Promise<void> {
  const serverUrl = options.server ?? "http://127.0.0.1:7890";
  const agentName = options.name ?? `claude-${Date.now().toString(36).slice(-4)}`;

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

  // ── Add MCP server to Claude Code ───────────────────────────────────────

  const mcpName = `stoops_${options.room}_${agentName}`;

  console.log("Adding MCP server...");
  try {
    execFileSync("claude", ["mcp", "add", "--transport", "http", "--scope", "user", mcpName, mcpUrl], { stdio: "ignore" });
  } catch (err) {
    console.error("Failed to add MCP server to Claude Code. Is `claude` installed?");
    await disconnect(serverUrl, agentId);
    process.exit(1);
  }

  // ── Create tmux session ─────────────────────────────────────────────────

  const tmuxSession = `stoops_${options.room}_${agentName}`;

  // Clean up stale session if it exists
  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession);
  tmuxSendCommand(tmuxSession, "claude");

  // ── Tell server about our tmux session ──────────────────────────────────

  try {
    await fetch(`${serverUrl}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, tmuxSession }),
    });
  } catch {
    console.error("Failed to notify server about tmux session.");
    await cleanup(serverUrl, agentId, mcpName, tmuxSession);
    process.exit(1);
  }

  // ── Wait for Claude Code to be ready, then attach ───────────────────────

  // Give Claude Code a moment to start up
  await new Promise((r) => setTimeout(r, 2000));

  console.log("Attaching to Claude Code session...\n");

  try {
    tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  await cleanup(serverUrl, agentId, mcpName, tmuxSession);
  console.log("Disconnected.");
}

async function disconnect(serverUrl: string, agentId: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
  } catch {
    // Server may be down
  }
}

async function cleanup(
  serverUrl: string,
  agentId: string,
  mcpName: string,
  tmuxSession: string,
): Promise<void> {
  // Disconnect from server
  await disconnect(serverUrl, agentId);

  // Remove MCP server from Claude Code config
  try {
    execFileSync("claude", ["mcp", "remove", mcpName], { stdio: "ignore" });
  } catch {
    // May already be removed
  }

  // Kill tmux session
  tmuxKillSession(tmuxSession);
}
