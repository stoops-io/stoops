/**
 * TmuxBridge — state-aware event injection into Claude Code.
 *
 * Reads the Claude Code TUI screen via `tmux capture-pane`, detects the
 * current UI state, and applies the right injection strategy:
 *
 *   idle       → inject directly
 *   typing     → Ctrl+U (cut), inject, Ctrl+Y (restore)
 *   dialog     → queue and poll
 *   permission → queue and poll
 *   streaming  → queue and poll
 *   unknown    → queue and poll (safe default)
 *
 * Events that can't be injected immediately are queued and drained
 * when the state becomes safe.
 */

import {
  tmuxCapturePane,
  tmuxInjectText,
  tmuxSendEnter,
  tmuxSendKey,
} from "../tmux.js";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";

export type TuiState =
  | "idle"
  | "typing"
  | "dialog"
  | "permission"
  | "streaming"
  | "unknown";

// Spinner characters used by Claude Code during streaming
const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Patterns that indicate a selection/question dialog
const DIALOG_PATTERNS = [
  "Enter to select",
  "to navigate",
  "Esc to cancel",
  "Ready to code?",
  "Review your answers",
  "ctrl+g to edit in",
];

// Patterns that indicate a permission/confirmation prompt
const PERMISSION_PATTERNS = [
  "(Y)",
  "Allow ",
  "Deny ",
  "approve",
  "Yes / No",
];

export interface TmuxBridgeOptions {
  /** How often to poll when events are queued (ms). Default: 200 */
  pollIntervalMs?: number;
  /** How long to wait between Ctrl+U/inject/Ctrl+Y steps (ms). Default: 50 */
  keystrokeDelayMs?: number;
}

export class TmuxBridge {
  private session: string;
  private queue: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private keystrokeDelayMs: number;
  private stopped = false;

  constructor(session: string, opts?: TmuxBridgeOptions) {
    this.session = session;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 200;
    this.keystrokeDelayMs = opts?.keystrokeDelayMs ?? 50;
  }

  /**
   * Delivery callback — drop-in replacement for the raw tmuxDeliver lambda.
   * Pass `bridge.deliver.bind(bridge)` to EventProcessor.run().
   */
  async deliver(parts: ContentPart[]): Promise<void> {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    this.inject(text);
  }

  /**
   * Detect the current TUI state by reading the screen.
   * Exported for testing — the heuristic logic is in detectStateFromLines().
   */
  detectState(): TuiState {
    const lines = this.captureScreen();
    return detectStateFromLines(lines);
  }

  /**
   * Try to inject text, choosing strategy based on TUI state.
   * If the state is unsafe, queues the text and starts polling.
   *
   * Text is flattened to a single line before injection to avoid triggering
   * Claude Code's paste detection. When multi-line text arrives via
   * `send-keys -l`, Claude Code detects it as a paste and collapses it into
   * "[Pasted text #1 +N lines]" which may not reliably submit with Enter.
   */
  private inject(text: string): void {
    const flat = text.replace(/\n/g, " ");
    const state = this.detectState();

    switch (state) {
      case "idle":
        this.injectIdle(flat);
        break;
      case "typing":
        this.injectWhileTyping(flat);
        break;
      default:
        // dialog, permission, streaming, unknown — queue it
        this.enqueue(flat);
        break;
    }
  }

  /** Capture the screen via tmux capture-pane. */
  private captureScreen(): string[] {
    return tmuxCapturePane(this.session);
  }

  /**
   * Inject into an idle prompt: type text + Enter.
   * Sends a second Enter after a short delay as a safety net — if Claude Code's
   * paste detection swallowed the first Enter, the second one submits. If the
   * first Enter worked, Claude is streaming and the second Enter is a no-op.
   */
  private injectIdle(text: string): void {
    tmuxInjectText(this.session, text);
    tmuxSendEnter(this.session);
    this.sleep(80);
    tmuxSendEnter(this.session);
  }

  /**
   * Inject while the user is typing:
   * 1. Ctrl+U — cut line to kill ring
   * 2. Inject our text + Enter
   * 3. Ctrl+Y — paste the user's text back
   */
  private injectWhileTyping(text: string): void {
    // Cut user's current input
    tmuxSendKey(this.session, "C-u");
    this.sleep(this.keystrokeDelayMs);

    // Inject our event (double-Enter for paste detection resilience)
    tmuxInjectText(this.session, text);
    tmuxSendEnter(this.session);
    this.sleep(80);
    tmuxSendEnter(this.session);
    this.sleep(this.keystrokeDelayMs);

    // Restore user's text
    tmuxSendKey(this.session, "C-y");
  }

  /** Add to queue and start polling if not already. */
  private enqueue(text: string): void {
    this.queue.push(text);
    this.startPolling();
  }

  /** Start the polling timer to drain queued events. */
  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => this.drainQueue(), this.pollIntervalMs);
  }

  /** Stop the polling timer. */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Try to drain one queued event if the state is safe.
   *
   * Drains one event at a time rather than batching all into one multi-line
   * string — multi-line text triggers Claude Code's paste detection which
   * collapses it into "[Pasted text #1 +N lines]".
   *
   * After injecting one event, the poll continues. The next cycle re-checks
   * state: if Claude is busy (streaming), remaining events wait. If idle,
   * the next event is injected. Events are already flattened in inject().
   */
  private drainQueue(): void {
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }

    const state = this.detectState();
    if (state === "idle" || state === "typing") {
      const text = this.queue.shift()!;

      if (state === "idle") {
        this.injectIdle(text);
      } else {
        this.injectWhileTyping(text);
      }

      if (this.queue.length === 0) {
        this.stopPolling();
      }
      // else: keep polling to drain remaining events
    }
    // else: still blocked, keep polling
  }

  /** Cleanup. */
  stop(): void {
    this.stopped = true;
    this.stopPolling();
    this.queue.length = 0;
  }

  /** Synchronous sleep — only used for tiny keystroke delays. */
  private sleep(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// ── State detection heuristics ──────────────────────────────────────────────

/**
 * Detect TUI state from capture-pane output lines.
 * Exported separately so it can be unit-tested without tmux.
 *
 * Claude Code's TUI layout (v2.1+):
 *   ────────────────────────
 *   ❯ <user input here>
 *   ────────────────────────
 *   PR #2         /ide ...
 *
 * The ❯ prompt sits between separator lines (─). No ❯❯ footer in v2.1+.
 */
export function detectStateFromLines(lines: string[]): TuiState {
  if (lines.length === 0) return "unknown";

  // Work with the last ~15 lines (the visible bottom of the screen)
  const tail = lines.slice(-15);
  const tailText = tail.join("\n");

  // 1. Dialog: selection/question/plan approval
  for (const pattern of DIALOG_PATTERNS) {
    if (tailText.includes(pattern)) return "dialog";
  }

  // 2. Permission prompt
  for (const pattern of PERMISSION_PATTERNS) {
    if (tailText.includes(pattern)) return "permission";
  }

  // 3. Streaming: spinner characters in the last few lines
  const lastFew = tail.slice(-5).join("");
  for (const ch of SPINNER_CHARS) {
    if (lastFew.includes(ch)) return "streaming";
  }

  // 4. Look for the ❯/› prompt line near the bottom.
  //    Supports both old layout (❯❯ footer) and new layout (separator lines).
  const promptChar = /^[❯›](\s|$)/;
  const footerChar = /^[❯›]{2}\s/;
  const separatorLine = /^[─━─\-]{10,}/;

  // Strategy A: old layout — find ❯❯ footer then ❯ prompt above it
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trimStart();
    if (footerChar.test(line)) {
      // Found old-style footer, look for prompt above
      for (let j = i - 1; j >= 0; j--) {
        const above = tail[j].trimStart();
        if (promptChar.test(above)) {
          const content = above.replace(/^[❯›]\s*/, "").trim();
          return content.length === 0 ? "idle" : "typing";
        }
      }
      break;
    }
  }

  // Strategy B: new layout — find ❯ prompt between/near separator lines
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trimStart();
    if (promptChar.test(line)) {
      // Verify it's Claude's prompt by checking for separator line nearby
      const above = i > 0 ? tail[i - 1].trimStart() : "";
      const below = i < tail.length - 1 ? tail[i + 1].trimStart() : "";
      if (separatorLine.test(above) || separatorLine.test(below)) {
        const content = line.replace(/^[❯›]\s*/, "").trim();
        return content.length === 0 ? "idle" : "typing";
      }
    }
  }

  return "unknown";
}
