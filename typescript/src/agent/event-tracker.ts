/** Deduplication and delivery tracking for event IDs. */

export class EventTracker {
  private _processedIds = new Set<string>();
  private _deliveredIds = new Set<string>();

  /** Returns true if this event was already processed (and adds it if not). */
  isDuplicate(id: string): boolean {
    if (this._processedIds.has(id)) return true;
    this._processedIds.add(id);
    if (this._processedIds.size > 500) {
      const arr = [...this._processedIds];
      this._processedIds = new Set(arr.slice(arr.length >> 1));
    }
    return false;
  }

  isDelivered(id: string): boolean {
    return this._deliveredIds.has(id);
  }

  markDelivered(id: string): void {
    this._deliveredIds.add(id);
  }

  markManyDelivered(ids: string[]): void {
    for (const id of ids) {
      this._deliveredIds.add(id);
      this._processedIds.add(id);
    }
  }

  clearDelivered(): void {
    this._deliveredIds.clear();
  }

  clearAll(): void {
    this._processedIds.clear();
    this._deliveredIds.clear();
  }
}
