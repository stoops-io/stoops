/**
 * stoops TUI — ink-based terminal UI for the room server.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { render, Box, Text, useStdout, useInput } from "ink";
import TextInput from "ink-text-input";

// ── Palette (from stoops-app) ─────────────────────────────────────────────────

const C = {
  cyan:      "#00d4ff",
  cyanSoft:  "#07b8de",
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

// ── Types ─────────────────────────────────────────────────────────────────────

export type DisplayEvent =
  | { id: string; ts: string; kind: "message"; senderName: string; senderType: "human" | "agent"; isSelf: boolean; content: string }
  | { id: string; ts: string; kind: "join";    name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "leave";   name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "mode";    mode: string };

export interface TUIHandle {
  push(event: DisplayEvent): void;
  setAgentNames(names: string[]): void;
  stop(): void;
}

export interface TUIOptions {
  roomName: string;
  serverUrl: string;
  onSend(content: string): void;
  onCtrlC?(): void;
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

// ── Topographic animation ─────────────────────────────────────────────────────

const TOPO_W          = 44;
const TOPO_H_DEFAULT  = 13;
const TOPO_H_MIN      = 5;
const TOPO_ASPECT     = 2.1;

const TOPO_LEVELS = [
  { char: " ", color: "" },
  { char: " ", color: "" },
  { char: " ", color: "" },
  { char: "·", color: C.muted },
  { char: "·", color: C.dim },
  { char: ":", color: C.dim },
  { char: "─", color: C.secondary },
  { char: "▒", color: C.secondary },
  { char: "●", color: C.cyan },
] as const;

type Seg = { text: string; color: string };

function computeTopoLine(y: number, phase: number, h: number): Seg[] {
  const cx = TOPO_W / 2;
  const cy = h / 2;
  const dy = ((y - cy) / (h * 0.5)) * TOPO_ASPECT;
  const cells: Array<{ char: string; color: string }> = [];

  for (let x = 0; x < TOPO_W; x++) {
    const dx = (x - cx) / (TOPO_W * 0.5);
    const r  = Math.sqrt(dx * dx + dy * dy);
    const θ  = Math.atan2(dy, dx);
    const wave =
      Math.sin(r * 9.5 - phase)       * 0.55 +
      Math.sin(r * 4.5 - phase * 0.6) * 0.28 +
      Math.cos(θ * 2   + phase * 0.4) * 0.17;
    const val  = (wave + 1) / 2;
    const fade = Math.max(0, 1 - r * 1.12);
    const idx  = Math.min(TOPO_LEVELS.length - 1, Math.floor(val * fade * TOPO_LEVELS.length));
    cells.push(TOPO_LEVELS[idx]);
  }

  const segs: Seg[] = [];
  for (const c of cells) {
    const last = segs[segs.length - 1];
    if (last && last.color === c.color) last.text += c.char;
    else segs.push({ text: c.char, color: c.color });
  }
  return segs;
}

function TopoAnimation({ height }: { height: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase((p) => p + 0.1), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Box flexDirection="column" alignItems="center">
      {Array.from({ length: height }, (_, y) => (
        <Box key={y}>
          {computeTopoLine(y, phase, height).map((seg, i) => (
            <Text key={i} color={seg.color || undefined}>{seg.text}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
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

    return (
      <Box>
        {ts}
        <Text color={sigilColor}>{sigilChar}{" "}</Text>
        <Text color={nameColor} bold={isSelf}>
          {event.senderName.slice(0, NAME_COL).padEnd(NAME_COL)}
        </Text>
        <Text>{"  "}</Text>
        <Text color={isSelf ? C.text : C.secondary}>{event.content}</Text>
      </Box>
    );
  }

  // ── Join ──
  if (event.kind === "join") {
    const isAgent = event.participantType === "agent";
    const { color, sigil } = isAgent ? identify(event.name) : { color: C.dim, sigil: "·" };
    return (
      <Box>
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
      <Box>
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
      <Box>
        {ts}
        <Text color={C.dim}>{"mode → "}</Text>
        <Text color={C.yellow} bold>{event.mode}</Text>
      </Box>
    );
  }

  return null;
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({
  roomName,
  serverUrl,
  agentNames,
  identify,
}: {
  roomName: string;
  serverUrl: string;
  agentNames: string[];
  identify: (n: string) => { color: string; sigil: string };
}) {
  return (
    <Box paddingX={1}>
      <Text color={C.cyan} bold>{"stoops"}</Text>
      <Text color={C.border}>{"  ·  "}</Text>
      <Text color={C.text} bold>{roomName}</Text>
      <Text color={C.border}>{"  ·  "}</Text>
      <Text color={C.muted}>{serverUrl}</Text>
      {agentNames.length > 0 && (
        <>
          <Text color={C.border}>{"  ·  "}</Text>
          {agentNames.map((name, i) => {
            const { color, sigil } = identify(name);
            return (
              <React.Fragment key={name}>
                {i > 0 && <Text color={C.border}>{", "}</Text>}
                <Text color={color}>{sigil} {name}</Text>
              </React.Fragment>
            );
          })}
        </>
      )}
    </Box>
  );
}

// ── Internal bridge ───────────────────────────────────────────────────────────

interface AppHandle {
  push: (event: DisplayEvent) => void;
  setAgentNames: (names: string[]) => void;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App({
  roomName,
  serverUrl,
  onSend,
  onCtrlC,
  onReady,
}: {
  roomName: string;
  serverUrl: string;
  onSend: (content: string) => void;
  onCtrlC?: () => void;
  onReady: (handle: AppHandle) => void;
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

  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") onCtrlC?.();
  });

  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;

  // ── Responsive breakpoints ──
  // Progressively hide UI chrome as the terminal shrinks.
  const showDividers = rows >= 10;
  const fixedRows    = 2 + (showDividers ? 2 : 0);  // header(1) + input(1) + dividers(0|2)
  const contentH     = Math.max(1, rows - fixedRows);
  const divider      = showDividers ? "─".repeat(Math.max(0, cols - 2)) : "";

  const hasMessages = events.some((e) => e.kind === "message");

  // Topo: scale height to fit, hide entirely if too cramped
  const topoH     = Math.min(TOPO_H_DEFAULT, Math.max(0, contentH - 4));
  const showTopo   = !hasMessages && topoH >= TOPO_H_MIN;
  const showHints  = showTopo && agentNames.length === 0 && contentH >= topoH + 6;
  const showEvents = !hasMessages && events.length > 0 && contentH >= topoH + 2;

  // Message feed capacity
  const msgCapacity  = Math.max(1, contentH - 1);  // -1 buffer
  const hasOverflow  = hasMessages && events.length > msgCapacity;
  const visibleCount = hasOverflow ? msgCapacity - 1 : msgCapacity;
  const visible      = events.slice(-visibleCount);

  return (
    <Box flexDirection="column" height={rows}>

      <Header roomName={roomName} serverUrl={serverUrl} agentNames={agentNames} identify={identify} />
      {showDividers && <Text color={C.border}>{divider}</Text>}

      {/* ── Main content ── */}
      <Box flexGrow={1} flexDirection="column">
        {!hasMessages ? (
          // Idle state
          <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
            {showTopo && <TopoAnimation height={topoH} />}

            {showEvents && (
              <Box marginTop={showTopo ? 1 : 0} flexDirection="column" alignItems="center">
                {events.slice(-(Math.min(6, contentH - topoH - (showHints ? 4 : 1)))).map((ev) => (
                  <EventLine key={ev.id} event={ev} identify={identify} />
                ))}
              </Box>
            )}

            {showHints && (
              <Box marginTop={1} flexDirection="column" alignItems="center">
                <Text color={C.muted}>{"connect an agent:"}</Text>
                <Text>
                  <Text color={C.dim}>{"  stoops run claude --room "}</Text>
                  <Text color={C.text}>{roomName}</Text>
                </Text>
              </Box>
            )}
          </Box>
        ) : (
          // Message feed
          <>
            {hasOverflow && (
              <Box paddingX={2}>
                <Text color={C.muted}>{"↑ "}{events.length - visibleCount}{" more"}</Text>
              </Box>
            )}
            <Box flexGrow={1} />
            {visible.map((ev) => (
              <EventLine key={ev.id} event={ev} identify={identify} />
            ))}
          </>
        )}
      </Box>

      {showDividers && <Text color={C.border}>{divider}</Text>}
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

    </Box>
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
      onSend={opts.onSend}
      onCtrlC={opts.onCtrlC}
      onReady={onReady}
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
