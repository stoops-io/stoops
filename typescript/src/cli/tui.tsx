/**
 * stoops TUI — ink-based terminal UI for the room server.
 *
 * Uses ink's <Static> for events (rendered once, selectable terminal text)
 * and a dynamic footer for input + status. Same architecture as Claude Code.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { render, Box, Text, Static, useStdout, useInput } from "ink";
import TextInput from "ink-text-input";

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
  serverUrl: string;
  shareUrl?: string;
  onSend?(content: string): void;
  onCtrlC?(): void;
  readOnly?: boolean;
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
  serverUrl,
  shareUrl,
  onSend,
  onCtrlC,
  onReady,
  readOnly,
}: {
  roomName: string;
  serverUrl: string;
  shareUrl?: string;
  onSend?: (content: string) => void;
  onCtrlC?: () => void;
  onReady: (handle: AppHandle) => void;
  readOnly?: boolean;
}) {
  const [events,     setEvents]     = useState<DisplayEvent[]>([]);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [input,      setInput]      = useState("");
  const { stdout } = useStdout();
  const identify   = useMemo(makeIdentityAssigner, []);

  const push = useCallback((event: DisplayEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  useEffect(() => {
    onReady({ push, setAgentNames });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render footer on resize (divider width)
  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") onCtrlC?.();
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
                  <Text color={C.dim}>{"  room      "}</Text>
                  <Text color={C.cyan}>{roomName}</Text>
                </Text>
                {shareUrl && (
                  <Text>
                    <Text color={C.dim}>{"  url       "}</Text>
                    <Text color={C.cyan}>{shareUrl}</Text>
                  </Text>
                )}
                <Text>{" "}</Text>
                <Text>
                  <Text color={C.dim}>{"  human     "}</Text>
                  <Text color={C.secondary}>{`stoops join ${shareUrl ?? serverUrl}`}</Text>
                </Text>
                <Text>
                  <Text color={C.dim}>{"  claude    "}</Text>
                  <Text color={C.secondary}>
                    {shareUrl
                      ? `stoops run claude --room ${roomName} --server ${shareUrl}`
                      : `stoops run claude --room ${roomName}`}
                  </Text>
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
        <Box paddingX={1}>
          <Text color={C.cyan} bold>{"› "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={(value) => {
              const content = value.trim();
              if (content) onSend(content);
              setInput("");
            }}
          />
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
      serverUrl={opts.serverUrl}
      shareUrl={opts.shareUrl}
      onSend={opts.onSend}
      onCtrlC={opts.onCtrlC}
      onReady={onReady}
      readOnly={opts.readOnly}
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
