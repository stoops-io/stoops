/**
 * RemoteRoomDataSource — HTTP-backed RoomDataSource.
 *
 * Implements the RoomDataSource interface by making HTTP calls to a stoop
 * server. Used by the client-side agent runtime when connecting to remote
 * stoops.
 *
 * Participant list is cached locally and updated by the agent runtime
 * when it processes ParticipantJoined/Left events from the SSE stream.
 */

import type { RoomEvent } from "../core/events.js";
import type { EventCategory, Message, PaginatedResult, Participant } from "../core/types.js";
import type { RoomDataSource } from "./room-data-source.js";

export class RemoteRoomDataSource implements RoomDataSource {
  private _participants: Participant[] = [];
  private _selfId = "";
  private _selfName = "";

  constructor(
    private _serverUrl: string,
    private _sessionToken: string,
    private _roomId: string,
  ) {}

  /** Set own identity for populating outgoing message stubs. */
  setSelf(id: string, name: string): void {
    this._selfId = id;
    this._selfName = name;
  }

  get roomId(): string {
    return this._roomId;
  }

  get serverUrl(): string {
    return this._serverUrl;
  }

  get sessionToken(): string {
    return this._sessionToken;
  }

  // ── Participant cache ─────────────────────────────────────────────────────

  /** Set the initial participant list (from join response). */
  setParticipants(participants: Participant[]): void {
    this._participants = [...participants];
  }

  /** Add a participant (on ParticipantJoined event). */
  addParticipant(participant: Participant): void {
    // Remove any existing entry with same ID first
    this._participants = this._participants.filter((p) => p.id !== participant.id);
    this._participants.push(participant);
  }

  /** Remove a participant (on ParticipantLeft event). */
  removeParticipant(participantId: string): void {
    this._participants = this._participants.filter((p) => p.id !== participantId);
  }

  listParticipants(): Participant[] {
    return [...this._participants];
  }

  // ── HTTP-backed data access ───────────────────────────────────────────────

  async getMessage(id: string): Promise<Message | null> {
    try {
      const res = await fetch(
        `${this._serverUrl}/message/${encodeURIComponent(id)}?token=${this._sessionToken}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { message: Message };
      return data.message;
    } catch {
      return null;
    }
  }

  async searchMessages(
    query: string,
    limit = 10,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const params = new URLSearchParams({ token: this._sessionToken, query, count: String(limit) });
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await fetch(`${this._serverUrl}/search?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<Message>;
    } catch {
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async getMessages(
    limit = 30,
    cursor: string | null = null,
  ): Promise<PaginatedResult<Message>> {
    const params = new URLSearchParams({ token: this._sessionToken, count: String(limit) });
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await fetch(`${this._serverUrl}/messages?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<Message>;
    } catch {
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async getEvents(
    category: EventCategory | null = null,
    limit = 50,
    cursor: string | null = null,
  ): Promise<PaginatedResult<RoomEvent>> {
    const params = new URLSearchParams({ token: this._sessionToken, count: String(limit) });
    if (category) params.set("category", category);
    if (cursor) params.set("cursor", cursor);

    try {
      const res = await fetch(`${this._serverUrl}/events/history?${params}`);
      if (!res.ok) return { items: [], has_more: false, next_cursor: null };
      return (await res.json()) as PaginatedResult<RoomEvent>;
    } catch {
      return { items: [], has_more: false, next_cursor: null };
    }
  }

  async sendMessage(
    content: string,
    replyToId?: string,
    image?: { url: string; mimeType: string; sizeBytes: number } | null,
  ): Promise<Message> {
    const body: Record<string, unknown> = { token: this._sessionToken, content };
    if (replyToId) body.replyTo = replyToId;
    if (image) body.image = image;

    const res = await fetch(`${this._serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to send message: ${err}`);
    }

    const data = (await res.json()) as { ok: boolean; messageId: string };

    // Return a stub — the full message will arrive via SSE
    return {
      id: data.messageId,
      room_id: this._roomId,
      sender_id: this._selfId,
      sender_name: this._selfName,
      content,
      timestamp: new Date(),
    } as Message;
  }

  async emitEvent(event: RoomEvent): Promise<void> {
    const res = await fetch(`${this._serverUrl}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this._sessionToken, event }),
    });

    if (!res.ok) {
      // Best effort — don't throw for event emission failures
    }
  }
}
