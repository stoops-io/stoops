/**
 * StoopRuntime — multi-room event loop for stoops.
 *
 * One runtime = one LLM session = N room connections.
 * Events from all rooms flow into one brain via EventMultiplexer.
 */

import { EventCategory, type Participant, type ParticipantType } from "../core/types.js";
import {
  createEvent,
  type RoomEvent,
  type ActivityEvent,
  type ContextCompactedEvent,
  type MentionedEvent,
  type ToolUseEvent,
} from "../core/events.js";
import type { Room } from "../core/room.js";
import { type EngagementMode, type EventDisposition, type EngagementStrategy, StoopsEngagement } from "./engagement.js";
import type { ContentPart, RoomConnection, RoomResolver, StoopRuntimeOptions, ILLMSession } from "./types.js";
import { formatEvent, contentPartsToString } from "./prompts.js";
import { buildCatchUpLines } from "./tool-handlers.js";
import { EventMultiplexer, type LabeledEvent } from "./multiplexer.js";
import { RefMap } from "./ref-map.js";

interface InternalConnection extends RoomConnection {
  roomName: string;
  identifier?: string;
}

interface BufferedContent {
  event: RoomEvent;
  roomId: string;
  roomName: string;
}

/** Merge multiple ContentPart arrays into one, inserting newline separators between them. */
function mergeParts(arrays: ContentPart[][]): ContentPart[] {
  const result: ContentPart[] = [];
  for (let i = 0; i < arrays.length; i++) {
    if (i > 0) result.push({ type: "text", text: "\n" });
    result.push(...arrays[i]);
  }
  return result;
}

/**
 * StoopRuntime — the primary entry point for building multi-room stoops.
 *
 * Implements RoomResolver so it can be passed directly to LLMSession.
 * Handles the full event loop: startup prompt, event classification, content
 * buffering, queue management, ParticipantActivated/Deactivated emission,
 * hot connect/disconnect, notification queuing.
 */
export class StoopRuntime implements RoomResolver {
  private _participantId: string;
  private _participantName: string;
  private _systemPrompt: string;
  private _model: string;
  private _options: StoopRuntimeOptions;
  private _engagement: EngagementStrategy;

  private _session: ILLMSession | null = null;
  private _injectBuffer: ContentPart[][] = [];
  private _multiplexer = new EventMultiplexer();
  private _connections = new Map<string, InternalConnection>(); // keyed by roomId
  private _nameToId = new Map<string, string>(); // roomName → roomId
  private _identifierToId = new Map<string, string>(); // identifier slug → roomId
  private _processing = false;
  private _eventQueue: LabeledEvent[] = [];
  private _contentBuffer = new Map<string, BufferedContent[]>(); // roomId → buffered content
  private _stopped = false;
  private _currentContextRoomId: string | null = null;
  private _log: RoomEvent[] = [];
  private _lastMessages = new Map<string, string>(); // roomId → "name: content"
  private _pendingNotifications: Array<{ parts: ContentPart[]; contextRoomId: string | null }> = [];
  private _seenEventIds = new Set<string>(); // dedup guard — prevents N-times delivery
  private _seenEventCache = new Set<string>(); // tracks events injected into LLM context
  private _needsFullCatchUp = false; // set by onContextCompacted; triggers injection after _processRaw

  /** Ref map — 4-digit decimal refs visible to the LLM, resolved to full message UUIDs by tools. */
  private _refMap = new RefMap();

  constructor(
    participantId: string,
    participantName: string,
    systemPrompt: string,
    model: string,
    defaultMode: EngagementMode,
    options: StoopRuntimeOptions,
  ) {
    if (!options.sessionFactory) {
      throw new Error("StoopRuntime requires a sessionFactory in options");
    }
    this._participantId = participantId;
    this._participantName = participantName;
    this._systemPrompt = systemPrompt;
    this._model = model;
    this._options = options;
    this._engagement = options.engagement
      ?? new StoopsEngagement(defaultMode, options.personParticipantId);
  }

  // ── Ref map ──────────────────────────────────────────────────────────────

  assignRef(messageId: string): string {
    return this._refMap.assign(messageId);
  }

  resolveRef(ref: string): string | undefined {
    return this._refMap.resolve(ref);
  }

  /** Build a full catch-up snapshot across all rooms, injected at startup and post-compaction. */
  private async _buildFullCatchUp(): Promise<ContentPart[]> {
    const sections: string[] = ["[Session context — loaded automatically]"];

    // Detect duplicate display names for unambiguous refs
    const nameCounts = new Map<string, number>();
    for (const [, c] of this._connections) nameCounts.set(c.roomName, (nameCounts.get(c.roomName) ?? 0) + 1);

    for (const [roomId, conn] of this._connections) {
      const mode = this.getModeForRoom(roomId);
      const isDuplicate = (nameCounts.get(conn.roomName) ?? 0) > 1;
      const ref = isDuplicate ? roomId : (conn.identifier ?? roomId);

      sections.push(`\n${conn.roomName} [${ref}] — ${mode}`);

      if (mode.startsWith("standby-")) {
        sections.push("  (standby — @mentions only)");
      } else {
        // Participant list — exclude self
        const participants = conn.room.listParticipants()
          .filter((p) => p.id !== this._participantId);
        if (participants.length > 0) {
          const pList = participants
            .map((p) => `${p.type === "stoop" ? "🤖" : "👤"} ${p.name}`)
            .join(", ");
          sections.push(`Participants: ${pList}`);
        }

        const lines = await buildCatchUpLines(conn, {
          isEventSeen: (id) => this._seenEventCache.has(id),
          markEventsSeen: (ids) => { for (const id of ids) this._seenEventCache.add(id); },
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

  // ── RoomResolver implementation ──────────────────────────────────────────

  resolve(roomName: string): RoomConnection | null {
    // Try display name first
    const roomId = this._nameToId.get(roomName);
    if (roomId) return this._connections.get(roomId) ?? null;
    // Try identifier slug (e.g. "your-crew")
    const idFromIdentifier = this._identifierToId.get(roomName);
    if (idFromIdentifier) return this._connections.get(idFromIdentifier) ?? null;
    // Try roomId directly
    const direct = this._connections.get(roomName) ?? null;
    if (!direct) console.debug(`[${this._participantName}] resolve miss for "${roomName}" — known rooms: ${[...this._nameToId.keys()].join(", ")}`);
    return direct;
  }

  listAll(): Array<{
    name: string;
    roomId: string;
    identifier?: string;
    mode: string;
    participantCount: number;
    lastMessage?: string;
  }> {
    return [...this._connections.entries()].map(([roomId, conn]) => ({
      name: conn.roomName,
      roomId,
      ...(conn.identifier ? { identifier: conn.identifier } : {}),
      mode: this.getModeForRoom(roomId),
      participantCount: conn.room.listParticipants().length,
      ...(this._lastMessages.has(roomId) ? { lastMessage: this._lastMessages.get(roomId) } : {}),
    }));
  }

  // ── Room connection management ───────────────────────────────────────────

  async connectRoom(
    room: Room,
    roomName: string,
    mode?: EngagementMode,
    identifier?: string,
  ): Promise<void> {
    if (this._connections.has(room.roomId)) return;

    const channel = await room.connect(
      this._participantId,
      this._participantName,
      "stoop",
      this._options.selfIdentifier,
      new Set([
        EventCategory.MESSAGE,
        EventCategory.PRESENCE,
        EventCategory.ACTIVITY,
        EventCategory.MENTION,
      ]),
      true, // silent — stoop connecting is not a join event
    );

    const conn: InternalConnection = { room, channel, name: roomName, roomName, identifier };
    this._connections.set(room.roomId, conn);
    this._nameToId.set(roomName, room.roomId);
    if (identifier) this._identifierToId.set(identifier, room.roomId);
    if (mode) this._engagement.setMode?.(room.roomId, mode);

    // Emit initial mode to the room channel so it appears in the event stream
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

    // If session is already running, notify the stoop about the new room
    if (this._session && !this._stopped) {
      const roomMode = this.getModeForRoom(room.roomId);
      const notifyText = `You've been added to [${roomName}] — ${roomMode}. Use catch_up("${roomName}") to read what's been happening. Note: some participants may not appear in the list yet if they haven't reconnected — they'll show up once they send a message.`;
      if (this._processing) {
        this._pendingNotifications.push({ parts: [{ type: "text", text: notifyText }], contextRoomId: room.roomId });
      } else {
        await this._processRaw([{ type: "text", text: notifyText }], room.roomId);
      }
    }
  }

  async disconnectRoom(roomId: string): Promise<void> {
    const conn = this._connections.get(roomId);
    if (!conn) return;

    this._multiplexer.removeChannel(roomId);
    await conn.channel.disconnect(true); // silent — stoop disconnecting is not a leave event
    this._nameToId.delete(conn.roomName);
    if (conn.identifier) this._identifierToId.delete(conn.identifier);
    this._connections.delete(roomId);
    this._engagement.onRoomDisconnected?.(roomId);
    this._contentBuffer.delete(roomId);
    this._lastMessages.delete(roomId);
  }

  /** Update the BYOK API key for the current session. */
  setApiKey(key: string): void {
    this._session?.setApiKey(key);
  }

  // ── Mode management (per-room) ──────────────────────────────────────────

  getModeForRoom(roomId: string): EngagementMode {
    return this._engagement.getMode?.(roomId) ?? "everyone";
  }

  setModeForRoom(roomId: string, mode: EngagementMode, notifyStoop = true): void {
    this._engagement.setMode?.(roomId, mode);
    const conn = this._connections.get(roomId);
    if (conn) {
      conn.channel.emit(createEvent<ActivityEvent>({
        type: "Activity",
        category: "ACTIVITY",
        room_id: roomId,
        participant_id: this._participantId,
        action: "mode_changed",
        detail: { mode },
      })).catch(() => {});
      this._options.onModeChange?.(roomId, conn.roomName, mode);
      if (notifyStoop && this._session && !this._stopped) {
        const notifyText = `[${conn.roomName}] mode changed to ${mode}.`;
        if (this._processing) {
          this._pendingNotifications.push({ parts: [{ type: "text", text: notifyText }], contextRoomId: roomId });
        } else {
          this._processRaw([{ type: "text", text: notifyText }], roomId).catch(console.error);
        }
      }
    }
  }

  // ── Main event loop ───────────────────────────────────────────────────────

  private _drainInjectBuffer(): ContentPart[][] | null {
    if (this._injectBuffer.length === 0) return null;
    const drained = this._injectBuffer;
    this._injectBuffer = [];
    return drained;
  }

  async run(): Promise<void> {
    this._session = this._options.sessionFactory(
      this._systemPrompt,
      this, // RoomResolver
      this._model,
      {
        pathToClaudeCodeExecutable: this._options.pathToClaudeCodeExecutable,
        resolveParticipantIdentifier: this._options.resolveParticipantIdentifier,
        selfId: this._participantId,
        selfIdentifier: this._options.selfIdentifier,
        apiKey: this._options.apiKey,
        isEventSeen: (eventId: string) => this._seenEventCache.has(eventId),
        markEventsSeen: (eventIds: string[]) => { for (const id of eventIds) this._seenEventCache.add(id); },
        assignRef: (messageId: string) => this.assignRef(messageId),
        resolveRef: (ref: string) => this.resolveRef(ref),
        onToolUse: (toolName, status) => {
          // Route ToolUseEvent to the room that triggered processing
          if (this._currentContextRoomId) {
            const conn = this._connections.get(this._currentContextRoomId);
            if (conn) {
              conn.channel.emit(createEvent<ToolUseEvent>({
                type: "ToolUse",
                category: "ACTIVITY",
                room_id: this._currentContextRoomId,
                participant_id: this._participantId,
                tool_name: toolName,
                status,
              })).catch(() => {});
            }
          }
          this._options.onToolUse?.(toolName, status);
        },
        onQueryComplete: (stats) => {
          this._options.onQueryComplete?.(stats, this._currentContextRoomId);
        },
        onContextCompacted: () => {
          this._seenEventCache.clear();
          this._refMap.clear();
          this._needsFullCatchUp = true;
          if (this._currentContextRoomId) {
            const conn = this._connections.get(this._currentContextRoomId);
            if (conn) {
              const self = conn.room.listParticipants().find((p) => p.id === this._participantId);
              if (self) {
                conn.channel.emit(createEvent<ContextCompactedEvent>({
                  type: "ContextCompacted",
                  category: "ACTIVITY",
                  room_id: this._currentContextRoomId,
                  participant_id: this._participantId,
                  participant: self,
                })).catch(() => {});
              }
            }
          }
        },
        identity: `🤖 ${this._participantName}${this._options.selfIdentifier ? ` (@${this._options.selfIdentifier})` : ""}`,
        autoCompactPct: this._options.autoCompactPct,
        drainEventQueue: () => this._drainInjectBuffer(),
      },
    );
    await this._session.start();

    // Startup — inject full catch-up across all rooms so the stoop is oriented immediately
    if (this._connections.size > 0) {
      await this._processRaw(
        await this._buildFullCatchUp(),
        this._connections.values().next().value?.room.roomId ?? null,
      );
    }

    // Main event loop — reads from multiplexer
    for await (const labeled of this._multiplexer) {
      if (this._stopped) break;
      await this._handleLabeledEvent(labeled);
    }
  }

  async stop(): Promise<void> {
    this._stopped = true;
    await this._session?.stop();
    this._multiplexer.close();
    // Disconnect all channels silently
    await Promise.allSettled(
      [...this._connections.values()].map((conn) => conn.channel.disconnect(true)),
    );
    this._connections.clear();
    this._nameToId.clear();
    this._identifierToId.clear();
    this._contentBuffer.clear();
    this._lastMessages.clear();
    this._seenEventIds.clear();
    this._seenEventCache.clear();
    this._refMap.clear();
  }

  // ── Log ───────────────────────────────────────────────────────────────────

  getLog(): RoomEvent[] {
    return this._log;
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private async _handleLabeledEvent(labeled: LabeledEvent): Promise<void> {
    // Dedup guard — skip if we've already processed this event ID
    if (this._seenEventIds.has(labeled.event.id)) return;
    this._seenEventIds.add(labeled.event.id);
    if (this._seenEventIds.size > 500) this._seenEventIds.clear();

    const { roomId, event } = labeled;

    // Resolve sender type for classification
    const conn = this._connections.get(roomId);
    // For Mentioned events, look up the actual sender (not the mentioned person)
    const senderLookupId =
      event.type === "Mentioned"
        ? (event as { message: { sender_id: string } }).message.sender_id
        : event.participant_id;
    const sender = conn?.room.listParticipants().find((p) => p.id === senderLookupId);
    const senderType: ParticipantType = sender?.type ?? "human";

    const disposition: EventDisposition = this._engagement.classify(event, roomId, this._participantId, senderType, senderLookupId);

    if (disposition === "drop") return;

    // Track in seen cache — prevents catch_up from re-showing events the LLM context already has
    this._seenEventCache.add(event.id);

    if (disposition === "content") {
      // Accumulate in buffer — no LLM evaluation yet
      const buf = this._contentBuffer.get(roomId) ?? [];
      buf.push({ event, roomId, roomName: labeled.roomName });
      this._contentBuffer.set(roomId, buf);
      return;
    }

    // disposition === "trigger"
    this._log.push(event);

    if (this._processing) {
      this._eventQueue.push(labeled);
      // Also push to inject buffer for mid-loop consumption by LangGraph backend
      this._formatForLLM(event, roomId, labeled.roomName).then((parts) => {
        if (parts) this._injectBuffer.push(parts);
      }).catch((err) => {
        console.error(`[${this._participantName}] inject buffer format error:`, err);
      });
      return;
    }

    await this._processTrigger(labeled);

    // Drain queued events as a batch
    while (this._eventQueue.length > 0) {
      const queued = this._eventQueue;
      this._eventQueue = [];

      const formatted: ContentPart[][] = [];
      let batchContextRoom: string | null = null;
      const roomsProcessed = new Set<string>();

      for (const qe of queued) {
        const qConn = this._connections.get(qe.roomId);
        const qSenderLookupId =
          qe.event.type === "Mentioned"
            ? (qe.event as MentionedEvent).message.sender_id
            : qe.event.participant_id;
        const qSender = qConn?.room.listParticipants().find((p) => p.id === qSenderLookupId);
        const qSenderType: ParticipantType = qSender?.type ?? "human";
        const qDisposition = this._engagement.classify(qe.event, qe.roomId, this._participantId, qSenderType, qSenderLookupId);

        if (qDisposition === "drop") continue;

        // Flush content buffer for this room once when the first trigger from it appears in the batch
        if (!roomsProcessed.has(qe.roomId)) {
          roomsProcessed.add(qe.roomId);
          const buffered = this._contentBuffer.get(qe.roomId) ?? [];
          this._contentBuffer.delete(qe.roomId);
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
        const batchParts: ContentPart[] = [
          { type: "text", text: "While you were responding, this happened:\n" },
          ...mergeParts(formatted),
        ];
        await this._processRaw(batchParts, batchContextRoom);
      }
    }
  }

  private async _processTrigger(labeled: LabeledEvent): Promise<void> {
    const { roomId, roomName, event } = labeled;

    // Flush and format content buffer for this room
    const buffered = this._contentBuffer.get(roomId) ?? [];
    this._contentBuffer.delete(roomId);

    const contentPartArrays: ContentPart[][] = [];
    for (const item of buffered) {
      const parts = await this._formatForLLM(item.event, item.roomId, item.roomName);
      if (parts) contentPartArrays.push(parts);
    }

    // Cache lastMessage if trigger is a MessageSent
    if (event.type === "MessageSent") {
      const conn = this._connections.get(roomId);
      const senderLabel = conn?.room.listParticipants().find((p) => p.id === event.message.sender_id)?.name ?? event.message.sender_name;
      const contentPreview = event.message.content.length > 60 ? event.message.content.slice(0, 57) + "..." : event.message.content;
      const preview = event.message.image_url && !event.message.content.trim()
        ? "sent an image"
        : contentPreview;
      this._lastMessages.set(roomId, `${senderLabel}: ${preview}`);
    }

    // Format trigger event
    const triggerParts = await this._formatForLLM(event, roomId, roomName);
    if (!triggerParts && contentPartArrays.length === 0) return;

    const mergedParts = mergeParts([...contentPartArrays, ...(triggerParts ? [triggerParts] : [])]);
    await this._processRaw(mergedParts, roomId);
  }

  // ── Formatting helpers ────────────────────────────────────────────────────

  private _resolveParticipantForRoom(roomId: string): (id: string) => Participant | null {
    return (id: string) => {
      const conn = this._connections.get(roomId);
      if (!conn) return null;
      return conn.room.listParticipants().find((p) => p.id === id) ?? null;
    };
  }

  private async _resolveReplyContext(
    event: RoomEvent,
    roomId: string,
  ): Promise<{ senderName: string; content: string } | null> {
    if (event.type !== "MessageSent" && event.type !== "Mentioned") return null;
    const msg = event.message;
    if (!msg.reply_to_id) return null;
    const conn = this._connections.get(roomId);
    if (!conn) return null;
    const repliedTo = await conn.room.getMessage(msg.reply_to_id);
    return repliedTo ? { senderName: repliedTo.sender_name, content: repliedTo.content } : null;
  }

  private async _resolveReactionTarget(
    event: RoomEvent,
    roomId: string,
  ): Promise<{ senderName: string; content: string; isSelf: boolean } | null> {
    if (event.type !== "ReactionAdded") return null;
    const conn = this._connections.get(roomId);
    if (!conn) return null;
    const target = await conn.room.getMessage(event.message_id);
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

  // ── LLM processing ───────────────────────────────────────────────────────

  private async _processRaw(
    parts: ContentPart[],
    contextRoomId: string | null,
  ): Promise<void> {
    // Pre-query hook — skip evaluation if it returns false (e.g. credit cap reached)
    if (this._options.preQuery && !(await this._options.preQuery())) {
      return;
    }

    this._processing = true;
    this._currentContextRoomId = contextRoomId;

    try {
      await this._session!.process(parts);
    } catch (err) {
      console.error(`[${this._participantName}] error:`, err);
    } finally {
      this._currentContextRoomId = null;
      this._processing = false;

      // If compaction happened during this query, inject fresh full catch-up before anything else
      if (this._needsFullCatchUp && !this._stopped) {
        this._needsFullCatchUp = false;
        await this._processRaw(
          await this._buildFullCatchUp(),
          this._connections.values().next().value?.room.roomId ?? null,
        );
      }

      // Drain pending notifications
      while (this._pendingNotifications.length > 0 && !this._stopped) {
        const next = this._pendingNotifications.shift()!;
        await this._processRaw(next.parts, next.contextRoomId);
      }
    }
  }
}
