/**
 * Room — a shared chat space where humans and agents are all just participants.
 *
 * Transport-agnostic: no WebSockets, no HTTP. The caller owns the transport
 * and passes messages/events in via channels. This means the same Room works
 * identically in a CLI, a web server, or a test.
 *
 * # Connecting
 * Participants connect via `room.connect()`, which returns a `Channel`. The
 * channel is their bidirectional connection: they send messages and receive
 * events through it.
 *
 * # Observing
 * Call `room.observe()` to get a read-only-style channel that receives every
 * event in the room — including targeted @mention events directed at other
 * participants. Observers are NOT participants: they don't appear in
 * `listParticipants()` and don't trigger join/leave events.
 *
 * # @mention detection
 * When a message is sent, the Room scans its content for `@token` patterns and
 * fires a `MentionedEvent` for any participant whose `identifier` or display
 * `name` matches the token (case-insensitive). The mention event is delivered
 * to the mentioned participant AND to all observers.
 *
 * @example
 * const storage = new InMemoryStorage();
 * const room = new Room("room-1", storage);
 *
 * const aliceChannel = await room.connect("alice-id", "Alice");
 * const quinChannel  = await room.connect("quin-id", "Quin", "stoop", "quin");
 * const observer     = room.observe();
 *
 * await aliceChannel.sendMessage("hey @quin what do you think?");
 * // → MessageSentEvent broadcast to all participants + observer
 * // → MentionedEvent delivered to quinChannel + observer
 */

import { Channel } from "./channel.js";
import { createEvent } from "./events.js";
import type {
  MentionedEvent,
  MessageSentEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  RoomEvent,
} from "./events.js";
import { InMemoryStorage, type StorageProtocol } from "./storage.js";
import { EventCategory, type Message, type PaginatedResult, type Participant, type ParticipantType } from "./types.js";

const ALL_CATEGORIES = new Set<EventCategory>([
  EventCategory.MESSAGE,
  EventCategory.PRESENCE,
  EventCategory.ACTIVITY,
  EventCategory.MENTION,
]);

export class Room {
  readonly roomId: string;
  /** Direct access to the underlying storage. Useful for bulk reads. */
  readonly storage: StorageProtocol;
  private _channels = new Map<string, Channel>();
  private _participants = new Map<string, Participant>();
  private _observers = new Set<Channel>();
  private _nextObserverId = 0;

  /**
   * @param roomId  — stable identifier for this room (e.g. a UUID or slug)
   * @param storage — storage backend; defaults to `InMemoryStorage`
   */
  constructor(roomId: string, storage?: StorageProtocol) {
    this.roomId = roomId;
    this.storage = storage ?? new InMemoryStorage();
  }

  /**
   * Connect a participant and return their channel.
   *
   * @param participantId — stable unique ID for this participant
   * @param name          — display name (shown in messages and events)
   * @param type          — "human" (default) or "stoop" (agent)
   * @param identifier    — optional stable @-mention slug (e.g. "quinn").
   *                        Used for @-mention matching alongside the display name.
   *                        Unlike name, this should never change.
   * @param subscribe     — event categories to receive; defaults to all four
   * @param silent        — if true, suppresses the `ParticipantJoined` broadcast.
   *                        Use this for agents, observers, and reconnections where
   *                        you don't want to announce the join in chat.
   */
  async connect(
    participantId: string,
    name: string,
    type: ParticipantType = "human",
    identifier?: string,
    subscribe?: Set<EventCategory>,
    silent = false,
  ): Promise<Channel> {
    const participant: Participant = {
      id: participantId, name, status: "online", type,
      ...(identifier ? { identifier } : {}),
    };
    this._participants.set(participantId, participant);

    const subscriptions = subscribe ?? new Set(ALL_CATEGORIES);
    const channel = new Channel(this, participantId, name, subscriptions);
    this._channels.set(participantId, channel);

    if (!silent) {
      const event = createEvent<ParticipantJoinedEvent>({
        type: "ParticipantJoined",
        category: "PRESENCE",
        room_id: this.roomId,
        participant_id: participantId,
        participant,
      });
      await this._storeAndBroadcast(event, participantId);
    }

    return channel;
  }

  /**
   * Observe all room events without being a participant.
   *
   * Returns a channel that receives every event — broadcasts AND targeted
   * @mention events directed at other participants. Observers do NOT appear
   * in `listParticipants()` and do not emit join/leave presence events,
   * since they are not participants.
   *
   * Disconnect via `observer.disconnect()` when done.
   *
   * @example
   * const observer = room.observe();
   * for await (const event of observer) {
   *   // sees everything, including mentions for other participants
   * }
   */
  observe(): Channel {
    const id = `__obs_${this.roomId}_${this._nextObserverId++}`;
    const channel = new Channel(this, id, "__observer__", new Set(ALL_CATEGORIES));
    this._observers.add(channel);
    return channel;
  }

  // ── Read methods ───────────────────────────────────────────────────────────

  /**
   * Paginate messages, newest-first. Pass the returned `next_cursor` to get
   * the next (older) page.
   */
  async listMessages(
    limit = 30,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    return this.storage.getMessages(this.roomId, limit, cursor);
  }

  /**
   * Full-text search across message content, newest-first.
   * `query` is matched case-insensitively against message content.
   */
  async searchMessages(
    query: string,
    limit = 10,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    return this.storage.searchMessages(this.roomId, query, limit, cursor);
  }

  /** All currently connected participants (including agents). Observers excluded. */
  listParticipants(): Participant[] {
    return [...this._participants.values()];
  }

  /**
   * Paginate room events, newest-first.
   * `category` optionally filters to one EventCategory.
   */
  async listEvents(
    category: EventCategory | null = null,
    limit = 50,
    cursor: string | null = null,
  ): Promise<PaginatedResult<RoomEvent>> {
    return this.storage.getEvents(this.roomId, category, limit, cursor);
  }

  /** Look up a single message by ID. Returns null if not found. */
  async getMessage(id: string): Promise<Message | null> {
    return this.storage.getMessage(this.roomId, id);
  }

  // ── Internal methods (called by Channel) ──────────────────────────────────

  /**
   * @internal
   * Store a message, broadcast MessageSentEvent, and fire MentionedEvents.
   *
   * @mention scanning: looks for `@token` patterns in content and matches
   * against each connected participant's `identifier` and display `name`
   * (case-insensitive). Fires a `MentionedEvent` for each match, delivered
   * to the mentioned participant AND all observers.
   */
  async _handleMessage(message: Message): Promise<void> {
    await this.storage.addMessage(message);

    const event = createEvent<MessageSentEvent>({
      type: "MessageSent",
      category: "MESSAGE",
      room_id: this.roomId,
      participant_id: message.sender_id,
      message,
    });
    await this._storeAndBroadcast(event);

    const mentions = this._detectMentions(message.content);
    for (const mentionedId of mentions) {
      const ch = this._channels.get(mentionedId);
      if (ch) {
        const mentionEvent = createEvent<MentionedEvent>({
          type: "Mentioned",
          category: "MENTION",
          room_id: this.roomId,
          participant_id: mentionedId,
          message,
        });
        await this.storage.addEvent(mentionEvent);
        ch._deliver(mentionEvent);
        // Deliver mentions to all observers too
        for (const observer of this._observers) {
          observer._deliver(mentionEvent);
        }
      }
    }
  }

  /** @internal Store and broadcast an activity event. */
  async _handleEvent(event: RoomEvent): Promise<void> {
    await this._storeAndBroadcast(event, event.participant_id);
  }

  /** @internal Remove a channel and optionally broadcast ParticipantLeftEvent. */
  async _disconnectChannel(channel: Channel, silent = false): Promise<void> {
    // Observer channels are not participants — just remove from observer set
    if (this._observers.delete(channel)) {
      return;
    }

    const pid = channel.participantId;
    const participant = this._participants.get(pid);
    this._channels.delete(pid);
    this._participants.delete(pid);

    if (!silent && participant) {
      const event = createEvent<ParticipantLeftEvent>({
        type: "ParticipantLeft",
        category: "PRESENCE",
        room_id: this.roomId,
        participant_id: pid,
        participant,
      });
      await this._storeAndBroadcast(event);
    }
  }

  private async _storeAndBroadcast(
    event: RoomEvent,
    exclude?: string,
  ): Promise<void> {
    await this.storage.addEvent(event);
    this._broadcast(event, exclude);
  }

  private _broadcast(event: RoomEvent, exclude?: string): void {
    for (const [pid, channel] of this._channels) {
      if (pid !== exclude) {
        channel._deliver(event);
      }
    }
    for (const observer of this._observers) {
      observer._deliver(event);
    }
  }

  /**
   * Scan message content for `@token` patterns and return matching participant IDs.
   * Matches against both `identifier` (e.g. `@quinn`) and display `name` (e.g. `@Quinn`).
   * Case-insensitive. Deduplicates — each participant appears at most once.
   */
  private _detectMentions(content: string): string[] {
    const mentionedIds: string[] = [];
    const pattern = /@([a-zA-Z0-9_-]+)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const token = match[1].toLowerCase();
      for (const [pid, participant] of this._participants) {
        const matchesId = participant.identifier?.toLowerCase() === token;
        const matchesName = participant.name.toLowerCase() === token;
        if ((matchesId || matchesName) && !mentionedIds.includes(pid)) {
          mentionedIds.push(pid);
        }
      }
    }
    return mentionedIds;
  }
}
