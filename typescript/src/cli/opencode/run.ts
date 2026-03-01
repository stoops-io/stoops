/**
 * stoops run opencode — client-side agent runtime for OpenCode.
 *
 * Spawns `opencode serve` with OPENCODE_CONFIG_CONTENT to inject the stoops
 * MCP server. The user opens OpenCode's UI, starts a conversation, and tells
 * the agent to join a room URL.
 *
 * Session detection: we subscribe to OpenCode's global SSE event stream and
 * watch for stoops tool call events. Each event carries the sessionID of the
 * calling session — no guessing, no race conditions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";
import { setupAgentRuntime, type AgentRuntimeOptions } from "../runtime-setup.js";

export { type AgentRuntimeOptions as RunOpencodeOptions };

export async function runOpencode(options: AgentRuntimeOptions): Promise<void> {
  // ── Pick a port for OpenCode ────────────────────────────────────────────

  const opencodePort = 14096 + Math.floor(Math.random() * 1000);
  const opencodeUrl = `http://127.0.0.1:${opencodePort}`;

  // ── Room → OpenCode session mapping ────────────────────────────────────
  //
  // Each OpenCode session can join different rooms. Lazily detected on first
  // delivery for each room by inspecting session messages for stoops tool calls.

  const roomSessions = new Map<string, string>();   // roomId → OpenCode sessionId

  /** Find the OpenCode session that most recently called a stoops tool. */
  async function findStoopsSession(): Promise<string | null> {
    try {
      const res = await fetch(`${opencodeUrl}/session`);
      if (!res.ok) return null;
      // Sessions sorted by time.updated desc — first is most recent
      const sessions = await res.json() as Array<{ id: string; time: { updated: number } }>;

      // Check the most recently updated sessions for stoops tool parts
      for (const sess of sessions.slice(0, 3)) {
        const msgRes = await fetch(`${opencodeUrl}/session/${sess.id}/message`);
        if (!msgRes.ok) continue;
        const messages = await msgRes.json() as Array<{
          parts?: Array<{ type?: string; tool?: string }>;
        }>;
        for (const msg of messages) {
          for (const part of msg.parts ?? []) {
            if (part.type === "tool" && part.tool?.includes("stoops__")) {
              return sess.id;
            }
          }
        }
      }
      // Fallback: most recently updated session
      return sessions.length > 0 ? sessions[0].id : null;
    } catch {
      return null;
    }
  }

  // ── Shared runtime setup ────────────────────────────────────────────────
  // No --join URLs — the user tells the agent to join from within OpenCode.

  const setup = await setupAgentRuntime({
    ...options,
    joinUrls: undefined,
  });

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

  // ── Build deliver callback ──────────────────────────────────────────────
  //
  // OpenCode's POST /session/:id/message uses Hono stream() — headers (200)
  // arrive immediately but the LLM runs inside the stream callback. We MUST
  // consume the response body (await res.text()) to block until the LLM
  // finishes, preserving the EventProcessor's _processing lock.

  async function deliver(parts: ContentPart[]): Promise<void> {
    const roomId = setup.processor.currentContextRoomId;
    if (!roomId) return;

    // Lazy session detection: look up on first delivery for this room
    if (!roomSessions.has(roomId)) {
      const sid = await findStoopsSession();
      if (!sid) return;
      roomSessions.set(roomId, sid);
      console.log(`  Linked room ${roomId} → session ${sid}`);
    }
    const targetSession = roomSessions.get(roomId)!;

    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    try {
      const res = await fetch(`${opencodeUrl}/session/${targetSession}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      });
      await res.text();
    } catch {
      // OpenCode may have exited
    }
  }

  // ── Start the event loop ────────────────────────────────────────────────
  // No initialParts — the user drives the conversation from OpenCode's UI.

  const eventLoopPromise = setup.processor.run(deliver, setup.wrappedSource);

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
