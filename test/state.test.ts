//! State-module tests — ported from the Rust release's state.rs suite
//! against an in-memory D1 double (same set semantics, no file I/O).

import { describe, expect, it } from "vitest";

import { has, importChats, insert, remove, replace } from "../src/state";
import { fakeD1 } from "./fake-d1";

describe("enabled-chat state", () => {
  it("roundtrips inserts and removes", async () => {
    const { db, rows } = fakeD1();
    expect(await insert(db, -100123)).toBe(true);
    expect(await insert(db, 42)).toBe(true);
    expect(await insert(db, 42)).toBe(false); // second insert reports no change
    expect(await has(db, -100123)).toBe(true);
    expect(await has(db, 7)).toBe(false);
    expect(await remove(db, 42)).toBe(true);
    expect(await remove(db, 42)).toBe(false);
    expect(rows.has(42)).toBe(false);
  });

  it("replace moves the entry only when the old id was enabled", async () => {
    const { db, rows } = fakeD1();
    await insert(db, 1);
    await insert(db, 2);
    // {old, new} both enabled — a racing /enable on the upgraded id — the
    // old id leaving IS the change.
    expect(await replace(db, 1, 2)).toBe(true);
    expect(rows.has(1)).toBe(false);
    expect(await has(db, 2)).toBe(true);
    // Old id absent: nothing happens, the candidate new id stays untouched.
    expect(await replace(db, 1, 3)).toBe(false);
    expect(rows.has(3)).toBe(false);
  });

  it("a failed insert leaves the state untouched", async () => {
    const fake = fakeD1();
    fake.failInserts = true;
    await expect(insert(fake.db, 9)).rejects.toThrow("I/O error");
    expect(await has(fake.db, 9)).toBe(false);
  });

  it("imports the old state.json id list idempotently", async () => {
    const { db, rows } = fakeD1();
    await importChats(db, [-1001786359163, 42]);
    expect(await has(db, -1001786359163)).toBe(true);
    await importChats(db, [-1001786359163]); // re-running register is safe
    expect(await has(db, 42)).toBe(true);
    expect(rows.size).toBe(2);
    await importChats(db, []); // register without a body: no statements
  });
});
