/** Pure tool handler logic */

import type { Message } from "../core/types.js";
import type { RoomConnection, RoomResolver, ToolHandlerOptions } from "./types.js";
import { messageRef, formatTimestamp } from "./prompts.js";

/** Tool result shape consumed by both backends. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

/** Helper: resolve room name or return an error tool result. */
export function resolveOrError(resolver: RoomResolver, roomName: string):
  | { error: true; result: ToolResult }
  | { error: false; conn: RoomConnection } {
  const conn = resolver.resolve(roomName);
  if (!conn) {
    return {
      error: true as const,
      result: { content: [{ type: "text" as const, text: `Unknown room "${roomName}".` }] },
    };
  }
  return { error: false as const, conn };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** Format a single message as a transcript line (shared by catch_up and search tools). */
export async function formatMsgLine(
  msg: Message,
  conn: RoomConnection,
  mkRef: (id: string) => string,
): Promise<string> {
  const participant = conn.dataSource.listParticipants().find((p) => p.id === msg.sender_id);
  const typeLabel = participant?.type ?? "human";
  const ts = formatTimestamp(new Date(msg.timestamp));
  const ref = mkRef(msg.id);
  const imageNote = msg.image_url ? ` [[img:${msg.image_url}]]` : "";
  let line = `[${ts}] ${typeLabel} ${msg.sender_name}: ${msg.content}${imageNote} ${ref}`;
  if (msg.reply_to_id) {
    const target = await conn.dataSource.getMessage(msg.reply_to_id);
    if (target) {
      const targetRef = mkRef(target.id);
      const q = target.content.slice(0, 40) + (target.content.length > 40 ? "..." : "");
      line = `[${ts}] ${typeLabel} ${msg.sender_name} (→ ${targetRef} ${target.sender_name}: "${q}"): ${msg.content}${imageNote} ${ref}`;
    }
  }
  return line;
}

/**
 * Build catch-up event lines for a room — shared by the catch_up MCP tool and
 * the runtime's full_catch_up injection. Returns formatted transcript lines for
 * all unseen events (oldest first), marking them as seen.
 */
export async function buildCatchUpLines(
  conn: RoomConnection,
  options: Pick<ToolHandlerOptions, "isEventSeen" | "markEventsSeen" | "assignRef">,
): Promise<string[]> {
  const result = await conn.dataSource.getEvents(null, 50, null);
  const chronological = [...result.items].reverse();

  let startIdx = chronological.length;
  for (let i = 0; i < chronological.length; i++) {
    if (!options.isEventSeen?.(chronological[i].id)) {
      startIdx = i;
      break;
    }
  }
  const unseen = chronological.slice(startIdx);

  const lines: string[] = [];
  const seenIds: string[] = [];
  const mkRef = (id: string) => `(#${options.assignRef?.(id) ?? messageRef(id)})`;

  for (const event of unseen) {
    seenIds.push(event.id);
    const ts = formatTimestamp(new Date(event.timestamp));

    if (event.type === "MessageSent") {
      lines.push(await formatMsgLine(event.message, conn, mkRef));
    } else if (event.type === "ParticipantJoined") {
      const participant = conn.dataSource.listParticipants().find((p) => p.id === event.participant_id);
      const typeLabel = participant?.type ?? "human";
      const name = participant?.name ?? event.participant_id;
      lines.push(`[${ts}] ${typeLabel} ${name} joined the chat`);
    } else if (event.type === "ParticipantLeft") {
      const snapshot = event.participant;
      const typeLabel = snapshot?.type ?? "human";
      const name = snapshot?.name ?? event.participant_id;
      lines.push(`[${ts}] ${typeLabel} ${name} left the chat`);
    } else if (event.type === "ReactionAdded") {
      const participant = conn.dataSource.listParticipants().find((p) => p.id === event.participant_id);
      const typeLabel = participant?.type ?? "human";
      const name = participant?.name ?? event.participant_id;
      const target = await conn.dataSource.getMessage(event.message_id);
      const targetRef = target ? ` to ${mkRef(target.id)}` : "";
      lines.push(`[${ts}] ${typeLabel} ${name} reacted ${event.emoji}${targetRef}`);
    }
    // Other event types (ToolUse, Activity, Mentioned, etc.) are skipped
  }

  if (seenIds.length > 0) options.markEventsSeen?.(seenIds);
  return lines;
}

// ── Tool handler functions ────────────────────────────────────────────────────

export async function handleCatchUp(
  resolver: RoomResolver,
  args: { room: string },
  options: ToolHandlerOptions,
): Promise<ToolResult> {
  const r = resolveOrError(resolver, args.room);
  if (r.error) return r.result;
  const lines = await buildCatchUpLines(r.conn, options);
  const out: string[] = [`Catching up on [${args.room}]:`];
  if (lines.length > 0) {
    out.push("", ...lines);
  } else {
    out.push("", "(nothing new)");
  }
  return { content: [{ type: "text" as const, text: out.join("\n") }] };
}

export async function handleSearchByText(
  resolver: RoomResolver,
  args: { room: string; query: string; count?: number; cursor?: string },
  options: ToolHandlerOptions,
): Promise<ToolResult> {
  const r = resolveOrError(resolver, args.room);
  if (r.error) return r.result;
  const { conn } = r;
  const count = args.count ?? 3;
  const mkRef = (id: string) => `(#${options.assignRef?.(id) ?? messageRef(id)})`;

  // Get up to 50 matches to know the total; slice to count for display
  const searchResult = await conn.dataSource.searchMessages(args.query, 50, args.cursor ?? null);
  const totalVisible = searchResult.items.length;

  if (totalVisible === 0) {
    return textResult(`No messages found in [${args.room}] matching "${args.query}".`);
  }

  const toShow = searchResult.items.slice(0, count); // newest-first

  // Load recent messages for context (before/after lookup)
  const recentResult = await conn.dataSource.getMessages(100, null);
  const recentChron = [...recentResult.items].reverse(); // chronological
  const msgIdxMap = new Map<string, number>();
  recentChron.forEach((m, i) => msgIdxMap.set(m.id, i));

  // Process clusters oldest-first (reverse the newest-first results)
  const clusters: string[][] = [];
  let newerCount: number | null = null;

  for (const match of [...toShow].reverse()) {
    const cluster: string[] = [];
    const matchIdx = msgIdxMap.get(match.id);

    if (matchIdx !== undefined) {
      // Before context
      if (matchIdx > 0) {
        cluster.push(await formatMsgLine(recentChron[matchIdx - 1], conn, mkRef));
      }
      // Match line
      cluster.push((await formatMsgLine(match, conn, mkRef)) + " ←");
      // After context
      if (matchIdx < recentChron.length - 1) {
        cluster.push(await formatMsgLine(recentChron[matchIdx + 1], conn, mkRef));
      }
      // Track newer count based on the newest match (first in toShow = newest)
      if (newerCount === null && match.id === toShow[0].id) {
        newerCount = recentChron.length - matchIdx - 1;
      }
    } else {
      // Match is older than the context window — show match only
      cluster.push((await formatMsgLine(match, conn, mkRef)) + " ←");
    }

    clusters.push(cluster);
  }

  // Build output
  const shownCount = toShow.length;
  const totalNote = searchResult.has_more
    ? `showing ${shownCount} of 50+`
    : `${shownCount} of ${totalVisible}`;
  const out: string[] = [`Search results in [${args.room}] for "${args.query}" (${totalNote} matches):`, ""];

  for (let i = 0; i < clusters.length; i++) {
    for (const line of clusters[i]) {
      out.push(`  ${line}`);
    }
    if (i < clusters.length - 1) out.push("");
  }

  if (newerCount !== null && newerCount > 0) {
    out.push("", `${newerCount} newer message${newerCount === 1 ? "" : "s"} in this room.`);
  }
  if (searchResult.has_more && searchResult.next_cursor) {
    out.push(`(cursor: "${searchResult.next_cursor}" for next ${count} matches)`);
  }

  return textResult(out.join("\n"));
}

export async function handleSearchByMessage(
  resolver: RoomResolver,
  args: { room: string; ref: string; direction?: "before" | "after"; count?: number },
  options: ToolHandlerOptions,
): Promise<ToolResult> {
  const r = resolveOrError(resolver, args.room);
  if (r.error) return r.result;
  const { conn } = r;
  const direction = args.direction ?? "before";
  const count = args.count ?? 10;
  const mkRef = (id: string) => `(#${options.assignRef?.(id) ?? messageRef(id)})`;

  // Resolve ref to message ID
  const rawRef = args.ref.startsWith("#") ? args.ref.slice(1) : args.ref;
  const anchorId = options.resolveRef?.(rawRef) ?? rawRef;
  const anchor = await conn.dataSource.getMessage(anchorId);
  if (!anchor) return textResult(`Message ${args.ref} not found.`);

  // Load recent messages for "after" direction and "newer count"
  const recentResult = await conn.dataSource.getMessages(100, null);
  const recentChron = [...recentResult.items].reverse(); // chronological
  const anchorIdx = recentChron.findIndex((m) => m.id === anchor.id);

  let displayMessages: Message[];
  let newerCount: number;

  if (direction === "before") {
    // Get count messages before anchor from storage (works for any age)
    const beforeResult = await conn.dataSource.getMessages(count, anchor.id);
    const beforeMessages = [...beforeResult.items].reverse(); // chronological
    displayMessages = [...beforeMessages, anchor];
    newerCount = anchorIdx >= 0 ? recentChron.length - anchorIdx - 1 : 100; // 100+ if too old
  } else {
    // "after" — use recent window
    if (anchorIdx >= 0) {
      const afterMessages = recentChron.slice(anchorIdx + 1, anchorIdx + 1 + count);
      displayMessages = [anchor, ...afterMessages];
      newerCount = recentChron.length - anchorIdx - 1 - afterMessages.length;
    } else {
      // Anchor not in recent 100 — can't scroll forward, too many newer messages
      displayMessages = [anchor];
      newerCount = 100;
    }
  }

  const anchorRef = mkRef(anchor.id);
  const lines: string[] = [`Context in [${args.room}] around ${anchorRef}:`, ""];

  for (const msg of displayMessages) {
    const line = await formatMsgLine(msg, conn, mkRef);
    const isAnchor = msg.id === anchor.id;
    lines.push(`  ${line}${isAnchor ? " ←" : ""}`);
  }

  if (newerCount > 0) {
    const countLabel = newerCount >= 100 ? "100+" : String(newerCount);
    lines.push("", `${countLabel} newer message${newerCount === 1 ? "" : "s"} in this room.`);
  }

  return textResult(lines.join("\n"));
}

export async function handleSendMessage(
  resolver: RoomResolver,
  args: {
    room: string;
    content: string;
    reply_to_id?: string;
    image_url?: string;
    image_mime_type?: string;
    image_size_bytes?: number;
  },
  options: ToolHandlerOptions,
): Promise<ToolResult> {
  const r = resolveOrError(resolver, args.room);
  if (r.error) return r.result;

  const image = args.image_url
    ? {
        url: args.image_url,
        mimeType: args.image_mime_type ?? "image/*",
        sizeBytes: args.image_size_bytes ?? 0,
      }
    : null;

  // Resolve ref to full UUID — accepts both "#3847" and "3847"
  let replyToId = args.reply_to_id;
  if (replyToId) {
    const rawRef = replyToId.startsWith("#") ? replyToId.slice(1) : replyToId;
    replyToId = options.resolveRef?.(rawRef) ?? replyToId;
  }
  const message = await r.conn.dataSource.sendMessage(args.content, replyToId, image);

  const ref = options.assignRef?.(message.id) ?? messageRef(message.id);
  return textResult(`Message sent (#${ref}).`);
}
