//! Worker entry: webhook at POST /tg, one-shot setup at POST /register.

import { webhookCallback } from "grammy";

import { createBot } from "./bot";
import type { UnpinBot } from "./bot";
import { handleRegister } from "./register";
import { keysMatch } from "./secret";

// One bot per isolate; env identity guards the cache against any
// environment swap. Both bindings and secrets are immutable per version,
// so caching across requests of the same version is safe.
let boot: { env: Env; unpin: UnpinBot } | null = null;
function bootFor(env: Env): UnpinBot {
  if (boot === null || boot.env !== env) {
    boot = { env, unpin: createBot(env) };
  }
  return boot.unpin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const unpin = bootFor(env);

    if (pathname === "/tg" && request.method === "POST") {
      // Trust-boundary check first: wrong senders are rejected before any
      // Telegram round trip (grammY re-verifies the header downstream).
      const given =
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!keysMatch(given, env.WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // getMe must have succeeded before any handler runs (command matching
      // needs botInfo). Failing the request here hands the update back to
      // Telegram, which redelivers it later — the webhook-native equivalent
      // of the Rust release refusing to start on a bad token.
      try {
        await unpin.ensureInit();
      } catch (err) {
        console.error(`getMe failed: ${err}`);
        return new Response("Bot identity unavailable", { status: 503 });
      }
      return webhookCallback(unpin.bot, "cloudflare-mod", {
        secretToken: env.WEBHOOK_SECRET,
        // Matches the Rust release's REQUEST_TIMEOUT: long enough for
        // withRetry to sleep out a flood-wait inside this request.
        timeoutMilliseconds: 30_000,
      })(request);
    }

    if (pathname === "/register" && request.method === "POST") {
      return handleRegister(request, env, unpin);
    }

    return new Response("Not Found", { status: 404 });
  },
};
