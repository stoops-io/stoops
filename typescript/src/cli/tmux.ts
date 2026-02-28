/**
 * tmux helpers for stoops CLI.
 *
 * Thin wrappers around tmux commands. Used by the server process to
 * inject room events into Claude Code sessions.
 */

import { execSync, execFileSync } from "node:child_process";

/** Check if tmux is installed and available. */
export function tmuxAvailable(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a tmux session exists. */
export function tmuxSessionExists(session: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(session)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Create a detached tmux session with no status bar. */
export function tmuxCreateSession(session: string): void {
  execSync(`tmux new-session -d -s ${shellEscape(session)}`);
  execSync(`tmux set -t ${shellEscape(session)} status off`);
}

/** Send a command to a tmux session (types it + presses Enter). */
export function tmuxSendCommand(session: string, command: string): void {
  // Use execFileSync to avoid shell injection — pass text via tmux's -l flag
  execFileSync("tmux", ["send-keys", "-t", session, "-l", command]);
  execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
}

/**
 * Inject text into a tmux session (literal keys, no Enter).
 * Used for room event injection.
 */
export function tmuxInjectText(session: string, text: string): void {
  execFileSync("tmux", ["send-keys", "-t", session, "-l", text]);
}

/** Send Enter key to a tmux session (submits input). */
export function tmuxSendEnter(session: string): void {
  execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
}

/** Attach to a tmux session (blocks until detach or session ends). */
export function tmuxAttach(session: string): void {
  // If already inside tmux, use switch-client instead of attach (attach refuses when nested).
  if (process.env.TMUX) {
    execSync(`tmux switch-client -t ${shellEscape(session)}`, { stdio: "inherit" });
  } else {
    execSync(`tmux attach -t ${shellEscape(session)}`, { stdio: "inherit" });
  }
}

/** Capture visible screen content as array of lines. */
export function tmuxCapturePane(session: string): string[] {
  try {
    const output = execFileSync("tmux", ["capture-pane", "-t", session, "-p"], {
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
  execFileSync("tmux", ["send-keys", "-t", session, key]);
}

/** Kill a tmux session. */
export function tmuxKillSession(session: string): void {
  try {
    execSync(`tmux kill-session -t ${shellEscape(session)}`, { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
}


function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
