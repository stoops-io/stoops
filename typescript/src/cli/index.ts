#!/usr/bin/env node

/**
 * stoops CLI — shared rooms for AI agents.
 *
 * Usage:
 *   stoops [--room <name>] [--port <port>] [--share]        Host a room + join it
 *   stoops serve [--room <name>] [--port <port>] [--share]  Headless server only
 *   stoops join <url> [--name <name>] [--guest]             Join a room as a human
 *   stoops run claude --join <url> [--name <name>] [--admin]  Connect Claude Code
 */

import { serve } from "./serve.js";
import { join } from "./join.js";
import { runClaude } from "./run-claude.js";
import { buildShareUrl } from "./auth.js";

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

/** Collect all values for a repeatable flag (e.g. --join url1 --join url2). */
function getAllFlags(name: string): string[] {
  const results: string[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("--")) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

async function main(): Promise<void> {
  // stoops run claude --join <url> [--join <url>] [--name <name>] [--admin]
  if (args[0] === "run" && args[1] === "claude") {
    const joinUrls = getAllFlags("join");
    // Backward compat: --room + --server still works
    const room = getFlag("room");
    const server = getFlag("server");
    if (joinUrls.length === 0 && !room) {
      console.error("Usage: stoops run claude --join <url> [--name <name>] [--admin]");
      console.error("       stoops run claude --room <name> [--server <url>]  (legacy)");
      process.exit(1);
    }
    await runClaude({
      joinUrls,
      room,
      name: getFlag("name"),
      server,
      admin: args.includes("--admin"),
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
    console.log("  stoops [--room <name>] [--port <port>] [--share]              Host + join");
    console.log("  stoops serve [--room <name>] [--port <port>] [--share]        Headless server");
    console.log("  stoops join <url> [--name <name>] [--guest]                   Join a room");
    console.log("  stoops run claude --join <url> [--name <name>] [--admin]      Connect Claude Code");
    return;
  }

  // stoops serve [--room <name>] [--port <port>] [--share]
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

    // Host joins locally as admin using the admin share token
    const adminJoinUrl = buildShareUrl(result.serverUrl, result.adminToken);
    const participantShareUrl = buildShareUrl(
      result.publicUrl !== result.serverUrl ? result.publicUrl : result.serverUrl,
      result.participantToken,
    );

    await join({
      server: adminJoinUrl,
      name: getFlag("name"),
      shareUrl: participantShareUrl,
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
  console.error("  stoops run claude --join <url> [--name <name>] [--admin]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
