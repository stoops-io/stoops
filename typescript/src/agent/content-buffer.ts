/** Per-room content buffer — accumulates events between triggers. */

import type { RoomEvent } from "../core/events.js";

export interface BufferedContent {
  event: RoomEvent;
  roomId: string;
  roomName: string;
}

export class ContentBuffer {
  private _buffer = new Map<string, BufferedContent[]>();

  push(roomId: string, item: BufferedContent): void {
    const buf = this._buffer.get(roomId) ?? [];
    buf.push(item);
    this._buffer.set(roomId, buf);
  }

  flush(roomId: string): BufferedContent[] {
    const items = this._buffer.get(roomId) ?? [];
    this._buffer.delete(roomId);
    return items;
  }

  delete(roomId: string): void {
    this._buffer.delete(roomId);
  }

  clear(): void {
    this._buffer.clear();
  }
}
