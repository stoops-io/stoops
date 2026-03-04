/** Tests for RefMap — 4-digit decimal ref ↔ message UUID mapping. */

import { describe, test, expect } from "vitest";
import { RefMap } from "../src/agent/ref-map.js";

describe("RefMap", () => {
  test("assign returns a 4-digit string", () => {
    const refs = new RefMap();
    const ref = refs.assign("msg-001");
    expect(ref).toMatch(/^\d{4}$/);
  });

  test("assign is idempotent — same ID returns same ref", () => {
    const refs = new RefMap();
    const ref1 = refs.assign("msg-001");
    const ref2 = refs.assign("msg-001");
    expect(ref1).toBe(ref2);
  });

  test("assign returns different refs for different IDs", () => {
    const refs = new RefMap();
    const ref1 = refs.assign("msg-001");
    const ref2 = refs.assign("msg-002");
    expect(ref1).not.toBe(ref2);
  });

  test("resolve returns the original message ID", () => {
    const refs = new RefMap();
    const ref = refs.assign("msg-abc-def");
    expect(refs.resolve(ref)).toBe("msg-abc-def");
  });

  test("resolve returns undefined for unknown ref", () => {
    const refs = new RefMap();
    expect(refs.resolve("9999")).toBeUndefined();
  });

  test("clear resets all mappings", () => {
    const refs = new RefMap();
    const ref = refs.assign("msg-001");
    refs.clear();
    expect(refs.resolve(ref)).toBeUndefined();
  });

  test("clear allows re-assignment of same message ID to a new ref", () => {
    const refs = new RefMap();
    const ref1 = refs.assign("msg-001");
    refs.clear();
    const ref2 = refs.assign("msg-001");
    // After clear the counter resets randomly, so refs may differ
    // The important thing is both resolve correctly
    expect(refs.resolve(ref2)).toBe("msg-001");
    // ref1 should no longer resolve
    expect(refs.resolve(ref1)).toBeUndefined();
  });

  test("many assignments produce unique refs", () => {
    const refs = new RefMap();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const ref = refs.assign(`msg-${i}`);
      expect(seen.has(ref)).toBe(false);
      seen.add(ref);
    }
  });
});
