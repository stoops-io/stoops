/**
 * tmux helpers for stoops CLI.
 *
 * Thin wrappers around tmux commands. Used by the server process to
 * inject room events into Claude Code sessions.
 */

import { execFileSync, spawn } from "node:child_process";

/** Sanitize a string for use as a tmux session name. Replaces tmux-special chars. */
function sanitizeSessionName(name: string): string {
  return name.replace(/[.:$%]/g, "_");
}

/** Check if tmux is installed and available. */
export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists. */
export function tmuxSessionExists(session: string): boolean {
  try {
    const name = sanitizeSessionName(session);
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Create a detached tmux session with no status bar. */
export function tmuxCreateSession(session: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["new-session", "-d", "-s", name]);
  execFileSync("tmux", ["set", "-t", name, "status", "off"]);
}

/** Send a command to a tmux session (types it + presses Enter). */
export function tmuxSendCommand(session: string, command: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "-l", command]);
  execFileSync("tmux", ["send-keys", "-t", name, "Enter"]);
}

/**
 * Inject text into a tmux session (literal keys, no Enter).
 * Used for room event injection.
 */
export function tmuxInjectText(session: string, text: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "-l", text]);
}

/** Send Enter key to a tmux session (submits input). */
export function tmuxSendEnter(session: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, "Enter"]);
}

/** Attach to a tmux session. Returns a promise that resolves when detached/exited.
 *
 * Two modes:
 *  - Outside tmux: `tmux attach` (blocks until user detaches, event loop stays free via spawn)
 *  - Inside tmux:  `tmux switch-client` (exits immediately) + polls until session ends
 */
export function tmuxAttach(session: string): Promise<void> {
  const name = sanitizeSessionName(session);

  if (process.env.TMUX) {
    // switch-client exits immediately after switching — poll until session is destroyed
    try {
      execFileSync("tmux", ["switch-client", "-t", name], { stdio: "ignore" });
    } catch {
      // switch-client failed (e.g. no client) — fall through to polling
    }
    return new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        try {
          execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
        } catch {
          clearInterval(poll);
          resolve();
        }
      }, 500);
    });
  }

  return new Promise<void>((resolve) => {
    const child = spawn("tmux", ["attach", "-t", name], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/** Capture visible screen content as array of lines. */
export function tmuxCapturePane(session: string): string[] {
  try {
    const name = sanitizeSessionName(session);
    const output = execFileSync("tmux", ["capture-pane", "-t", name, "-p"], {
      encoding: "utf-8",
    });
    return output.split("\n");
  } catch {
    return [];
  }
}

/**
 * Send a control key sequence (e.g. "C-u", "C-y", "Escape").
 * Unlike tmuxInjectText, this does NOT use -l, so tmux interprets
 * the key name rather than treating it as literal text.
 */
export function tmuxSendKey(session: string, key: string): void {
  const name = sanitizeSessionName(session);
  execFileSync("tmux", ["send-keys", "-t", name, key]);
}

/** Kill a tmux session. */
export function tmuxKillSession(session: string): void {
  try {
    const name = sanitizeSessionName(session);
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
}
