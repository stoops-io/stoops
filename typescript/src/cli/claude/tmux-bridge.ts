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

    const wrapped = `<room-event>\n${text}\n</room-event>`;
    this.inject(wrapped);
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
   */
  private inject(text: string): void {
    const state = this.detectState();

    switch (state) {
      case "idle":
        this.injectIdle(text);
        break;
      case "typing":
        this.injectWhileTyping(text);
        break;
      default:
        // dialog, permission, streaming, unknown — queue it
        this.enqueue(text);
        break;
    }
  }

  /** Capture the screen via tmux capture-pane. */
  private captureScreen(): string[] {
    return tmuxCapturePane(this.session);
  }

  /** Inject into an idle prompt: type text + Enter. */
  private injectIdle(text: string): void {
    tmuxInjectText(this.session, text);
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

    // Inject our event
    tmuxInjectText(this.session, text);
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

  /** Try to drain all queued events if the state is safe. */
  private drainQueue(): void {
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }

    const state = this.detectState();
    if (state === "idle" || state === "typing") {
      // Batch all queued events into one injection
      const batch = this.queue.splice(0);
      const combined = batch.join("\n");

      if (state === "idle") {
        this.injectIdle(combined);
      } else {
        this.injectWhileTyping(combined);
      }

      this.stopPolling();
    }
    // else: still blocked, keep polling
  }

  /**
   * Wait for Claude Code to be ready (prompt visible).
   * Replaces the hardcoded 2-second delay.
   */
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    const pollMs = 500;

    while (Date.now() - start < timeoutMs) {
      const state = this.detectState();
      if (state === "idle") return;

      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Timeout — fall through and hope for the best (same as the old 2s delay)
    console.warn("Warning: Claude Code readiness timeout — proceeding anyway.");
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

  // 4. Look for the prompt line (❯ or ›) and footer (❯❯)
  //    Work backwards from the bottom to find these
  const promptChar = /^[❯›](\s|$)/;
  const footerChar = /^[❯›]{2}\s/;

  let hasFooter = false;
  let promptLine: string | null = null;

  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trimStart();

    if (!hasFooter && footerChar.test(line)) {
      hasFooter = true;
      continue;
    }

    if (hasFooter && promptChar.test(line)) {
      promptLine = line;
      break;
    }
  }

  if (promptLine !== null) {
    // Strip the prompt character and check if there's content
    const content = promptLine.replace(/^[❯›]\s*/, "").trim();
    if (content.length === 0) return "idle";
    return "typing";
  }

  return "unknown";
}
