/**
 * stoops run claude — client-side agent runtime for Claude Code.
 *
 * Uses the shared runtime setup (EventProcessor, MCP server)
 * then adds Claude-specific pieces: tmux session + TmuxBridge delivery.
 *
 * Claude Code connects to the runtime MCP server via a stdio bridge
 * (Claude's HTTP MCP transport requires OAuth, which hangs on localhost).
 * The agent joins rooms by calling join_room() — no auto-injection needed.
 */

import { writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
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

/**
 * Stdio-to-HTTP bridge script. Written to a temp file and spawned by Claude Code
 * as an MCP stdio server. Proxies JSON-RPC messages to the runtime HTTP MCP server.
 *
 * The HTTP MCP server returns SSE-formatted responses (event: message\ndata: {...}).
 * The bridge extracts the JSON from data: lines and writes raw JSON-RPC to stdout.
 */
// CommonJS (.cjs) for minimal startup latency — ESM requires module parsing which
// can exceed Claude Code's MCP handshake timeout on first run.
const MCP_STDIO_BRIDGE = [
  '#!/usr/bin/env node',
  '"use strict";',
  'const { createInterface } = require("readline");',
  'const url = `http://127.0.0.1:${process.argv[2]}/mcp`;',
  'const rl = createInterface({ input: process.stdin });',
  '(async () => {',
  '  for await (const line of rl) {',
  '    if (!line.trim()) continue;',
  '    try {',
  '      const res = await fetch(url, {',
  '        method: "POST",',
  '        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },',
  '        body: line,',
  '      });',
  '      if (res.status === 202) continue;',
  '      const body = await res.text();',
  '      for (const bl of body.split("\\n")) {',
  '        const m = bl.match(/^data: (.+)/);',
  '        if (m) process.stdout.write(m[1] + "\\n");',
  '      }',
  '    } catch {',
  '      process.exit(1);',
  '    }',
  '  }',
  '})();',
].join('\n');

export async function runClaude(options: AgentRuntimeOptions): Promise<void> {
  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // Don't pass joinUrls — Claude Code agents join rooms manually via join_room()

  const setup = await setupAgentRuntime({ ...options, joinUrls: undefined });

  // ── Write MCP stdio bridge + config ────────────────────────────────────

  const tmpDir = mkdtempSync(join(tmpdir(), "stoops_agent_"));

  const bridgePath = join(tmpDir, "mcp-bridge.cjs");
  writeFileSync(bridgePath, MCP_STDIO_BRIDGE);
  chmodSync(bridgePath, 0o755);

  const mcpPort = new URL(setup.mcpServer.url).port;
  const mcpConfigPath = join(tmpDir, "mcp.json");

  // Use process.execPath (absolute path to Node) so the bridge works regardless
  // of whether `node` is in the tmux session's PATH.
  const mcpConfig = {
    mcpServers: {
      stoops: {
        type: "stdio",
        command: process.execPath,
        args: [bridgePath, mcpPort],
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

  // ── Start event loop + attach ──────────────────────────────────────────

  const bridge = new TmuxBridge(tmuxSession);

  // Start the event loop in the background — no initial injection.
  // The agent joins rooms by calling join_room() when the user tells it to.
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource)
    .catch(() => {}); // Prevent unhandled rejection from crashing the process

  // Wait for Claude to start, checking the session is still alive
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!tmuxSessionExists(tmuxSession)) {
      console.error("Error: Claude Code exited during startup. Try running again.");
      bridge.stop();
      await setup.cleanup();
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
      return;
    }
  }

  console.log("Attaching to Claude Code session...\n");

  try {
    await tmuxAttach(tmuxSession);
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
