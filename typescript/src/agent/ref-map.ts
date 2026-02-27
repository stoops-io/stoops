/**
 * RefMap — bidirectional map between short decimal refs and full message UUIDs.
 *
 * Why 4 digits: a ref like #3847 tokenizes to 1–2 tokens in most LLMs, while a
 * raw UUID (a1b2c3d4-e5f6-...) burns 8–12 tokens for no benefit. Since refs
 * appear on every message in transcripts and tool output, the savings compound.
 *
 * 10,000 unique refs per cycle is far more than an LLM context window can hold
 * (a 200k-token window fits ~2000 messages at most). The map is cleared on every
 * context compaction, so overflow is essentially impossible in practice. If it
 * does happen, the fallback to a UUID-derived hash still works — just less tidy.
 *
 * Uses a linear congruential generator (n * 6337 mod 10000) to produce
 * non-sequential refs — gcd(6337, 10000) = 1 guarantees a full cycle through
 * all 10,000 values before any collision.
 *
 * @example
 * const refs = new RefMap();
 * const ref = refs.assign("msg-uuid-abc");  // "3847"
 * refs.assign("msg-uuid-abc");              // "3847" (idempotent)
 * refs.resolve("3847");                     // "msg-uuid-abc"
 * refs.clear();                             // reset on compaction
 */
export class RefMap {
  private _counter = Math.floor(Math.random() * 10000);
  private _refToId = new Map<string, string>();
  private _idToRef = new Map<string, string>();

  /** Assign a short ref to a message ID. Returns existing ref if already assigned. */
  assign(messageId: string): string {
    const existing = this._idToRef.get(messageId);
    if (existing) return existing;

    const ref = String((this._counter * 6337) % 10000).padStart(4, "0");
    this._counter++;

    if (this._refToId.has(ref)) {
      // Wrap-around (>10000 assignments without compaction — rare in practice).
      // Fall back to hex-derived ref.
      const fallback = messageId.replace(/-/g, "").slice(0, 4);
      this._refToId.set(fallback, messageId);
      this._idToRef.set(messageId, fallback);
      return fallback;
    }

    this._refToId.set(ref, messageId);
    this._idToRef.set(messageId, ref);
    return ref;
  }

  /** Resolve a ref back to the full message UUID. Returns undefined if unknown. */
  resolve(ref: string): string | undefined {
    return this._refToId.get(ref);
  }

  /** Clear all mappings and reset the counter. Called on context compaction. */
  clear(): void {
    this._refToId.clear();
    this._idToRef.clear();
    this._counter = Math.floor(Math.random() * 10000);
  }
}
