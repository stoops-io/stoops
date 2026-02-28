#!/usr/bin/env node

/**
 * stoops CLI — shared rooms for AI agents.
 *
 * Usage:
 *   stoops [--room <name>] [--port <port>] [--share]    Host a room + join it
 *   stoops serve [--room <name>] [--port <port>] [--share]  Headless server only
 *   stoops join <url> [--name <name>] [--guest]         Join a room as a human
 *   stoops run claude --room <name> [--name <name>]     Connect Claude Code to a room
 */

import { serve } from "./serve.js";
import { join } from "./join.js";
import { runClaude } from "./run-claude.js";

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

async function main(): Promise<void> {
  // stoops run claude ...
  if (args[0] === "run" && args[1] === "claude") {
    const room = getFlag("room");
    if (!room) {
      console.error("Usage: stoops run claude --room <name> [--name <name>] [--server <url>]");
      process.exit(1);
    }
    await runClaude({
      room,
      name: getFlag("name"),
      server: getFlag("server"),
    });
    return;
  }

  // stoops join <url> [--name <name>] [--guest]
  if (args[0] === "join") {
    const server = args[1];
    if (!server || server.startsWith("--")) {
      console.error("Usage: stoops join <url> [--name <name>] [--guest]");
      process.exit(1);
    }
    await join({
      server,
      name: getFlag("name"),
      guest: args.includes("--guest"),
    });
    return;
  }

  // stoops --help
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log("  stoops [--room <name>] [--port <port>] [--share]          Host + join");
    console.log("  stoops serve [--room <name>] [--port <port>] [--share]    Headless server");
    console.log("  stoops join <url> [--name <name>] [--guest]               Join a room");
    console.log("  stoops run claude --room <name> [--name <name>]           Connect Claude Code");
    return;
  }

  // stoops serve [--room <name>] [--port <port>] [--share]  — headless server only
  if (args[0] === "serve") {
    const portStr = getFlag("port");
    await serve({
      room: getFlag("room"),
      port: portStr ? parseInt(portStr, 10) : undefined,
      share: args.includes("--share"),
    });
    return;
  }

  // stoops [--room <name>] [--port <port>] [--share]  — host + join
  if (args.length === 0 || args[0]?.startsWith("--")) {
    const portStr = getFlag("port");
    const result = await serve({
      room: getFlag("room"),
      port: portStr ? parseInt(portStr, 10) : undefined,
      share: args.includes("--share"),
      quiet: true,
    });

    // Server is ready — join it locally (tunnel is for other people)
    await join({
      server: result.serverUrl,
      name: getFlag("name"),
      shareUrl: result.publicUrl !== result.serverUrl ? result.publicUrl : undefined,
    });
    return;
  }

  // Unknown command
  console.error(`Unknown command: ${args[0]}`);
  console.error("");
  console.error("Usage:");
  console.error("  stoops [--room <name>] [--port <port>] [--share]");
  console.error("  stoops serve [--room <name>] [--port <port>] [--share]");
  console.error("  stoops join <url> [--name <name>] [--guest]");
  console.error("  stoops run claude --room <name> [--name <name>]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
