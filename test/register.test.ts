//! POST /register — the drop_pending_updates guard, the key gate, and the
//! state import.

import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { handleRegister } from "../src/register";
import type { UnpinBot } from "../src/bot";
import { fakeD1 } from "./fake-d1";
import type { FakeD1 } from "./fake-d1";

const ADMIN_KEY = "adm";

interface WebhookOptions {
  drop_pending_updates: boolean;
  secret_token: string;
  allowed_updates: string[];
}

interface Registered {
  setWebhook: Mock<(url: string, options: WebhookOptions) => Promise<boolean>>;
  status: number;
  report: Record<string, unknown>;
}

function env(db: D1Database): Env {
  return {
    TELOXIDE_TOKEN: "0:t",
    WEBHOOK_SECRET: "hook",
    ADMIN_KEY,
    DB: db,
  } as unknown as Env;
}

/** Runs /register against a fake D1 and a bot recording its API calls. */
async function register(
  query = "",
  init: { key?: string; body?: string; fake?: FakeD1 } = {},
): Promise<Registered> {
  const fake = init.fake ?? fakeD1();
  const setWebhook: Mock<(url: string, options: WebhookOptions) => Promise<boolean>> =
    vi.fn(async () => true);
  // Every other Bot API method register touches (default rights, the
  // per-language menus and descriptions) is a no-op — but a real one: a
  // missing method would surface as a failure in the report below.
  const api = new Proxy({ setWebhook } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : async () => true),
  });
  const unpin = {
    bot: { botInfo: { id: 1, username: "unpinbot" }, api },
    ensureInit: async () => {},
  } as unknown as UnpinBot;

  const response = await handleRegister(
    new Request(`https://bot.example/register${query}`, {
      method: "POST",
      headers: { "X-Register-Key": init.key ?? ADMIN_KEY },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    env(fake.db),
    unpin,
  );
  const text = await response.text();
  let report: Record<string, unknown> = {};
  // The 403 gate answers plain text, so the parse has to survive it.
  try {
    report = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // left empty; the status is the assertion for a rejected request
  }
  return { setWebhook, status: response.status, report };
}

describe("POST /register", () => {
  it("completes every setup step", async () => {
    const { status, report } = await register();
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(status).toBe(200);
  });

  it("keeps the pending-update queue by default", async () => {
    const { setWebhook, report } = await register();
    expect(setWebhook.mock.calls[0]![1].drop_pending_updates).toBe(false);
    expect(report.drop_pending).toBe(false);
  });

  it("drops the queue only on the exact opt-in", async () => {
    // Anything short of ?drop_pending=1 keeps the queue: this flag
    // discards queued auto-forwards, whose posts would stay pinned forever.
    for (const query of ["?drop_pending=1", "?drop_pending=true", "?drop_pending", ""]) {
      const { setWebhook, report } = await register(query);
      expect(setWebhook.mock.calls[0]![1].drop_pending_updates, query).toBe(
        query === "?drop_pending=1",
      );
      expect(report.drop_pending, query).toBe(query === "?drop_pending=1");
    }
  });

  it("points the webhook at its own origin with the secret token", async () => {
    const { setWebhook, report } = await register();
    expect(setWebhook.mock.calls[0]![0]).toBe("https://bot.example/tg");
    expect(setWebhook.mock.calls[0]![1].secret_token).toBe("hook");
    expect(report.webhook).toBe("https://bot.example/tg");
  });

  it("refuses a wrong or missing register key", async () => {
    expect((await register("", { key: "wrong" })).status).toBe(403);
    expect((await register("", { key: "" })).status).toBe(403);
  });

  it("imports an old state.json verbatim, idempotently", async () => {
    const fake = fakeD1();
    const body = JSON.stringify({ enabled_chats: [-100, 42] });
    const first = await register("", { body, fake });
    expect(first.report.imported).toBe(2);
    expect(fake.rows.has(-100)).toBe(true);
    const second = await register("", { body, fake });
    expect(second.report.imported).toBe(2);
    expect(fake.rows.size).toBe(2);
  });
});
