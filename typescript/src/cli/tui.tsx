/**
 * stoops TUI — ink-based terminal UI for the room server.
 *
 * Uses ink's <Static> for events (rendered once, selectable terminal text)
 * and a dynamic footer for input + status. Same architecture as Claude Code.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { render, Box, Text, Static, useStdout, useInput } from "ink";

// ── Palette (from stoops-app) ─────────────────────────────────────────────────

const C = {
  cyan:      "#00d4ff",
  purple:    "#8b5cf6",
  orange:    "#ff8c42",
  pink:      "#f472b6",
  green:     "#34d399",
  yellow:    "#fbbf24",
  danger:    "#f87171",
  text:      "#eceff4",
  secondary: "#b0b7c4",
  dim:       "#7e8798",
  muted:     "#5b6679",
  border:    "#475264",
} as const;

const AGENT_COLORS = [C.cyan, C.purple, C.orange, C.pink, C.green, C.yellow] as const;
const SIGILS       = ["◆", "▲", "●", "■", "★", "◉", "◈", "▸"] as const;

// ── Banner ───────────────────────────────────────────────────────────────────
// Figlet "slant" font, colored with a purple → cyan gradient per line.

const BANNER_LINES = [
  "         __                        ",
  "   _____/ /_____  ____  ____  _____",
  "  / ___/ __/ __ \\/ __ \\/ __ \\/ ___/",
  " (__  ) /_/ /_/ / /_/ / /_/ (__  ) ",
  "/____/\\__/\\____/\\____/ .___/____/  ",
  "                    /_/            ",
];

const GRADIENT = ["#9b6dff", "#7c8bff", "#5da8ff", "#3dc4ff", "#1ddcff", "#00e8ff"];

// ── Slash commands ────────────────────────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
  adminOnly?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/who",     description: "List participants" },
  { name: "/leave",   description: "Disconnect and exit" },
  { name: "/share",   description: "Generate share links" },
  { name: "/kick",    description: "Remove a participant", adminOnly: true },
  { name: "/mute",    description: "Mute a participant", adminOnly: true },
  { name: "/wake",    description: "Wake a participant", adminOnly: true },
  { name: "/setmode", description: "Set engagement mode", adminOnly: true },
];

const CMD_COL = 12; // fixed width for command name column

// ── Types ─────────────────────────────────────────────────────────────────────

export type DisplayEvent =
  | { id: string; ts: string; kind: "message"; senderName: string; senderType: "human" | "agent"; isSelf: boolean; content: string; replyToName?: string }
  | { id: string; ts: string; kind: "join";    name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "leave";   name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "mode";    mode: string }
  | { id: string; ts: string; kind: "system";  content: string };

export interface TUIHandle {
  push(event: DisplayEvent): void;
  setAgentNames(names: string[]): void;
  stop(): void;
}

export interface TUIOptions {
  roomName: string;
  onSend?(content: string): void;
  onCtrlC?(): void;
  readOnly?: boolean;
  isAdmin?: boolean;
}

// ── Identity (seed → color + sigil) ──────────────────────────────────────────

function seedHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeIdentityAssigner(): (name: string) => { color: string; sigil: string } {
  const map = new Map<string, { color: string; sigil: string }>();
  let colorIdx = 0;
  return (name: string) => {
    if (!map.has(name)) {
      const h = seedHash(name);
      map.set(name, {
        color: AGENT_COLORS[colorIdx++ % AGENT_COLORS.length],
        sigil: SIGILS[h % SIGILS.length],
      });
    }
    return map.get(name)!;
  };
}

// ── Event line ────────────────────────────────────────────────────────────────

const NAME_COL = 12;

function EventLine({
  event,
  identify,
}: {
  event: DisplayEvent;
  identify: (n: string) => { color: string; sigil: string };
}) {
  const ts = <Text color={C.muted}>{event.ts}{"  "}</Text>;

  // ── Message ──
  if (event.kind === "message") {
    const { color, sigil } = identify(event.senderName);
    const isSelf     = event.isSelf;
    const nameColor  = isSelf ? C.text : event.senderType === "agent" ? color : C.secondary;
    const sigilColor = isSelf ? C.dim  : event.senderType === "agent" ? color : C.dim;
    const sigilChar  = isSelf ? "›" : event.senderType === "agent" ? sigil : "·";
    const contentColor = isSelf ? C.text : C.secondary;

    return (
      <Box paddingX={1}>
        <Box flexShrink={0}>
          {ts}
          <Text color={sigilColor}>{sigilChar}{" "}</Text>
          <Text color={nameColor} bold={isSelf}>
            {event.senderName.slice(0, NAME_COL).padEnd(NAME_COL)}
          </Text>
          <Text>{"  "}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">
            {event.replyToName && <Text color={C.dim}>{"→ "}{event.replyToName}{" "}</Text>}
            <Text color={contentColor}>{event.content}</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Join ──
  if (event.kind === "join") {
    const isAgent = event.participantType === "agent";
    const { color, sigil } = isAgent ? identify(event.name) : { color: C.dim, sigil: "·" };
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={isAgent ? color : C.dim}>{sigil}{" "}</Text>
        <Text color={isAgent ? color : C.dim}>{event.name}</Text>
        <Text color={C.green}>{" joined"}</Text>
      </Box>
    );
  }

  // ── Leave ──
  if (event.kind === "leave") {
    const isAgent = event.participantType === "agent";
    const { color: nameColor } = isAgent ? identify(event.name) : { color: C.muted };
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.muted}>{"· "}</Text>
        <Text color={nameColor}>{event.name}</Text>
        <Text color={C.danger}>{" left"}</Text>
      </Box>
    );
  }

  // ── Mode change ──
  if (event.kind === "mode") {
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.dim}>{"mode → "}</Text>
        <Text color={C.yellow} bold>{event.mode}</Text>
      </Box>
    );
  }

  // ── System message (slash command output) ──
  if (event.kind === "system") {
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.dim}>{"  "}</Text>
        <Text color={C.secondary}>{event.content}</Text>
      </Box>
    );
  }

  return null;
}

// ── Internal bridge ───────────────────────────────────────────────────────────

interface AppHandle {
  push: (event: DisplayEvent) => void;
  setAgentNames: (names: string[]) => void;
}

// ── App ───────────────────────────────────────────────────────────────────────

type StaticEntry = { id: string; event?: DisplayEvent };

function App({
  roomName,
  onSend,
  onCtrlC,
  onReady,
  readOnly,
  isAdmin,
}: {
  roomName: string;
  onSend?: (content: string) => void;
  onCtrlC?: () => void;
  onReady: (handle: AppHandle) => void;
  readOnly?: boolean;
  isAdmin?: boolean;
}) {
  const [events,        setEvents]        = useState<DisplayEvent[]>([]);
  const [agentNames,    setAgentNames]    = useState<string[]>([]);
  const [input,         setInput]         = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdout } = useStdout();
  const identify   = useMemo(makeIdentityAssigner, []);

  const push = useCallback((event: DisplayEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  useEffect(() => {
    onReady({ push, setAgentNames });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Note: no resize handler — Ink's <Static> items are already committed to the
  // terminal buffer. Forcing a re-render on resize causes cursor position
  // miscalculation and screen corruption. The divider width updates naturally
  // on the next state change (new event, input change, etc.).

  // ── Slash command suggestions ──────────────────────────────────────────────

  // Only the command prefix (before first space) drives suggestions
  const cmdPrefix = input.startsWith("/") && !input.includes(" ") ? input.toLowerCase() : null;

  const suggestions = useMemo(() => {
    if (!cmdPrefix) return [];
    return SLASH_COMMANDS.filter((cmd) => {
      if (cmd.adminOnly && !isAdmin) return false;
      return cmd.name.startsWith(cmdPrefix);
    });
  }, [cmdPrefix, isAdmin]);

  // Reset selection when the filter changes
  useEffect(() => { setSelectedIndex(0); }, [cmdPrefix]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // Single useInput handles everything — no TextInput, no dual-handler conflicts.

  useInput((char, key) => {
    if (key.ctrl && char === "c") { onCtrlC?.(); return; }
    if (readOnly || !onSend) return;

    // Suggestion navigation
    if (suggestions.length > 0) {
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.return || key.tab) {
        const picked = suggestions[selectedIndex];
        if (picked) setInput(picked.name + " ");
        return;
      }
      if (key.escape) {
        setInput("");
        return;
      }
    }

    // Option+Enter → newline
    if (key.return && key.meta) {
      setInput((prev) => prev + "\n");
      return;
    }

    // Enter → submit
    if (key.return) {
      const content = input.trim();
      if (content) onSend(content);
      setInput("");
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    // Ignore special keys
    if (key.ctrl || key.meta || key.escape || key.tab ||
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      return;
    }

    // Regular character
    if (char) {
      setInput((prev) => prev + char);
    }
  });

  const cols = stdout.columns ?? 80;

  // Static items: banner (rendered once) + events (appended over time)
  const entries: StaticEntry[] = useMemo(
    () => [{ id: "__banner__" }, ...events.map((e) => ({ id: e.id, event: e }))],
    [events],
  );

  return (
    <>
      {/* Permanent output — rendered once, selectable terminal text */}
      <Static items={entries}>
        {(entry) => {
          if (!entry.event) {
            return (
              <Box key={entry.id} flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={1}>
                {BANNER_LINES.map((line, i) => (
                  <Text key={i} color={GRADIENT[i]}>{line}</Text>
                ))}
                <Text>{" "}</Text>
                <Text>
                  <Text color={C.dim}>{"  room  "}</Text>
                  <Text color={C.cyan} bold>{roomName}</Text>
                </Text>
              </Box>
            );
          }
          return <EventLine key={entry.id} event={entry.event} identify={identify} />;
        }}
      </Static>

      {/* Dynamic footer — only this area repaints */}
      <Box paddingX={1}>
        <Text color={C.purple}>{"─"}</Text>
        <Text color={C.border}>{"─".repeat(Math.max(0, cols - 4))}</Text>
        <Text color={C.cyan}>{"─"}</Text>
      </Box>
      {agentNames.length > 0 && (
        <Box paddingX={1}>
          {agentNames.map((name, i) => {
            const { color, sigil } = identify(name);
            return (
              <React.Fragment key={name}>
                {i > 0 && <Text color={C.border}>{"  ·  "}</Text>}
                <Text color={color}>{sigil}{" "}{name}</Text>
              </React.Fragment>
            );
          })}
        </Box>
      )}
      {readOnly || !onSend ? (
        <Box paddingX={1}>
          <Text color={C.muted}>{"  watching as guest"}</Text>
        </Box>
      ) : (
        <Box paddingX={1} flexDirection="column">
          {/* Render each line; first line gets the prompt, rest get indentation */}
          {(input || "").split("\n").map((line, i, arr) => (
            <Box key={i}>
              <Text color={C.cyan} bold>{i === 0 ? "› " : "  "}</Text>
              <Text>
                {line}
                {i === arr.length - 1 && <Text inverse>{" "}</Text>}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {/* Slash command suggestions — below input */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {suggestions.map((cmd, i) => {
            const selected = i === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={selected ? C.cyan : C.muted}>{selected ? "* " : "  "}</Text>
                <Text color={selected ? C.cyan : C.secondary} bold={selected}>
                  {cmd.name.padEnd(CMD_COL)}
                </Text>
                <Text color={C.dim}>{cmd.description}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </>
  );
}

// ── startTUI ──────────────────────────────────────────────────────────────────

export function startTUI(opts: TUIOptions): TUIHandle {
  let handle: AppHandle | null = null;
  const queue: DisplayEvent[] = [];

  const onReady = (h: AppHandle) => {
    handle = h;
    for (const event of queue.splice(0)) h.push(event);
  };

  const { unmount } = render(
    <App
      roomName={opts.roomName}
      onSend={opts.onSend}
      onCtrlC={opts.onCtrlC}
      onReady={onReady}
      readOnly={opts.readOnly}
      isAdmin={opts.isAdmin}
    />,
    { exitOnCtrlC: false },
  );

  return {
    push(event) {
      if (handle) handle.push(event);
      else queue.push(event);
    },
    setAgentNames(names) {
      handle?.setAgentNames(names);
    },
    stop() {
      unmount();
    },
  };
}
