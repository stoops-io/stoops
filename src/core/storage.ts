/**
 * Storage protocol and reference implementations for stoops rooms.
 *
 * # Implementing StorageProtocol
 *
 * Provide your own implementation to persist messages and events to a real
 * database. Pass it to `new Room(roomId, myStorage)`.
 *
 * Pagination contract (applies to all paginated methods):
 * - Results are returned newest-first.
 * - `cursor` is the ID of the last item on the previous page (exclusive).
 *   Pass `null` to start from the most recent.
 * - `next_cursor` in the result is the cursor to pass for the next (older) page.
 * - `has_more` is true if there are older items beyond the current page.
 *
 * @example
 * // Minimal Postgres implementation sketch:
 * class PostgresStorage implements StorageProtocol {
 *   async addMessage(message) {
 *     await db.query("INSERT INTO messages ...", [message]);
 *     return message;
 *   }
 *   async getMessage(room_id, message_id) {
 *     return db.query("SELECT * FROM messages WHERE id = $1", [message_id]);
 *   }
 *   async getMessages(room_id, limit = 30, cursor = null) {
 *     // Fetch `limit` messages before `cursor`, newest-first
 *     const rows = await db.query("...");
 *     return { items: rows, next_cursor: ..., has_more: ... };
 *   }
 *   async searchMessages(room_id, query, limit = 10, cursor = null) {
 *     // Full-text search, newest-first
 *   }
 *   async addEvent(event) {
 *     await db.query("INSERT INTO events ...", [event]);
 *   }
 *   async getEvents(room_id, category = null, limit = 50, cursor = null) {
 *     // Optional category filter, newest-first
 *   }
 * }
 */

import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RoomEvent } from "./events.js";
import type { EventCategory, Message, PaginatedResult } from "./types.js";

// ── StorageProtocol ───────────────────────────────────────────────────────────

/**
 * Persistence interface for a room's messages and events.
 *
 * Implement this to back rooms with a real database. The reference
 * `InMemoryStorage` is suitable for testing and single-process local use.
 *
 * All methods operate on a single `room_id` — one storage instance is shared
 * across all rooms (the `room_id` partitions the data).
 */
export interface StorageProtocol {
  /**
   * Persist a message and return it (with any server-assigned fields set).
   * Called automatically by `Channel.sendMessage()`.
   */
  addMessage(message: Message): Promise<Message>;

  /**
   * Look up a single message by ID. Returns null if not found.
   * Used by agents when resolving reply context and message refs.
   */
  getMessage(room_id: string, message_id: string): Promise<Message | null>;

  /**
   * Paginate messages for a room, newest-first.
   *
   * `cursor` — the `id` of the last message on the previous page (exclusive).
   *            Pass null to start from the most recent message.
   */
  getMessages(
    room_id: string,
    limit?: number,
    cursor?: string | null,
  ): Promise<PaginatedResult<Message>>;

  /**
   * Full-text search across message content, newest-first.
   *
   * `query`  — keyword or phrase to search for (case-insensitive).
   * `cursor` — pagination cursor (same semantics as `getMessages`).
   */
  searchMessages(
    room_id: string,
    query: string,
    limit?: number,
    cursor?: string | null,
  ): Promise<PaginatedResult<Message>>;

  /**
   * Persist a room event. Called for every event that passes through the room.
   * Events are append-only — never updated or deleted.
   */
  addEvent(event: RoomEvent): Promise<void>;

  /**
   * Paginate events for a room, newest-first.
   *
   * `category` — optional filter (e.g. EventCategory.MESSAGE). Pass null for all.
   * `cursor`   — pagination cursor (index-based for events).
   */
  getEvents(
    room_id: string,
    category?: EventCategory | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<PaginatedResult<RoomEvent>>;
}

// ── Pagination helpers (used by InMemoryStorage) ──────────────────────────────

/**
 * Paginate an array by item ID cursor, returning results newest-first.
 * Items are assumed to be stored oldest-first (append order).
 *
 * @internal
 */
export function paginate<T>(
  items: T[],
  limit: number,
  cursor: string | null | undefined,
  key: (item: T) => string,
): PaginatedResult<T> {
  let subset: T[];

  if (cursor != null) {
    const cursorIdx = items.findIndex((item) => key(item) === cursor);
    if (cursorIdx === -1) {
      return { items: [], next_cursor: null, has_more: false };
    }
    subset = items.slice(0, cursorIdx);
  } else {
    subset = items;
  }

  const page =
    limit < subset.length ? subset.slice(-limit) : subset.slice();
  page.reverse();
  const has_more = subset.length > limit;
  const next_cursor = has_more && page.length > 0 ? key(page[page.length - 1]) : null;

  return { items: page, next_cursor, has_more };
}

/**
 * Paginate an array by positional index cursor, returning results newest-first.
 * Used for events, which don't have stable IDs suitable for ID-based cursors.
 *
 * @internal
 */
export function paginateByIndex<T>(
  items: T[],
  limit: number,
  cursor: string | null | undefined,
): PaginatedResult<T> {
  const parsedCursor = cursor != null ? parseInt(cursor, 10) : items.length;
  const endIdx = Number.isNaN(parsedCursor) ? items.length : parsedCursor;
  const startIdx = Math.max(0, endIdx - limit);
  const page = items.slice(startIdx, endIdx).reverse();
  const has_more = startIdx > 0;
  const next_cursor = has_more ? String(startIdx) : null;

  return { items: page, next_cursor, has_more };
}

// ── InMemoryStorage ───────────────────────────────────────────────────────────

/**
 * Reference in-memory implementation of `StorageProtocol`.
 *
 * Suitable for tests, development, and single-process local use. All data is
 * lost on process restart — not for production.
 *
 * One instance can serve multiple rooms (data is partitioned by `room_id`).
 */
export class InMemoryStorage implements StorageProtocol {
  protected _messages = new Map<string, Message[]>();
  protected _events = new Map<string, RoomEvent[]>();

  async addMessage(message: Message): Promise<Message> {
    const list = this._messages.get(message.room_id) ?? [];
    list.push(message);
    this._messages.set(message.room_id, list);
    return message;
  }

  async getMessage(room_id: string, message_id: string): Promise<Message | null> {
    const list = this._messages.get(room_id) ?? [];
    return list.find((m) => m.id === message_id) ?? null;
  }

  async getMessages(
    room_id: string,
    limit = 30,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const messages = this._messages.get(room_id) ?? [];
    return paginate(messages, limit, cursor, (m) => m.id);
  }

  async searchMessages(
    room_id: string,
    query: string,
    limit = 10,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const messages = this._messages.get(room_id) ?? [];
    const q = query.toLowerCase();
    const filtered = messages.filter((m) =>
      m.content.toLowerCase().includes(q),
    );
    return paginate(filtered, limit, cursor, (m) => m.id);
  }

  async addEvent(event: RoomEvent): Promise<void> {
    const list = this._events.get(event.room_id) ?? [];
    list.push(event);
    this._events.set(event.room_id, list);
  }

  async getEvents(
    room_id: string,
    category: EventCategory | null = null,
    limit = 50,
    cursor: string | null = null,
  ): Promise<PaginatedResult<RoomEvent>> {
    let events = this._events.get(room_id) ?? [];
    if (category != null) {
      events = events.filter((e) => e.category === category);
    }
    return paginateByIndex(events, limit, cursor);
  }
}

// ── FileBackedStorage ─────────────────────────────────────────────────────────

/**
 * In-memory storage that persists to a JSON file on every write.
 *
 * Use `FileBackedStorage.load(path)` to restore from an existing file,
 * or `new FileBackedStorage(path)` to start fresh and save to that path.
 */
export class FileBackedStorage extends InMemoryStorage {
  private _filePath: string;

  constructor(filePath: string) {
    super();
    this._filePath = resolve(filePath);
  }

  async addMessage(message: Message): Promise<Message> {
    const result = await super.addMessage(message);
    await this._flush();
    return result;
  }

  async addEvent(event: RoomEvent): Promise<void> {
    await super.addEvent(event);
    await this._flush();
  }

  private async _flush(): Promise<void> {
    const data: Record<string, { messages: Message[]; events: RoomEvent[] }> = {};
    for (const [roomId, messages] of this._messages) {
      if (!data[roomId]) data[roomId] = { messages: [], events: [] };
      data[roomId].messages = messages;
    }
    for (const [roomId, events] of this._events) {
      if (!data[roomId]) data[roomId] = { messages: [], events: [] };
      data[roomId].events = events;
    }
    await writeFile(this._filePath, JSON.stringify(data, null, 2));
  }

  /** Load an existing file and return a FileBackedStorage that continues saving to it. */
  static async load(filePath: string): Promise<FileBackedStorage> {
    const storage = new FileBackedStorage(filePath);
    const raw = await readFile(storage._filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, { messages: Message[]; events: RoomEvent[] }>;

    for (const [roomId, { messages, events }] of Object.entries(data)) {
      storage._messages.set(
        roomId,
        messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
      );
      storage._events.set(
        roomId,
        events.map((e) => rehydrateEvent(e)),
      );
    }

    return storage;
  }
}

/** Rehydrate Date fields that became ISO strings during JSON serialization. */
function rehydrateEvent(e: RoomEvent): RoomEvent {
  const event = { ...e, timestamp: new Date(e.timestamp) } as RoomEvent;
  // Events that embed a full Message need their nested timestamp rehydrated too
  if ("message" in event && event.message) {
    event.message = { ...event.message, timestamp: new Date(event.message.timestamp) };
  }
  return event;
}
