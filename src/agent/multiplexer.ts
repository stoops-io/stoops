/** EventMultiplexer — merges N channel async streams into one labeled stream. */

import type { RoomEvent } from "../core/events.js";
import type { Channel } from "../core/channel.js";

export interface LabeledEvent {
  roomId: string;
  roomName: string;
  event: RoomEvent;
}

interface ChannelEntry {
  channel: Channel;
  roomName: string;
  abortController: AbortController;
  loopPromise: Promise<void>;
}

/**
 * Merges events from multiple channels into a single async iterable stream.
 * Each event is labeled with its source room's ID and name.
 *
 * Channels can be added/removed while the multiplexer is running.
 */
export class EventMultiplexer {
  private _queue: LabeledEvent[] = [];
  private _waiters: Array<{ resolve: (value: LabeledEvent) => void }> = [];
  private _channels = new Map<string, ChannelEntry>();
  private _closed = false;
  private _closeResolve: (() => void) | null = null;

  addChannel(roomId: string, roomName: string, channel: Channel): void {
    if (this._channels.has(roomId) || this._closed) return;
    const abortController = new AbortController();
    const loopPromise = this._listenLoop(roomId, roomName, channel, abortController.signal);
    this._channels.set(roomId, { channel, roomName, abortController, loopPromise });
  }

  removeChannel(roomId: string): void {
    const entry = this._channels.get(roomId);
    if (!entry) return;
    entry.abortController.abort();
    this._channels.delete(roomId);
  }

  close(): void {
    this._closed = true;
    for (const [, entry] of this._channels) {
      entry.abortController.abort();
    }
    this._channels.clear();
    // Wake any pending iterator so it returns done
    if (this._closeResolve) {
      this._closeResolve();
      this._closeResolve = null;
    }
    // Resolve all waiters with a sentinel — they'll see done: true on next call
    for (const waiter of this._waiters) {
      // Push a dummy event — the iterator will check _closed on next call
      waiter.resolve(null as unknown as LabeledEvent);
    }
    this._waiters = [];
  }

  private async _listenLoop(
    roomId: string,
    roomName: string,
    channel: Channel,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of channel) {
        if (signal.aborted) break;
        this._push({ roomId, roomName, event });
      }
    } catch {
      // Channel disconnected — exit gracefully
    }
  }

  private _push(labeled: LabeledEvent): void {
    if (this._closed) return;
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!;
      waiter.resolve(labeled);
    } else {
      this._queue.push(labeled);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<LabeledEvent> {
    return {
      next: (): Promise<IteratorResult<LabeledEvent>> => {
        // Drain buffered events first
        if (this._queue.length > 0) {
          return Promise.resolve({ value: this._queue.shift()!, done: false });
        }

        if (this._closed) {
          return Promise.resolve({ value: undefined as unknown as LabeledEvent, done: true });
        }

        return new Promise<IteratorResult<LabeledEvent>>((resolve) => {
          this._waiters.push({
            resolve: (value) => {
              if (this._closed || value === null) {
                resolve({ value: undefined as unknown as LabeledEvent, done: true });
              } else {
                resolve({ value, done: false });
              }
            },
          });
        });
      },
    };
  }
}
