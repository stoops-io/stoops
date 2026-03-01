/**
 * stoops run opencode — client-side agent runtime for OpenCode.
 *
 * Uses the shared runtime setup (join servers, SSE, EventProcessor, MCP)
 * then adds OpenCode-specific pieces: spawns `opencode serve` with
 * OPENCODE_CONFIG_CONTENT env to inject the stoops MCP server, creates
 * a session, and delivers events via POST /session/:id/message.
 *
 * No tmux. Pure HTTP API integration.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";

export { type AgentRuntimeOptions as RunOpencodeOptions };

export async function runOpencode(options: AgentRuntimeOptions): Promise<void> {
  // ── Shared runtime setup ────────────────────────────────────────────────

  const setup = await setupAgentRuntime(options);

  // ── Pick a port for OpenCode ────────────────────────────────────────────

  const opencodePort = 14096 + Math.floor(Math.random() * 1000);
  const opencodeUrl = `http://127.0.0.1:${opencodePort}`;

  // ── Build MCP config for OpenCode ───────────────────────────────────────

  const opencodeConfig = {
    mcp: {
      stoops: {
        type: "remote",
        url: setup.mcpServer.url,
        oauth: false,
      },
    },
  };

  // ── Spawn OpenCode in headless mode ─────────────────────────────────────

  const extraArgs = options.extraArgs ?? [];
  const opencodeArgs = ["serve", "--port", String(opencodePort), ...extraArgs];

  console.log("Launching OpenCode...");

  let child: ChildProcess;
  try {
    child = spawn("opencode", opencodeArgs, {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error("Error: opencode is required but not found. Install it from https://opencode.ai");
    await setup.cleanup();
    process.exit(1);
  }

  // Forward stderr to console for visibility
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let childExited = false;
  child.on("exit", () => { childExited = true; });

  child.on("error", async () => {
    console.error("Error: failed to start opencode. Is it installed?");
    await setup.cleanup();
    process.exit(1);
  });

  // ── Wait for OpenCode to be ready ───────────────────────────────────────

  const ready = await pollForReady(opencodeUrl, 30_000);
  if (!ready) {
    console.error("OpenCode did not become ready within 30 seconds.");
    child.kill();
    await setup.cleanup();
    process.exit(1);
  }

  console.log(`  OpenCode running on ${opencodeUrl}`);

  // ── Create a session ────────────────────────────────────────────────────

  let sessionId: string;
  try {
    const res = await fetch(`${opencodeUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      console.error(`Failed to create OpenCode session: ${await res.text()}`);
      child.kill();
      await setup.cleanup();
      process.exit(1);
    }
    const data = await res.json() as Record<string, unknown>;
    sessionId = String(data.id ?? (data as any).data?.id ?? "");
    if (!sessionId) {
      // Try nested response format
      const nested = (data as any).data;
      if (nested?.id) sessionId = String(nested.id);
    }
    if (!sessionId) {
      console.error("Failed to get session ID from OpenCode.");
      child.kill();
      await setup.cleanup();
      process.exit(1);
    }
    console.log(`  Session: ${sessionId}`);
  } catch (err) {
    console.error(`Failed to create OpenCode session: ${err}`);
    child.kill();
    await setup.cleanup();
    process.exit(1);
  }

  // ── Build deliver callback ──────────────────────────────────────────────

  async function deliver(parts: ContentPart[]): Promise<void> {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    try {
      const res = await fetch(`${opencodeUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      });
      if (!res.ok) {
        // Non-fatal — log and continue
        console.error(`  [stoops] delivery failed: ${res.status} ${await res.text()}`);
      }
    } catch {
      // OpenCode may have exited
    }
  }

  // ── Start the event loop ────────────────────────────────────────────────

  const eventLoopPromise = setup.processor.run(deliver, setup.wrappedSource, setup.initialParts);

  console.log(`\n  OpenCode agent running.`);
  console.log(`  To watch: opencode attach ${opencodeUrl}\n`);

  // ── Block until child exits or Ctrl+C ───────────────────────────────────

  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", resolve);
  });

  const signalPromise = new Promise<void>((resolve) => {
    const handler = () => { resolve(); };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });

  await Promise.race([exitPromise, signalPromise]);

  // ── Cleanup ─────────────────────────────────────────────────────────────

  if (!childExited) {
    child.kill();
  }
  await setup.cleanup();

  console.log("Disconnected.");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function pollForReady(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/session/status`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
