/**
 * stoops run codex — client-side agent runtime for OpenAI Codex CLI.
 *
 * Uses the shared runtime setup (EventProcessor, MCP server)
 * then adds Codex-specific pieces: tmux session + CodexTmuxBridge delivery.
 *
 * Codex connects to the runtime MCP server natively via config.toml
 * (no stdio bridge needed — Codex supports remote MCP servers via URL).
 * The agent joins rooms by calling join_room() — no auto-injection needed.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { CodexTmuxBridge } from "./tmux-bridge.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";
import { contentPartsToString } from "../../agent/prompts.js";

export { type AgentRuntimeOptions as RunCodexOptions };

/** Check if codex CLI is installed and available. */
function codexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function runCodex(options: AgentRuntimeOptions): Promise<void> {
  // ── Headless mode — skip tmux, deliver events as plain text to stdout ────

  if (options.headless) {
    const setup = await setupAgentRuntime(options);

    const deliver = async (parts: Parameters<typeof contentPartsToString>[0]) => {
      const text = contentPartsToString(parts);
      if (text.trim()) process.stdout.write(text + "\n");
    };

    const eventLoopPromise = setup.processor
      .run(deliver, setup.wrappedSource, setup.initialParts)
      .catch(() => {});

    process.stderr.write(`MCP server: ${setup.mcpServer.url}\n`);

    await new Promise<void>((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });

    await setup.cleanup();
    await eventLoopPromise;
    return;
  }

  // ── Preflight checks ────────────────────────────────────────────────────

  if (!tmuxAvailable()) {
    console.error("Error: tmux is required but not found. Install it with: brew install tmux");
    process.exit(1);
  }

  if (!codexAvailable()) {
    console.error("Error: codex is required but not found. Install it with: npm install -g @openai/codex");
    process.exit(1);
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // Don't pass joinUrls — Codex agents join rooms manually via join_room()

  const setup = await setupAgentRuntime({ ...options, joinUrls: undefined });

  // ── Write MCP config for Codex ──────────────────────────────────────────
  // Codex supports remote MCP servers natively via url in config.toml.
  // No stdio bridge needed (unlike Claude Code which has an OAuth bug).

  const tmpDir = mkdtempSync(join(tmpdir(), "stoops_codex_"));

  const mcpPort = new URL(setup.mcpServer.url).port;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  // Write config.toml in a .codex directory structure
  const codexConfigDir = join(tmpDir, ".codex");
  mkdirSync(codexConfigDir, { recursive: true });

  const configToml = [
    "[mcp_servers.stoops]",
    `url = "${mcpUrl}"`,
    `startup_timeout_sec = 15`,
    `tool_timeout_sec = 60`,
  ].join("\n");

  writeFileSync(join(codexConfigDir, "config.toml"), configToml);

  // ── Create tmux session + launch Codex ──────────────────────────────────

  const tmuxSession = `stoops_${setup.agentName}`;

  if (tmuxSessionExists(tmuxSession)) {
    tmuxKillSession(tmuxSession);
  }

  console.log("Launching Codex...");
  tmuxCreateSession(tmuxSession);

  // Launch codex with config dir pointing to our temp directory + passthrough args
  const extraArgs = options.extraArgs ?? [];
  const codexCmd = [`CODEX_HOME=${codexConfigDir} codex`, ...extraArgs].join(" ");
  tmuxSendCommand(tmuxSession, codexCmd);

  // ── Start event loop + attach ──────────────────────────────────────────

  const bridge = new CodexTmuxBridge(tmuxSession);

  // Start the event loop in the background — no initial injection.
  // The agent joins rooms by calling join_room() when the user tells it to.
  const eventLoopPromise = setup.processor.run(bridge.deliver.bind(bridge), setup.wrappedSource)
    .catch(() => {}); // Prevent unhandled rejection from crashing the process

  // Wait for Codex to start, checking the session is still alive
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!tmuxSessionExists(tmuxSession)) {
      console.error("Error: Codex exited during startup. Try running again.");
      bridge.stop();
      await setup.cleanup();
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
      return;
    }
  }

  console.log("Attaching to Codex session...\n");

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
