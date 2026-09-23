//! Retry-budget tests — ported from the Rust release's with_retry suite.
//! Tokio's paused clock becomes vitest fake timers; the boundaries assert
//! the exact schedule (500 ms then 1000 ms, or Telegram's own flood-wait).

import { GrammyError, HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_ATTEMPTS, transientFailure, withRetry } from "../src/unpin";

function apiError(
  description: string,
  error_code = 400,
  parameters?: { retry_after?: number; migrate_to_chat_id?: number },
): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code, description, parameters },
    "testMethod",
    {},
  );
}

const flood = (): GrammyError =>
  apiError("Too Many Requests: retry after 5", 429, { retry_after: 5 });

/** Observes settlement without awaiting: the fake clock decides, so a wrong
 * backoff fails an assertion instead of hanging the test. */
function tracked<T>(p: Promise<T>): { isDone: () => boolean; p: Promise<T> } {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  return { isDone: () => done, p };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withRetry", () => {
  it("retries transient failures up to the attempt budget", async () => {
    let calls = 0;
    const t = tracked(
      withRetry(async () => {
        calls++;
        throw new TypeError("fetch failed");
      }),
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toBe(1);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // backoff[0] = 500 elapsed
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // backoff[1] = 1000 elapsed
    expect(calls).toBe(MAX_ATTEMPTS);
    await expect(t.p).rejects.toThrow("fetch failed");
    expect(t.isDone()).toBe(true);
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const t = tracked(
      withRetry(async () => {
        calls++;
        if (calls === 1) throw new TypeError("reset");
        return "ok";
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(true);
    await expect(t.p).resolves.toBe("ok");
  });

  it("does not retry permanent errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw apiError("Bad Request: chat not found");
      }),
    ).rejects.toThrow("chat not found");
    expect(calls).toBe(1);
  });

  it("retries Telegram gateway failures", async () => {
    let calls = 0;
    const t = tracked(
      withRetry(async () => {
        calls++;
        if (calls === 1) throw apiError("Bad Gateway");
        return 7;
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(true);
    await expect(t.p).resolves.toBe(7);
  });

  it("does not retry an unrecognized API description", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw apiError("Bad Request: nope");
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });

  it("sleeps out a flood-wait, sharing the attempt budget", async () => {
    let calls = 0;
    const t = tracked(
      withRetry(async () => {
        calls++;
        throw flood();
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(MAX_ATTEMPTS); // the demanded pause cannot loop forever
    await expect(t.p).rejects.toThrow();
    expect(t.isDone()).toBe(true);
  });

  it("waits exactly the demanded pause before the successful retry", async () => {
    let calls = 0;
    const t = tracked(
      withRetry(async () => {
        calls++;
        if (calls === 1) throw flood();
        return "ok";
      }),
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);
    expect(t.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(t.isDone()).toBe(true);
    await expect(t.p).resolves.toBe("ok");
  });
});

describe("transientFailure", () => {
  it("treats429s, gateway descriptions, and fetch failures as transient", () => {
    expect(transientFailure(flood())).toBe(true);
    expect(transientFailure(apiError("Bad Gateway"))).toBe(true);
    expect(transientFailure(apiError("Bad Request: Internal Server Error"))).toBe(true);
    expect(transientFailure(new TypeError("fetch failed"))).toBe(true);
  });

  it("treats ordinary Bot API errors and raw HTTP failures as permanent", () => {
    expect(transientFailure(apiError("Bad Request: nope"))).toBe(false);
    expect(transientFailure(new HttpError("502", new Error("bad")))).toBe(false);
  });
});
