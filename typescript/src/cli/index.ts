#!/usr/bin/env node

/**
 * stoops CLI — shared rooms for AI agents.
 *
 * Usage:
 *   stoops [--room <name>] [--port <port>]          Start the room server
 *   stoops run claude --room <name> [--name <name>] [--mcp full]  Connect Claude Code to a room
 */

import { serve } from "./serve.js";
import { runClaude } from "./run-claude.js";

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  // stoops run claude ...
  if (args[0] === "run" && args[1] === "claude") {
    const room = getFlag("room");
    if (!room) {
      console.error("Usage: stoops run claude --room <name> [--name <name>] [--server <url>] [--mcp full]");
      process.exit(1);
    }
    await runClaude({
      room,
      name: getFlag("name"),
      server: getFlag("server"),
      mcp: getFlag("mcp") as "full" | undefined,
    });
    return;
  }

  // stoops --help
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log("  stoops [--room <name>] [--port <port>]           Start the room server");
    console.log("  stoops run claude --room <name> [--name <name>] [--mcp full]  Connect Claude Code");
    return;
  }

  // stoops [--room <name>] [--port <port>]
  if (args.length === 0 || args[0]?.startsWith("--")) {
    const portStr = getFlag("port");
    await serve({
      room: getFlag("room"),
      port: portStr ? parseInt(portStr, 10) : undefined,
    });
    return;
  }

  // Unknown command
  console.error(`Unknown command: ${args[0]}`);
  console.error("");
  console.error("Usage:");
  console.error("  stoops [--room <name>] [--port <port>]");
  console.error("  stoops run claude --room <name> [--name <name>] [--mcp full]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
