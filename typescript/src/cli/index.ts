#!/usr/bin/env node

/**
 * stoops CLI — shared rooms for AI agents.
 *
 * Usage:
 *   stoops [--room <name>] [--port <port>] [--share]                         Host a room + join it
 *   stoops serve [--room <name>] [--port <port>] [--share]                   Headless server only
 *   stoops join <url> [--name <name>] [--guest]                              Join a room as a human
 *   stoops run claude [--name <name>] [--admin] [-- <args>]                Connect Claude Code
 *   stoops run opencode [--name <name>] [--admin] [-- <args>]                Connect OpenCode
 */

import { serve } from "./serve.js";
import { join } from "./join.js";
import { runClaude } from "./claude/run.js";
import { runOpencode } from "./opencode/run.js";
import { buildShareUrl } from "./auth.js";

const args = process.argv.slice(2);

function getFlag(name: string, arr: string[] = args): string | undefined {
  const idx = arr.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = arr[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

/** Collect all values for a repeatable flag (e.g. --join url1 --join url2). */
function getAllFlags(name: string, arr: string[] = args): string[] {
  const results: string[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith("--")) {
      results.push(arr[i + 1]);
    }
  }
  return results;
}

function printUsage(stream: typeof console.log = console.log): void {
  stream("Usage:");
  stream("  stoops [--room <name>] [--port <port>] [--share]                         Host + join");
  stream("  stoops serve [--room <name>] [--port <port>] [--share]                   Headless server");
  stream("  stoops join <url> [--name <name>] [--guest]                              Join a room");
  stream("  stoops run claude [--name <name>] [--admin] [-- <args>]                  Connect Claude Code");
  stream("  stoops run opencode [--name <name>] [--admin] [-- <args>]                Connect OpenCode");
}

async function main(): Promise<void> {
  // ── --help anywhere ────────────────────────────────────────────────────
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  // ── stoops run <runtime> ───────────────────────────────────────────────
  if (args[0] === "run" && (args[1] === "claude" || args[1] === "opencode")) {
    const runtime = args[1];
    const restArgs = args.slice(2);

    // Split on -- separator: stoops flags before, passthrough args after
    const ddIndex = restArgs.indexOf("--");
    const stoopsArgs = ddIndex >= 0 ? restArgs.slice(0, ddIndex) : restArgs;
    const extraArgs = ddIndex >= 0 ? restArgs.slice(ddIndex + 1) : [];

    const joinUrls = getAllFlags("join", stoopsArgs);

    const runtimeOptions = {
      joinUrls: joinUrls.length > 0 ? joinUrls : undefined,
      name: getFlag("name", stoopsArgs),
      admin: stoopsArgs.includes("--admin"),
      headless: stoopsArgs.includes("--headless"),
      extraArgs,
    };

    if (runtime === "claude") {
      await runClaude(runtimeOptions);
    } else {
      await runOpencode(runtimeOptions);
    }
    return;
  }

  // ── stoops join <url> ──────────────────────────────────────────────────
  if (args[0] === "join") {
    const server = args[1];
    if (!server || server.startsWith("--")) {
      console.error("Usage: stoops join <url> [--name <name>] [--guest] [--headless]");
      process.exit(1);
    }
    await join({
      server,
      name: getFlag("name"),
      guest: args.includes("--guest"),
      headless: args.includes("--headless"),
    });
    return;
  }

  // ── stoops serve ───────────────────────────────────────────────────────
  if (args[0] === "serve") {
    const portStr = getFlag("port");
    await serve({
      room: getFlag("room"),
      port: portStr ? parseInt(portStr, 10) : undefined,
      share: args.includes("--share"),
      headless: args.includes("--headless"),
    });
    return;
  }

  // ── stoops (bare) — host + join ────────────────────────────────────────
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

  // ── Unknown command ────────────────────────────────────────────────────
  console.error(`Unknown command: ${args[0]}\n`);
  printUsage(console.error);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
