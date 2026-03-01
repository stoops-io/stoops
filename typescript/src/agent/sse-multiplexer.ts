/**
 * SseMultiplexer — merges N SSE connections into one labeled event stream.
 *
 * Each connection is an HTTP fetch to a stoop server's /events endpoint.
 * Events are parsed from the SSE `data:` lines and wrapped as LabeledEvents
 * (same shape as EventMultiplexer output so EventProcessor can consume either).
 *
 * Connections can be added/removed while the multiplexer is running.
 * Each connection has its own AbortController for independent lifecycle.
 */

import type { RoomEvent } from "../core/events.js";
import type { LabeledEvent } from "./multiplexer.js";

interface SseConnection {
  serverUrl: string;
  sessionToken: string;
  roomName: string;
  roomId: string;
  abortController: AbortController;
  loopPromise: Promise<void>;
}

export class SseMultiplexer {
  private _queue: LabeledEvent[] = [];
  private _waiters: Array<{ resolve: (value: LabeledEvent) => void }> = [];
  private _connections = new Map<string, SseConnection>();
  private _closed = false;

  /**
   * Add an SSE connection to a stoop server.
   * Starts streaming events immediately.
   */
  addConnection(serverUrl: string, sessionToken: string, roomName: string, roomId: string): void {
    if (this._connections.has(roomId) || this._closed) return;

    const abortController = new AbortController();
    const loopPromise = this._sseLoop(serverUrl, sessionToken, roomName, roomId, abortController.signal);
    this._connections.set(roomId, { serverUrl, sessionToken, roomName, roomId, abortController, loopPromise });
  }

  /** Remove a connection by room ID. */
  removeConnection(roomId: string): void {
    const entry = this._connections.get(roomId);
    if (!entry) return;
    entry.abortController.abort();
    this._connections.delete(roomId);
  }

  /** Close all connections and signal the iterator to finish. */
  close(): void {
    this._closed = true;
    for (const [, entry] of this._connections) {
      entry.abortController.abort();
    }
    this._connections.clear();

    // Resolve all pending waiters so the iterator returns done
    for (const waiter of this._waiters) {
      waiter.resolve(null as unknown as LabeledEvent);
    }
    this._waiters = [];
  }

  private async _sseLoop(
    serverUrl: string,
    sessionToken: string,
    roomName: string,
    roomId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const INITIAL_BACKOFF = 1000;
    const MAX_BACKOFF = 30000;
    let backoff = INITIAL_BACKOFF;

    while (!signal.aborted && !this._closed) {
      try {
        // POST required — Cloudflare Quick Tunnels buffer GET streaming
        // responses and only flush on connection close. POST streams in real-time.
        const res = await fetch(`${serverUrl}/events`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${sessionToken}`,
          },
          signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        // Connected — reset backoff
        backoff = INITIAL_BACKOFF;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE: split on double newline
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // keep incomplete chunk

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as RoomEvent;
              this._push({ roomId, roomName, event });
            } catch {
              // Malformed event — skip
            }
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        // Connection failed or dropped — backoff and retry
      }

      if (!signal.aborted && !this._closed) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      }
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
