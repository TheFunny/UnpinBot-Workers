//! Credential comparison — the gate in front of /tg and /register.

import { describe, expect, it } from "vitest";

import { keysMatch } from "../src/secret";

describe("keysMatch", () => {
  it("accepts an identical key and rejects any other", () => {
    expect(keysMatch("s3cret", "s3cret")).toBe(true);
    expect(keysMatch("s3cret", "s3creT")).toBe(false);
    expect(keysMatch("s3cret", "s3cre")).toBe(false);
    expect(keysMatch("s3cret", "s3cretx")).toBe(false);
    // prefix/extension: no early exit on the first differing byte
    expect(keysMatch("aXc", "abc")).toBe(false);
  });

  it("never authenticates an absent header", () => {
    expect(keysMatch("", "s3cret")).toBe(false);
  });

  it("never authenticates when the secret is unset or empty", () => {
    // An unset binding arrives as undefined at runtime even though Env
    // types it as string; encode(undefined) is empty, so both sides would
    // be the empty string and match.
    expect(keysMatch("s3cret", undefined as unknown as string)).toBe(false);
    expect(keysMatch("", undefined as unknown as string)).toBe(false);
    expect(keysMatch("", "")).toBe(false);
  });
});
