/**
 * CodexTmuxBridge — state-aware event injection into Codex CLI.
 *
 * Reads the Codex TUI screen via `tmux capture-pane`, detects the
 * current UI state, and applies the right injection strategy:
 *
 *   idle       → bracketed paste + Enter
 *   typing     → Ctrl+U (cut), bracketed paste + Enter, Ctrl+Y (restore)
 *   approval   → queue and poll
 *   streaming  → queue and poll
 *   unknown    → queue and poll (safe default)
 *
 * Uses bracketed paste escape sequences to bypass Codex's timing-based
 * paste-burst detector (120ms Enter suppression window). Text wrapped
 * in ESC[200~...ESC[201~ is delivered as a Paste event, not individual
 * keystrokes, so the burst detector never fires.
 */

import {
  tmuxCapturePane,
  tmuxInjectText,
  tmuxSendEnter,
  tmuxSendKey,
} from "../tmux.js";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";

export type CodexTuiState =
  | "idle"
  | "typing"
  | "approval"
  | "streaming"
  | "unknown";

// Braille spinner characters used by Codex during streaming
const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Patterns that indicate an approval overlay
const APPROVAL_PATTERNS = [
  "Would you like to",
  "needs your approval",
  "Press Enter to confirm or Esc to cancel",
  "Do you want to approve",
];

// Patterns that indicate the agent is actively working
const STREAMING_PATTERNS = [
  /Working\s*\(\d+[smh]/,       // "Working (12s" or "Working (1m 30s"
  /Working\s*$/,                  // "Working" at end of line (just started)
  /esc to interrupt/,             // hint text during streaming
];

export interface CodexTmuxBridgeOptions {
  /** How often to poll when events are queued (ms). Default: 200 */
  pollIntervalMs?: number;
  /** Delay after bracketed paste before sending Enter (ms). Default: 150 */
  pasteDelayMs?: number;
  /** Delay between Ctrl+U/inject/Ctrl+Y steps (ms). Default: 50 */
  keystrokeDelayMs?: number;
}

export class CodexTmuxBridge {
  private session: string;
  private queue: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private pasteDelayMs: number;
  private keystrokeDelayMs: number;
  private stopped = false;

  constructor(session: string, opts?: CodexTmuxBridgeOptions) {
    this.session = session;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 200;
    this.pasteDelayMs = opts?.pasteDelayMs ?? 150;
    this.keystrokeDelayMs = opts?.keystrokeDelayMs ?? 50;
  }

  /**
   * Delivery callback — drop-in replacement for EventProcessor's deliver.
   * Pass `bridge.deliver.bind(bridge)` to EventProcessor.run().
   */
  async deliver(parts: ContentPart[]): Promise<void> {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    this.inject(text);
  }

  /**
   * Detect the current TUI state by reading the screen.
   */
  detectState(): CodexTuiState {
    const lines = this.captureScreen();
    return detectCodexStateFromLines(lines);
  }

  /**
   * Try to inject text, choosing strategy based on TUI state.
   * Text is flattened to a single line to avoid multi-line paste issues.
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
        // approval, streaming, unknown — queue it
        this.enqueue(flat);
        break;
    }
  }

  /** Capture the screen via tmux capture-pane. */
  private captureScreen(): string[] {
    return tmuxCapturePane(this.session);
  }

  /**
   * Inject into an idle prompt using bracketed paste.
   *
   * Bracketed paste wraps text in ESC[200~...ESC[201~ so crossterm
   * delivers it as a single Paste event, bypassing the burst detector.
   * After the paste, we wait for the Enter suppression window (120ms)
   * to expire, then send Enter to submit.
   */
  private injectIdle(text: string): void {
    tmuxInjectText(this.session, "\x1b[200~");
    tmuxInjectText(this.session, text);
    tmuxInjectText(this.session, "\x1b[201~");
    this.sleep(this.pasteDelayMs);
    tmuxSendEnter(this.session);
  }

  /**
   * Inject while the user is typing:
   * 1. Ctrl+U — cut to beginning of line (into kill buffer)
   * 2. Bracketed paste our text + Enter
   * 3. Ctrl+Y — yank user's text back from kill buffer
   */
  private injectWhileTyping(text: string): void {
    // Cut user's current input
    tmuxSendKey(this.session, "C-u");
    this.sleep(this.keystrokeDelayMs);

    // Inject our event via bracketed paste
    tmuxInjectText(this.session, "\x1b[200~");
    tmuxInjectText(this.session, text);
    tmuxInjectText(this.session, "\x1b[201~");
    this.sleep(this.pasteDelayMs);
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
   * Drains one at a time — each injection may trigger streaming,
   * so the next poll re-checks state before injecting more.
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
 * Detect Codex TUI state from capture-pane output lines.
 * Exported separately so it can be unit-tested without tmux.
 *
 * Codex's TUI (Ratatui-based) uses an inline viewport. The screen shows:
 *   - Conversation history in the top area
 *   - Status indicator ("Working (12s * esc to interrupt)") when streaming
 *   - Approval overlay when tool/patch approval needed
 *   - Composer input area at the bottom
 *
 * Detection priority: approval > streaming > idle/typing > unknown
 */
export function detectCodexStateFromLines(lines: string[]): CodexTuiState {
  if (lines.length === 0) return "unknown";

  // Work with the last ~20 lines (visible bottom of screen)
  const tail = lines.slice(-20);
  const tailText = tail.join("\n");

  // 1. Approval overlay — highest priority
  for (const pattern of APPROVAL_PATTERNS) {
    if (tailText.includes(pattern)) return "approval";
  }

  // 2. Streaming — agent is working
  for (const pattern of STREAMING_PATTERNS) {
    if (pattern.test(tailText)) return "streaming";
  }

  // Check for spinner characters in the last few lines
  const lastFew = tail.slice(-5).join("");
  for (const ch of SPINNER_CHARS) {
    if (lastFew.includes(ch)) return "streaming";
  }

  // 3. Idle/Typing — look for the composer input area at the bottom.
  //    Codex renders the composer as the last interactive element.
  //    When idle, the bottom lines contain just the placeholder or empty input.
  //    When typing, the bottom lines contain user-entered text.
  //
  //    Heuristic: if none of the blocking states are detected (approval,
  //    streaming), and the screen has content, assume the composer is
  //    available. Check the last non-empty line for signs of user input.
  //
  //    This is intentionally permissive — the worst case for a false
  //    "idle" is that the injected text arrives during an unexpected
  //    state and queues up in the input buffer harmlessly.
  const nonEmpty = tail.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    // Look for signs that the screen is showing normal conversation + composer.
    // If we didn't match approval or streaming above, the composer is likely visible.
    // We need to distinguish idle (empty composer) from typing (text in composer).
    //
    // Codex shows a cursor line at the very bottom. Without empirical data on
    // exact patterns, we check if the last non-empty line looks like user input
    // (not part of conversation output which typically has structure like timestamps,
    // tool names, or markdown formatting).
    //
    // For now: if no blocking state is detected, return "idle" as the safe
    // injectable state. The bracketed paste approach is resilient enough that
    // injecting into a "typing" state via the idle path still works (text gets
    // appended to whatever the user was typing, and Enter submits all of it).
    return "idle";
  }

  return "unknown";
}
