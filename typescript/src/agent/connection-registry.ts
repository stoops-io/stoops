/** Room connection registry — manages live room connections for an agent. */

import type { Room } from "../core/room.js";
import type { Channel } from "../core/channel.js";
import type { RoomDataSource } from "./room-data-source.js";
import type { RoomConnection } from "./types.js";

export interface InternalConnection extends RoomConnection {
  identifier?: string;
}

export class ConnectionRegistry {
  private _connections = new Map<string, InternalConnection>();
  private _nameToId = new Map<string, string>();
  private _identifierToId = new Map<string, string>();
  private _lastMessages = new Map<string, string>();

  add(roomId: string, conn: InternalConnection): void {
    this._connections.set(roomId, conn);
    this._nameToId.set(conn.name, roomId);
    if (conn.identifier) this._identifierToId.set(conn.identifier, roomId);
  }

  remove(roomId: string): InternalConnection | undefined {
    const conn = this._connections.get(roomId);
    if (!conn) return undefined;
    this._nameToId.delete(conn.name);
    if (conn.identifier) this._identifierToId.delete(conn.identifier);
    this._connections.delete(roomId);
    this._lastMessages.delete(roomId);
    return conn;
  }

  get(roomId: string): InternalConnection | undefined {
    return this._connections.get(roomId);
  }

  has(roomId: string): boolean {
    return this._connections.has(roomId);
  }

  resolve(roomName: string): RoomConnection | null {
    const roomId = this._nameToId.get(roomName);
    if (roomId) return this._connections.get(roomId) ?? null;
    const idFromIdentifier = this._identifierToId.get(roomName);
    if (idFromIdentifier) return this._connections.get(idFromIdentifier) ?? null;
    return this._connections.get(roomName) ?? null;
  }

  listAll(getModeForRoom: (roomId: string) => string): Array<{
    name: string;
    roomId: string;
    identifier?: string;
    mode: string;
    participantCount: number;
    lastMessage?: string;
  }> {
    return [...this._connections.entries()].map(([roomId, conn]) => ({
      name: conn.name,
      roomId,
      ...(conn.identifier ? { identifier: conn.identifier } : {}),
      mode: getModeForRoom(roomId),
      participantCount: conn.dataSource.listParticipants().length,
      ...(this._lastMessages.has(roomId) ? { lastMessage: this._lastMessages.get(roomId) } : {}),
    }));
  }

  setLastMessage(roomId: string, text: string): void {
    this._lastMessages.set(roomId, text);
  }

  entries(): IterableIterator<[string, InternalConnection]> {
    return this._connections.entries();
  }

  get size(): number {
    return this._connections.size;
  }

  clear(): void {
    this._connections.clear();
    this._nameToId.clear();
    this._identifierToId.clear();
    this._lastMessages.clear();
  }

  values(): IterableIterator<InternalConnection> {
    return this._connections.values();
  }
}
