/**
 * stoops run claude — client-side agent runtime for Claude Code.
 *
 * Uses the shared runtime setup (join servers, SSE, EventProcessor, MCP)
 * then adds Claude-specific pieces: tmux session + TmuxBridge delivery.
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  tmuxAvailable,
  tmuxCreateSession,
  tmuxSendCommand,
  tmuxAttach,
  tmuxKillSession,
  tmuxSessionExists,
} from "../tmux.js";
import { TmuxBridge } from "./tmux-bridge.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";

export { type AgentRuntimeOptions as RunClaudeOptions };

export async function runClaude(options: AgentRuntimeOptions): Promise<void> {
  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  // ── Shared runtime setup ────────────────────────────────────────────────

  const setup = await setupAgentRuntime(options);

  // ── Write MCP config file ───────────────────────────────────────────────

  const tmpDir = mkdtempSync(join(tmpdir(), "stoops_agent_"));
  const mcpConfigPath = join(tmpDir, "mcp.json");

  const mcpConfig = {
    mcpServers: {
      stoops: {
        type: "http",
        url: setup.mcpServer.url,
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // ── Create tmux session + launch Claude Code ────────────────────────────

  const tmuxSession = `stoops_${setup.agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  console.log("Launching Claude Code...");
  tmuxCreateSession(tmuxSession);

  // Launch claude with MCP config + any passthrough args
  const extraArgs = options.extraArgs ?? [];
  const claudeCmd = [`claude --mcp-config ${mcpConfigPath}`, ...extraArgs].join(" ");
  tmuxSendCommand(tmuxSession, claudeCmd);

  // ── Create TmuxBridge for state-aware event injection ───────────────────

  const bridge = new TmuxBridge(tmuxSession);

  // Start the event loop in the background — events queue until Claude is idle
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource, setup.initialParts);

  // ── Brief pause for Claude to start, then attach immediately ────────────
  // No need to gate on state detection — TmuxBridge queues events until
  // Claude is ready. The user sees Claude start up naturally.

  await new Promise((r) => setTimeout(r, 2_000));

  console.log("Attaching to Claude Code session...\n");

  try {
    tmuxAttach(tmuxSession);
  } catch {
    // User detached or session ended
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  bridge.stop();
  await setup.cleanup();
  tmuxKillSession(tmuxSession);
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }

  console.log("Disconnected.");
}
