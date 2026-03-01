#!/usr/bin/env node

/**
 * stoops CLI — shared rooms for AI agents.
 *
 * Usage:
 *   stoops [--room <name>] [--port <port>] [--share]                         Host a room + join it
 *   stoops serve [--room <name>] [--port <port>] [--share]                   Headless server only
 *   stoops join <url> [--name <name>] [--guest]                              Join a room as a human
 *   stoops run claude --join <url> [--name <name>] [--admin] [-- <args>]     Connect Claude Code
 *   stoops run opencode --join <url> [--name <name>] [--admin] [-- <args>]   Connect OpenCode
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

async function main(): Promise<void> {
  // stoops run <runtime> --join <url> [--invite <url>] [--name <name>] [--admin] [-- <extra-args>]
  if (args[0] === "run" && (args[1] === "claude" || args[1] === "opencode")) {
    const runtime = args[1];
    const restArgs = args.slice(2);

    // Split on -- separator: stoops flags before, passthrough args after
    const ddIndex = restArgs.indexOf("--");
    const stoopsArgs = ddIndex >= 0 ? restArgs.slice(0, ddIndex) : restArgs;
    const extraArgs = ddIndex >= 0 ? restArgs.slice(ddIndex + 1) : [];

    const joinUrls = getAllFlags("join", stoopsArgs);
    const room = getFlag("room", stoopsArgs);
    const server = getFlag("server", stoopsArgs);

    if (joinUrls.length === 0 && !room) {
      console.error(`Usage: stoops run ${runtime} --join <url> [--name <name>] [--admin] [-- <${runtime}-args>]`);
      process.exit(1);
    }

    const runtimeOptions = {
      joinUrls,
      room,
      name: getFlag("name", stoopsArgs),
      server,
      admin: stoopsArgs.includes("--admin"),
      extraArgs,
    };

    if (runtime === "claude") {
      await runClaude(runtimeOptions);
    } else {
      await runOpencode(runtimeOptions);
    }
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
    console.log("  stoops [--room <name>] [--port <port>] [--share]                         Host + join");
    console.log("  stoops serve [--room <name>] [--port <port>] [--share]                   Headless server");
    console.log("  stoops join <url> [--name <name>] [--guest]                              Join a room");
    console.log("  stoops run claude --join <url> [--name <name>] [--admin] [-- <args>]     Connect Claude Code");
    console.log("  stoops run opencode --join <url> [--name <name>] [--admin] [-- <args>]   Connect OpenCode");
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
  console.error("  stoops run claude --join <url> [--name <name>] [--admin] [-- <args>]");
  console.error("  stoops run opencode --join <url> [--name <name>] [--admin] [-- <args>]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
