/** Tests for CodexTmuxBridge state detection heuristics. */

import { describe, test, expect } from "vitest";
import { detectCodexStateFromLines, type CodexTuiState } from "../src/cli/codex/tmux-bridge.js";

/** Helper: split a template string into lines (trims leading blank line). */
function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

describe("detectCodexStateFromLines", () => {
  // ── Approval ────────────────────────────────────────────────────────────

  test("detects approval: exec command approval", () => {
    const lines = screen(`
  Would you like to run the following command?

    npm test

  y  Yes, proceed
  a  Yes, and don't ask again for this command in this session
  d  No, continue without running it
  n  No, and tell Codex what to do differently

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: patch approval", () => {
    const lines = screen(`
  Would you like to make the following edits?

  src/index.ts
  + import { foo } from "./foo.js";

  y  Yes, proceed
  a  Yes, and don't ask again for these files
  n  No, and tell Codex what to do differently

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: MCP elicitation", () => {
    const lines = screen(`
  stoops needs your approval.

  The MCP server is requesting access to perform an action.

  y  Yes, provide the requested info
  n  No, but continue without it

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: network access", () => {
    const lines = screen(`
  Do you want to approve network access to "api.example.com"?

  y  Yes, just this once
  p  Yes, and allow this host in the future
  d  No, and block this host in the future

  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("detects approval: confirm/cancel footer alone is enough", () => {
    const lines = screen(`
  Some approval prompt
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  // ── Streaming ──────────────────────────────────────────────────────────

  test("detects streaming: Working with elapsed time", () => {
    const lines = screen(`
  Previous conversation output here...

  Working (12s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: Working with minutes", () => {
    const lines = screen(`
  Working (1m 30s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: Working just started (no elapsed)", () => {
    const lines = screen(`
  Some output
  Working
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: spinner character", () => {
    const lines = screen(`
  ⠹ Thinking about the problem...
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: different spinner character", () => {
    const lines = screen(`
  Some context
  ⠼ Processing files...
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: esc to interrupt hint", () => {
    const lines = screen(`
  Reading files and analyzing code...
  (5s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  // ── Idle ───────────────────────────────────────────────────────────────

  test("detects idle: normal screen with conversation", () => {
    const lines = screen(`
  Agent: I've fixed the bug in src/utils.ts.

  The changes look correct. Let me know if you need anything else.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  test("detects idle: screen with just prompt area", () => {
    const lines = screen(`
  Welcome to Codex! Type a message to get started.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  test("detects idle: screen after agent completes a task", () => {
    const lines = screen(`
  ✓ Created file src/cli/codex/run.ts
  ✓ Updated src/cli/index.ts

  Done. 2 files modified.
`);
    expect(detectCodexStateFromLines(lines)).toBe("idle");
  });

  // ── Unknown ────────────────────────────────────────────────────────────

  test("returns unknown for empty screen", () => {
    expect(detectCodexStateFromLines([])).toBe("unknown");
  });

  test("returns unknown for blank lines only", () => {
    const lines = screen(`



`);
    // All lines are empty/whitespace
    expect(detectCodexStateFromLines(lines.filter(l => l.trim() === "" ? true : false) as any)).toBe("unknown");
  });

  // ── Priority ───────────────────────────────────────────────────────────

  test("approval takes priority over idle", () => {
    const lines = screen(`
  Agent completed some work.
  Output from previous task.

  Would you like to run the following command?
    rm -rf node_modules
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });

  test("streaming takes priority over idle", () => {
    const lines = screen(`
  Previous output
  Some conversation text
  Working (3s * esc to interrupt)
`);
    expect(detectCodexStateFromLines(lines)).toBe("streaming");
  });

  test("approval takes priority over streaming indicators", () => {
    // Edge case: approval text present alongside streaming-like content
    const lines = screen(`
  Working on the task...
  Would you like to run the following command?
    npm install
  Press Enter to confirm or Esc to cancel
`);
    expect(detectCodexStateFromLines(lines)).toBe("approval");
  });
});
