/**
 * RoomDataSource — abstraction over room data access.
 *
 * Allows tool handlers and EventProcessor to work against either a local
 * Room object or a remote HTTP API. This is the critical enabler for
 * client-side agent runtimes that connect to remote stoop servers.
 */

import type { Room } from "../core/room.js";
import type { Channel } from "../core/channel.js";
import type { RoomEvent } from "../core/events.js";
import type { EventCategory, Message, PaginatedResult, Participant } from "../core/types.js";

/**
 * Uniform interface for reading/writing room data.
 *
 * Implemented by:
 * - `LocalRoomDataSource` — wraps a Room + Channel for in-process access
 * - `RemoteRoomDataSource` — wraps HTTP calls to a stoop server (Phase 5)
 */
export interface RoomDataSource {
  readonly roomId: string;

  listParticipants(): Participant[];
  getMessage(id: string): Promise<Message | null>;
  searchMessages(query: string, limit?: number, cursor?: string | null): Promise<PaginatedResult<Message>>;
  getMessages(limit?: number, cursor?: string | null): Promise<PaginatedResult<Message>>;
  getEvents(category?: EventCategory | null, limit?: number, cursor?: string | null): Promise<PaginatedResult<RoomEvent>>;
  sendMessage(content: string, replyToId?: string, image?: { url: string; mimeType: string; sizeBytes: number } | null): Promise<Message>;
  emitEvent?(event: RoomEvent): Promise<void>;
}

/**
 * LocalRoomDataSource — wraps a Room + Channel for in-process access.
 *
 * Used by app-path consumers (ClaudeSession, LangGraphSession) and the
 * CLI server's EventProcessor. Transparent — all calls delegate directly
 * to the Room and Channel.
 */
export class LocalRoomDataSource implements RoomDataSource {
  constructor(
    private _room: Room,
    private _channel: Channel,
  ) {}

  get roomId(): string {
    return this._room.roomId;
  }

  /** Direct access to the underlying Room (for backward compat / internal use). */
  get room(): Room {
    return this._room;
  }

  /** Direct access to the underlying Channel (for backward compat / internal use). */
  get channel(): Channel {
    return this._channel;
  }

  listParticipants(): Participant[] {
    return this._room.listParticipants();
  }

  async getMessage(id: string): Promise<Message | null> {
    return this._room.getMessage(id);
  }

  async searchMessages(query: string, limit = 10, cursor: string | null = null): Promise<PaginatedResult<Message>> {
    return this._room.searchMessages(query, limit, cursor);
  }

  async getMessages(limit = 30, cursor: string | null = null): Promise<PaginatedResult<Message>> {
    return this._room.listMessages(limit, cursor);
  }

  async getEvents(category: EventCategory | null = null, limit = 50, cursor: string | null = null): Promise<PaginatedResult<RoomEvent>> {
    return this._room.listEvents(category, limit, cursor);
  }

  async sendMessage(content: string, replyToId?: string, image?: { url: string; mimeType: string; sizeBytes: number } | null): Promise<Message> {
    return this._channel.sendMessage(content, replyToId, image ?? undefined);
  }

  async emitEvent(event: RoomEvent): Promise<void> {
    await this._channel.emit(event);
  }
}
