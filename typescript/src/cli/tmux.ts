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
  execSync(`tmux attach -t ${shellEscape(session)}`, { stdio: "inherit" });
}

/** Kill a tmux session. */
export function tmuxKillSession(session: string): void {
  try {
    execSync(`tmux kill-session -t ${shellEscape(session)}`, { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
}

/** Wait for a process to appear inside a tmux session (polls pane content). */
export async function tmuxWaitForReady(
  session: string,
  marker: string,
  timeoutMs = 15000,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = execSync(
        `tmux capture-pane -t ${shellEscape(session)} -p`,
        { encoding: "utf-8" },
      );
      if (content.includes(marker)) return true;
    } catch {
      // Session may not be ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
