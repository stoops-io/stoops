/**
 * EventProcessor — core event loop for stoops agents.
 *
 * Owns: engagement classification, content buffering, event formatting,
 * ref map, room connections, mode management. Does NOT own: LLM sessions,
 * MCP servers, compaction hooks, stats tracking.
 *
 * Delivery is pluggable — pass a `deliver` callback to `run()`.
 * The callback receives formatted ContentPart[] and does whatever the
 * consumer needs (Claude SDK query, LangGraph injection, tmux send-keys).
 */

import { EventCategory, type Participant, type ParticipantType } from "../core/types.js";
import {
  createEvent,
  type RoomEvent,
  type ActivityEvent,
  type MentionedEvent,
  type ToolUseEvent,
} from "../core/events.js";
import type { Room } from "../core/room.js";
import { type EngagementMode, type EventDisposition, type EngagementStrategy, StoopsEngagement } from "./engagement.js";
import type { ContentPart, RoomConnection, RoomResolver } from "./types.js";
import { LocalRoomDataSource } from "./room-data-source.js";
import type { RoomDataSource } from "./room-data-source.js";
import { formatEvent } from "./prompts.js";
import { buildCatchUpLines } from "./tool-handlers.js";
import { EventMultiplexer, type LabeledEvent } from "./multiplexer.js";
import { RefMap } from "./ref-map.js";
import { ConnectionRegistry, type InternalConnection } from "./connection-registry.js";
import { ContentBuffer } from "./content-buffer.js";
import { EventTracker } from "./event-tracker.js";

// ── Options ─────────────────────────────────────────────────────────────────────

export interface EventProcessorOptions {
  /** Engagement mode when no per-room override is set. */
  defaultMode?: EngagementMode;
  /** Custom engagement strategy. Defaults to StoopsEngagement. */
  engagement?: EngagementStrategy;
  /** The agent owner's participant ID (for "me" / "standby-me" modes). */
  personParticipantId?: string;
  /** The agent's own stable identifier slug (e.g. "my-agent"). */
  selfIdentifier?: string;
  /** Called when engagement mode changes for a room. */
  onModeChange?: (roomId: string, roomName: string, mode: EngagementMode) => void;
  /** Called before each delivery. Return false to skip. */
  preQuery?: () => Promise<boolean>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function mergeParts(arrays: ContentPart[][]): ContentPart[] {
  const result: ContentPart[] = [];
  for (let i = 0; i < arrays.length; i++) {
    if (i > 0) result.push({ type: "text", text: "\n" });
    result.push(...arrays[i]);
  }
  return result;
}

// ── EventProcessor ──────────────────────────────────────────────────────────────

export class EventProcessor implements RoomResolver {
  private _participantId: string;
  private _participantName: string;
  private _options: EventProcessorOptions;
  private _engagement: EngagementStrategy;

  private _deliver: ((parts: ContentPart[]) => Promise<void>) | null = null;
  private _multiplexer = new EventMultiplexer();
  private _registry = new ConnectionRegistry();
  private _buffer = new ContentBuffer();
  private _tracker = new EventTracker();
  private _processing = false;
  private _eventQueue: LabeledEvent[] = [];
  private _stopped = false;
  private _currentContextRoomId: string | null = null;
  private _log: RoomEvent[] = [];
  private _refMap = new RefMap();
  private _injectBuffer: ContentPart[][] = [];

  constructor(
    participantId: string,
    participantName: string,
    options: EventProcessorOptions = {},
  ) {
    this._participantId = participantId;
    this._participantName = participantName;
    this._options = options;
    this._engagement = options.engagement
      ?? new StoopsEngagement(options.defaultMode ?? "everyone", options.personParticipantId);
  }

  // ── Public accessors ────────────────────────────────────────────────────────

  get participantId(): string { return this._participantId; }
  get participantName(): string { return this._participantName; }
  get currentContextRoomId(): string | null { return this._currentContextRoomId; }

  // ── Ref map (consumer calls these for MCP tools) ────────────────────────────

  assignRef(messageId: string): string {
    return this._refMap.assign(messageId);
  }

  resolveRef(ref: string): string | undefined {
    return this._refMap.resolve(ref);
  }

  // ── Seen-event cache (consumer calls these for catch_up MCP tool) ───────────

  isEventSeen(eventId: string): boolean {
    return this._tracker.isDelivered(eventId);
  }

  markEventsSeen(eventIds: string[]): void {
    this._tracker.markManyDelivered(eventIds);
  }

  // ── Inject buffer (LangGraph mid-loop event injection) ──────────────────────

  drainInjectBuffer(): ContentPart[][] | null {
    if (this._injectBuffer.length === 0) return null;
    const drained = this._injectBuffer;
    this._injectBuffer = [];
    return drained;
  }

  // ── Consumer hooks (called by consumer during/after delivery) ────────────────

  /**
   * Called by the consumer when context was compacted.
   * Clears seen-event cache and ref map so catch_up returns full history.
   */
  onContextCompacted(): void {
    this._tracker.clearDelivered();
    this._refMap.clear();
  }

  /**
   * Called by the consumer when a tool call starts or completes.
   * Routes ToolUseEvent to the room that triggered the current evaluation.
   */
  emitToolUse(toolName: string, status: "started" | "completed"): void {
    if (this._currentContextRoomId) {
      const conn = this._registry.get(this._currentContextRoomId);
      if (conn) {
        const event = createEvent<ToolUseEvent>({
          type: "ToolUse",
          category: "ACTIVITY",
          room_id: this._currentContextRoomId,
          participant_id: this._participantId,
          tool_name: toolName,
          status,
        });
        const emitter = conn.dataSource.emitEvent
          ? (e: RoomEvent) => conn.dataSource.emitEvent!(e)
          : (e: RoomEvent) => conn.channel.emit(e);
        emitter(event).catch(() => {});
      }
    }
  }

  // ── RoomResolver implementation ─────────────────────────────────────────────

  resolve(roomName: string): RoomConnection | null {
    return this._registry.resolve(roomName);
  }

  listAll(): Array<{
    name: string;
    roomId: string;
    identifier?: string;
    mode: string;
    participantCount: number;
    lastMessage?: string;
  }> {
    return this._registry.listAll((roomId) => this.getModeForRoom(roomId));
  }

  // ── Room connection management ──────────────────────────────────────────────

  async connectRoom(
    room: Room,
    roomName: string,
    mode?: EngagementMode,
    identifier?: string,
  ): Promise<void> {
    if (this._registry.has(room.roomId)) return;

    const channel = await room.connect(
      this._participantId,
      this._participantName,
      "agent",
      this._options.selfIdentifier,
      new Set([
        EventCategory.MESSAGE,
        EventCategory.PRESENCE,
        EventCategory.ACTIVITY,
        EventCategory.MENTION,
      ]),
      true, // silent
    );

    const dataSource = new LocalRoomDataSource(room, channel);
    const conn: InternalConnection = { dataSource, room, channel, name: roomName, identifier };
    this._registry.add(room.roomId, conn);
    if (mode) this._engagement.setMode?.(room.roomId, mode);

    // Emit initial mode
    const initialMode = this.getModeForRoom(room.roomId);
    conn.channel.emit(createEvent<ActivityEvent>({
      type: "Activity",
      category: "ACTIVITY",
      room_id: room.roomId,
      participant_id: this._participantId,
      action: "mode_changed",
      detail: { mode: initialMode },
    })).catch(() => {});

    this._multiplexer.addChannel(room.roomId, roomName, channel);
  }

  /**
   * Connect a remote room via a RoomDataSource (no local Room/Channel).
   *
   * Used by the client-side agent runtime to register rooms that are
   * accessed over HTTP. Events come from an external source (SSE multiplexer)
   * passed to run(), not from the internal EventMultiplexer.
   */
  connectRemoteRoom(
    dataSource: RoomDataSource,
    roomName: string,
    mode?: EngagementMode,
    identifier?: string,
  ): void {
    if (this._registry.has(dataSource.roomId)) return;

    // Create a stub connection — no room or channel, just the data source
    const conn: InternalConnection = {
      dataSource,
      room: null as unknown as Room,
      channel: null as unknown as import("../core/channel.js").Channel,
      name: roomName,
      identifier,
    };
    this._registry.add(dataSource.roomId, conn);
    if (mode) this._engagement.setMode?.(dataSource.roomId, mode);
  }

  /** Disconnect a remote room (by room ID). */
  disconnectRemoteRoom(roomId: string): void {
    if (!this._registry.has(roomId)) return;
    this._registry.remove(roomId);
    this._engagement.onRoomDisconnected?.(roomId);
    this._buffer.delete(roomId);
  }

  async disconnectRoom(roomId: string): Promise<void> {
    const conn = this._registry.get(roomId);
    if (!conn) return;

    this._multiplexer.removeChannel(roomId);
    await conn.channel.disconnect(true);
    this._registry.remove(roomId);
    this._engagement.onRoomDisconnected?.(roomId);
    this._buffer.delete(roomId);
  }

  // ── Mode management ─────────────────────────────────────────────────────────

  getModeForRoom(roomId: string): EngagementMode {
    return this._engagement.getMode?.(roomId) ?? "everyone";
  }

  setModeForRoom(roomId: string, mode: EngagementMode, notifyAgent = true): void {
    this._engagement.setMode?.(roomId, mode);
    const conn = this._registry.get(roomId);
    if (conn) {
      conn.channel.emit(createEvent<ActivityEvent>({
        type: "Activity",
        category: "ACTIVITY",
        room_id: roomId,
        participant_id: this._participantId,
        action: "mode_changed",
        detail: { mode },
      })).catch(() => {});
      this._options.onModeChange?.(roomId, conn.name, mode);
    }
  }

  // ── Log ─────────────────────────────────────────────────────────────────────

  getLog(): RoomEvent[] {
    return this._log;
  }

  // ── Main event loop ─────────────────────────────────────────────────────────

  /**
   * Start the event loop.
   *
   * @param deliver — callback that receives formatted content and delivers
   *   it to the agent. This is the consumer's responsibility. The function
   *   should block until delivery is complete (e.g., LLM evaluation finished).
   * @param eventSource — optional external event source (e.g. SseMultiplexer).
   *   If provided, events are consumed from this instead of the internal
   *   EventMultiplexer. Used by the client-side agent runtime.
   * @param initialParts — optional content to deliver before entering the
   *   event loop. Used by the runtime to deliver auto-join confirmation.
   */
  async run(
    deliver: (parts: ContentPart[]) => Promise<void>,
    eventSource?: AsyncIterable<LabeledEvent>,
    initialParts?: ContentPart[],
  ): Promise<void> {
    this._deliver = deliver;

    // Deliver initial content if provided (e.g. auto-join confirmation)
    if (initialParts && initialParts.length > 0) {
      await this._processRaw(
        initialParts,
        this._registry.values().next().value?.dataSource.roomId ?? null,
      );
    }

    // Main event loop — use external source if provided, otherwise internal multiplexer
    const source = eventSource ?? this._multiplexer;
    for await (const labeled of source) {
      if (this._stopped) break;
      await this._handleLabeledEvent(labeled);
    }
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._multiplexer.close();
    await Promise.allSettled(
      [...this._registry.values()].map((conn) => conn.channel.disconnect(true)),
    );
    this._registry.clear();
    this._buffer.clear();
    this._tracker.clearAll();
    this._refMap.clear();
    this._deliver = null;
  }

  // ── Full catch-up (kept for app-path consumers) ────────────────────────────

  async buildFullCatchUp(): Promise<ContentPart[]> {
    return this._buildFullCatchUp();
  }

  private async _buildFullCatchUp(): Promise<ContentPart[]> {
    const sections: string[] = ["[Session context — loaded automatically]"];

    const nameCounts = new Map<string, number>();
    for (const [, c] of this._registry.entries()) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);

    for (const [roomId, conn] of this._registry.entries()) {
      const mode = this.getModeForRoom(roomId);
      const isDuplicate = (nameCounts.get(conn.name) ?? 0) > 1;
      const ref = isDuplicate ? roomId : (conn.identifier ?? roomId);

      sections.push(`\n${conn.name} [${ref}] — ${mode}`);

      if (mode.startsWith("standby-")) {
        sections.push("  (standby — @mentions only)");
      } else {
        const participants = conn.dataSource.listParticipants()
          .filter((p) => p.id !== this._participantId);
        if (participants.length > 0) {
          const pList = participants
            .map((p) => `${p.type} ${p.name}`)
            .join(", ");
          sections.push(`Participants: ${pList}`);
        }

        const lines = await buildCatchUpLines(conn, {
          isEventSeen: (id) => this._tracker.isDelivered(id),
          markEventsSeen: (ids) => { this._tracker.markManyDelivered(ids); },
          assignRef: (id) => this.assignRef(id),
        });
        if (lines.length > 0) {
          for (const line of lines) sections.push(`  ${line}`);
        } else {
          sections.push("  (nothing new)");
        }
      }
    }

    sections.push(
      "\n────────────────────────────────────────────────",
      "Continue immediately if you see fit, or explore further in any active room.",
    );

    return [{ type: "text", text: sections.join("\n") }];
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  private async _handleLabeledEvent(labeled: LabeledEvent): Promise<void> {
    if (this._tracker.isDuplicate(labeled.event.id)) return;

    const { roomId, event } = labeled;

    const conn = this._registry.get(roomId);
    const senderLookupId =
      event.type === "Mentioned"
        ? (event as MentionedEvent).message.sender_id
        : event.participant_id;
    const sender = conn?.dataSource.listParticipants().find((p) => p.id === senderLookupId);
    const senderType: ParticipantType = sender?.type ?? "human";

    const disposition: EventDisposition = this._engagement.classify(event, roomId, this._participantId, senderType, senderLookupId);

    if (disposition === "drop") return;

    this._tracker.markDelivered(event.id);

    if (disposition === "content") {
      this._buffer.push(roomId, { event, roomId, roomName: labeled.roomName });
      return;
    }

    // trigger
    this._log.push(event);

    if (this._processing) {
      this._eventQueue.push(labeled);
      this._formatForLLM(event, roomId, labeled.roomName).then((parts) => {
        if (parts) this._injectBuffer.push(parts);
      }).catch((err) => {
        console.error(`[${this._participantName}] inject buffer format error:`, err);
      });
      return;
    }

    await this._processTrigger(labeled);

    // Drain queued events
    while (this._eventQueue.length > 0) {
      const queued = this._eventQueue;
      this._eventQueue = [];

      const formatted: ContentPart[][] = [];
      let batchContextRoom: string | null = null;
      const roomsProcessed = new Set<string>();

      for (const qe of queued) {
        const qConn = this._registry.get(qe.roomId);
        const qSenderLookupId =
          qe.event.type === "Mentioned"
            ? (qe.event as MentionedEvent).message.sender_id
            : qe.event.participant_id;
        const qSender = qConn?.dataSource.listParticipants().find((p) => p.id === qSenderLookupId);
        const qSenderType: ParticipantType = qSender?.type ?? "human";
        const qDisposition = this._engagement.classify(qe.event, qe.roomId, this._participantId, qSenderType, qSenderLookupId);

        if (qDisposition === "drop") continue;

        if (!roomsProcessed.has(qe.roomId)) {
          roomsProcessed.add(qe.roomId);
          const buffered = this._buffer.flush(qe.roomId);
          for (const item of buffered) {
            const parts = await this._formatForLLM(item.event, item.roomId, item.roomName);
            if (parts) {
              formatted.push(parts);
              if (!batchContextRoom) batchContextRoom = qe.roomId;
            }
          }
        }

        this._log.push(qe.event);
        const parts = await this._formatForLLM(qe.event, qe.roomId, qe.roomName);
        if (parts) {
          formatted.push(parts);
          if (!batchContextRoom) batchContextRoom = qe.roomId;
        }
      }

      if (formatted.length > 0) {
        await this._processRaw(mergeParts(formatted), batchContextRoom);
      }
    }
  }

  private async _processTrigger(labeled: LabeledEvent): Promise<void> {
    const { roomId, roomName, event } = labeled;

    const buffered = this._buffer.flush(roomId);

    const contentPartArrays: ContentPart[][] = [];
    for (const item of buffered) {
      const parts = await this._formatForLLM(item.event, item.roomId, item.roomName);
      if (parts) contentPartArrays.push(parts);
    }

    // Cache lastMessage
    if (event.type === "MessageSent") {
      const conn = this._registry.get(roomId);
      const senderLabel = conn?.dataSource.listParticipants().find((p) => p.id === event.message.sender_id)?.name ?? event.message.sender_name;
      const contentPreview = event.message.content.length > 60 ? event.message.content.slice(0, 57) + "..." : event.message.content;
      const preview = event.message.image_url && !event.message.content.trim()
        ? "sent an image"
        : contentPreview;
      this._registry.setLastMessage(roomId, `${senderLabel}: ${preview}`);
    }

    const triggerParts = await this._formatForLLM(event, roomId, roomName);
    if (!triggerParts && contentPartArrays.length === 0) return;

    const mergedParts = mergeParts([...contentPartArrays, ...(triggerParts ? [triggerParts] : [])]);
    await this._processRaw(mergedParts, roomId);
  }

  // ── Formatting ──────────────────────────────────────────────────────────────

  private _resolveParticipantForRoom(roomId: string): (id: string) => Participant | null {
    return (id: string) => {
      const conn = this._registry.get(roomId);
      if (!conn) return null;
      return conn.dataSource.listParticipants().find((p) => p.id === id) ?? null;
    };
  }

  private async _resolveReplyContext(
    event: RoomEvent,
    roomId: string,
  ): Promise<{ senderName: string; content: string } | null> {
    if (event.type !== "MessageSent" && event.type !== "Mentioned") return null;
    const msg = event.message;
    if (!msg.reply_to_id) return null;
    const conn = this._registry.get(roomId);
    if (!conn) return null;
    const repliedTo = await conn.dataSource.getMessage(msg.reply_to_id);
    return repliedTo ? { senderName: repliedTo.sender_name, content: repliedTo.content } : null;
  }

  private async _resolveReactionTarget(
    event: RoomEvent,
    roomId: string,
  ): Promise<{ senderName: string; content: string; isSelf: boolean } | null> {
    if (event.type !== "ReactionAdded") return null;
    const conn = this._registry.get(roomId);
    if (!conn) return null;
    const target = await conn.dataSource.getMessage(event.message_id);
    if (!target) return null;
    return {
      senderName: target.sender_name,
      content: target.content,
      isSelf: target.sender_id === this._participantId,
    };
  }

  private async _formatForLLM(
    event: RoomEvent,
    roomId: string,
    roomName: string,
  ): Promise<ContentPart[] | null> {
    const mode = this.getModeForRoom(roomId);
    const label = mode !== "everyone" ? `${roomName} — ${mode}` : roomName;
    const replyContext = await this._resolveReplyContext(event, roomId);
    const reactionTarget = await this._resolveReactionTarget(event, roomId);
    return formatEvent(
      event,
      this._resolveParticipantForRoom(roomId),
      replyContext,
      label,
      reactionTarget,
      (id) => this.assignRef(id),
    );
  }

  // ── Delivery ────────────────────────────────────────────────────────────────

  private async _processRaw(
    parts: ContentPart[],
    contextRoomId: string | null,
  ): Promise<void> {
    if (this._options.preQuery && !(await this._options.preQuery())) {
      return;
    }

    this._processing = true;
    this._currentContextRoomId = contextRoomId;

    try {
      if (!this._deliver) return;
      await this._deliver(parts);
    } catch (err) {
      console.error(`[${this._participantName}] error:`, err);
    } finally {
      this._currentContextRoomId = null;
      this._processing = false;
    }
  }
}
