/** Tests for TmuxBridge state detection heuristics. */

import { describe, test, expect } from "vitest";
import { detectStateFromLines, type TuiState } from "../src/cli/claude/tmux-bridge.js";

/** Helper: split a template string into lines (trims leading blank line). */
function screen(s: string): string[] {
  const lines = s.split("\n");
  if (lines[0]?.trim() === "") lines.shift();
  return lines;
}

describe("detectStateFromLines", () => {
  // ── Idle ────────────────────────────────────────────────────────────────

  test("detects idle state: old layout with ❯❯ footer", () => {
    const lines = screen(`
  some previous output here

❯

❯❯ accept edits on (shift+tab to cycle) · PR #2
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });

  test("detects idle state: old layout, prompt with only whitespace", () => {
    const lines = screen(`
❯

❯❯ accept edits on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });

  test("detects idle with › prompt character variant (old layout)", () => {
    const lines = screen(`
some output

›

›› accept edits on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });

  test("detects idle state: new layout with separator lines", () => {
    const lines = screen(`
╰──────────────────────────────────────────────────────────────────────────────╯

 ⚠Large CLAUDE.md

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  PR #2                                            /ide for Visual Studio Code
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });

  test("detects idle: new layout with placeholder text is still idle", () => {
    // Claude shows "Try ..." as placeholder, but prompt is empty (no user input)
    const lines = screen(`
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  PR #2
`);
    expect(detectStateFromLines(lines)).toBe("idle");
  });

  // ── Typing ──────────────────────────────────────────────────────────────

  test("detects typing state: old layout", () => {
    const lines = screen(`
  previous output

❯ hello world

❯❯ accept edits on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).toBe("typing");
  });

  test("detects typing state: old layout, partial text", () => {
    const lines = screen(`
❯ fix the b

❯❯ accept edits on (shift+tab to cycle)
`);
    expect(detectStateFromLines(lines)).toBe("typing");
  });

  test("detects typing state: new layout with separator lines", () => {
    const lines = screen(`
────────────────────────────────────────────────────────────────────────────────
❯ hello world
────────────────────────────────────────────────────────────────────────────────
  PR #2                                            /ide for Visual Studio Code
`);
    expect(detectStateFromLines(lines)).toBe("typing");
  });

  // ── Dialog ──────────────────────────────────────────────────────────────

  test("detects dialog: single-select question", () => {
    const lines = screen(`
Is this thing working?

› 1. Yes
    It works
  2. No
    It doesn't work
  3. Type something.

  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  test("detects dialog: multi-select question", () => {
    const lines = screen(`
Which features?

› 1. [ ] Option A
  2. [ ] Option B
  3. [ ] Option C

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  test("detects dialog: plan approval", () => {
    const lines = screen(`
Ready to code?

Here is Claude's plan:

› 1. Yes, clear context (38% used) and auto-accept edits
  2. Yes, auto-accept edits
  3. Yes, manually approve edits
  4. Type here to tell Claude what to change

ctrl+g to edit in VS Code · ~/.claude/plans/my-plan.md
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  test("detects dialog: review/submit confirmation", () => {
    const lines = screen(`
Review your answers

⚠ You have not answered all questions
Ready to submit your answers?
› 1. Submit answers
  2. Cancel
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  test("detects dialog: Esc to cancel alone is enough", () => {
    const lines = screen(`
Some prompt with options
Esc to cancel
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  // ── Permission ──────────────────────────────────────────────────────────

  test("detects permission: (Y) pattern", () => {
    const lines = screen(`
  Claude wants to run: rm -rf /

  (Y)es  (N)o
`);
    expect(detectStateFromLines(lines)).toBe("permission");
  });

  test("detects permission: Allow pattern", () => {
    const lines = screen(`
  Allow Claude to edit file.ts?

  Allow   Deny
`);
    expect(detectStateFromLines(lines)).toBe("permission");
  });

  // ── Streaming ───────────────────────────────────────────────────────────

  test("detects streaming: spinner character in last lines", () => {
    const lines = screen(`
  Working on your request...

  ⠹ Thinking...
`);
    expect(detectStateFromLines(lines)).toBe("streaming");
  });

  test("detects streaming: different spinner character", () => {
    const lines = screen(`
  ⠼ Processing...
`);
    expect(detectStateFromLines(lines)).toBe("streaming");
  });

  // ── Unknown ─────────────────────────────────────────────────────────────

  test("returns unknown for empty screen", () => {
    expect(detectStateFromLines([])).toBe("unknown");
  });

  test("returns unknown for unrecognized content", () => {
    const lines = screen(`
  some random terminal output
  that doesn't match any pattern
  no prompt, no dialog, no spinner
`);
    expect(detectStateFromLines(lines)).toBe("unknown");
  });

  test("returns unknown when ❯ has no separator or footer", () => {
    const lines = screen(`
❯ some text
but no separator or footer line
`);
    expect(detectStateFromLines(lines)).toBe("unknown");
  });

  // ── Priority ────────────────────────────────────────────────────────────

  test("dialog takes priority over prompt detection", () => {
    const lines = screen(`
❯ some text

❯❯ accept edits on

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(detectStateFromLines(lines)).toBe("dialog");
  });

  test("permission takes priority over prompt detection", () => {
    const lines = screen(`
❯

❯❯ accept edits on

  Allow this action?
`);
    expect(detectStateFromLines(lines)).toBe("permission");
  });

  test("streaming takes priority over idle", () => {
    const lines = screen(`
❯

❯❯ accept edits on

⠋ Generating...
`);
    // Spinner detected in last 5 lines → streaming
    expect(detectStateFromLines(lines)).toBe("streaming");
  });
});
