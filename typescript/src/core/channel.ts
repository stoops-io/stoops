/**
 * Channel — a participant's bidirectional connection to a room.
 *
 * Created by `Room.connect()`. Never instantiated directly.
 *
 * # Sending
 * - `sendMessage()` — persist and broadcast a chat message
 * - `emit()`        — push non-message events (tool use, mode changes, etc.)
 *
 * # Receiving
 * Channels are async-iterable — use `for await (const event of channel)` to
 * consume events. Only events in the channel's `subscriptions` set are
 * delivered. Alternatively, use `receive(timeoutMs)` for polling with a
 * timeout (used by EventMultiplexer).
 *
 * # Lifecycle
 * - `updateSubscriptions()` — change which EventCategories are delivered
 * - `disconnect(silent?)`   — leave the room; pass `true` to suppress the
 *                             ParticipantLeft broadcast
 */

import type { RoomEvent } from "./events.js";
import type { EventCategory, Message } from "./types.js";
import { MessageSchema } from "./types.js";
import type { Room } from "./room.js";

interface Waiter {
  resolve: (event: RoomEvent) => void;
  reject: (err: Error) => void;
}

export class Channel {
  readonly participantId: string;
  readonly participantName: string;
  subscriptions: Set<EventCategory>;

  private _room: Room;
  private _queue: RoomEvent[] = [];
  private _waiters: Waiter[] = [];
  private _disconnected = false;

  constructor(
    room: Room,
    participantId: string,
    participantName: string,
    subscriptions: Set<EventCategory>,
  ) {
    this._room = room;
    this.participantId = participantId;
    this.participantName = participantName;
    this.subscriptions = subscriptions;
  }

  get roomId(): string {
    return this._room.roomId;
  }

  /**
   * Send a chat message from this participant.
   *
   * Persists the message to storage, broadcasts a `MessageSentEvent` to all
   * participants (including the sender), and fires `MentionedEvent` for any
   * `@name` or `@identifier` patterns found in the content.
   *
   * @param content    — message text (may be empty if image is provided)
   * @param replyToId  — ID of the message being replied to (optional)
   * @param image      — optional image attachment
   */
  async sendMessage(
    content: string,
    replyToId?: string | null,
    image?: {
      url: string;
      mimeType: string;
      sizeBytes: number;
    } | null,
  ): Promise<Message> {
    if (this._disconnected) {
      throw new Error("Channel is disconnected");
    }
    const message = MessageSchema.parse({
      room_id: this._room.roomId,
      sender_id: this.participantId,
      sender_name: this.participantName,
      content,
      reply_to_id: replyToId ?? null,
      image_url: image?.url ?? null,
      image_mime_type: image?.mimeType ?? null,
      image_size_bytes: image?.sizeBytes ?? null,
    });
    await this._room._handleMessage(message);
    return message;
  }

  /**
   * Emit a non-message activity event to the room.
   *
   * Use this for platform events: tool use indicators, mode changes, compaction
   * notices, etc. The event is persisted and broadcast to all subscribed
   * participants.
   */
  async emit(event: RoomEvent): Promise<void> {
    if (this._disconnected) {
      throw new Error("Channel is disconnected");
    }
    await this._room._handleEvent(event);
  }

  /**
   * Change which event categories this channel receives.
   * Takes effect immediately — buffered events from unsubscribed categories
   * are not retroactively removed.
   */
  updateSubscriptions(categories: Set<EventCategory>): void {
    this.subscriptions = categories;
  }

  /**
   * Leave the room.
   *
   * @param silent — if true, suppresses the `ParticipantLeft` broadcast.
   *                 Agents disconnect silently to avoid chat noise.
   */
  async disconnect(silent = false): Promise<void> {
    if (!this._disconnected) {
      this._disconnected = true;
      // Wake pending waiters so async iterators exit cleanly
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) {
        w.reject(new Error("Channel disconnected"));
      }
      await this._room._disconnectChannel(this, silent);
    }
  }

  /** @internal Called by Room to deliver an incoming event. Filters by subscription. */
  _deliver(event: RoomEvent): void {
    if (this._disconnected) return;
    if (!this.subscriptions.has(event.category)) return;

    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve(event);
    } else {
      this._queue.push(event);
    }
  }

  /**
   * Receive the next event, waiting up to `timeoutMs`.
   *
   * Returns null if no event arrives within the timeout. Drains buffered events
   * before waiting. Used by `EventMultiplexer` to fan-in events from multiple
   * rooms into a single stream.
   */
  receive(timeoutMs: number): Promise<RoomEvent | null> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift()!);
    }
    if (this._disconnected) {
      return Promise.resolve(null);
    }

    return new Promise<RoomEvent | null>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        resolve: (event) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(event);
          }
        },
        reject: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        },
      };
      this._waiters.push(waiter);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const idx = this._waiters.indexOf(waiter);
          if (idx !== -1) this._waiters.splice(idx, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /**
   * Async iterator — yields events as they arrive.
   *
   * Used by `EventMultiplexer` to fan-in all room channels into a single stream.
   * The iterator completes when the channel is disconnected.
   *
   * @example
   * for await (const event of channel) {
   *   console.log(event.type);
   * }
   */
  [Symbol.asyncIterator](): AsyncIterator<RoomEvent> {
    return {
      next: (): Promise<IteratorResult<RoomEvent>> => {
        if (this._queue.length > 0) {
          return Promise.resolve({
            value: this._queue.shift()!,
            done: false,
          });
        }

        if (this._disconnected) {
          return Promise.resolve({
            value: undefined as unknown as RoomEvent,
            done: true,
          });
        }

        return new Promise<IteratorResult<RoomEvent>>((resolve, reject) => {
          this._waiters.push({
            resolve: (event) => resolve({ value: event, done: false }),
            reject,
          });
        });
      },
    };
  }
}
