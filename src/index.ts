//! Worker entry: webhook at POST /tg, one-shot setup at POST /register.

import { webhookCallback } from "grammy";

import { createBot } from "./bot";
import type { UnpinBot } from "./bot";
import { handleRegister } from "./register";
import { keysMatch } from "./secret";

// One bot per isolate, cached on the token it is built from. Bindings and
// secrets are immutable per version, so the token is the whole key. Nothing
// promises the same `env` object across requests, and a miss here costs a
// getMe round trip on every update — including the bot's own init cache.
let boot: { token: string; unpin: UnpinBot } | null = null;
function bootFor(env: Env): UnpinBot {
  if (boot === null || boot.token !== env.TELOXIDE_TOKEN) {
    boot = { token: env.TELOXIDE_TOKEN, unpin: createBot(env) };
  }
  return boot.unpin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/tg" && request.method === "POST") {
      // Trust-boundary check first: wrong senders are rejected before any
      // Telegram round trip (grammY re-verifies the header downstream).
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!keysMatch(given, env.WEBHOOK_SECRET)) {
        if (env.WEBHOOK_SECRET === undefined) {
          // keysMatch fails closed, so a 401 here with no header means the
          // secret was never set — say so instead of leaving an
          // unauthenticated loop that looks like a Telegram problem.
          console.error("WEBHOOK_SECRET is not set; run: wrangler secret put WEBHOOK_SECRET");
        }
        return new Response("Unauthorized", { status: 401 });
      }
      // Built here, not above the routing: a 404 or a rejected sender must
      // not cost a Bot instance, and the trust boundary stays first.
      const unpin = bootFor(env);
      // getMe must have succeeded before any handler runs (command
      // matching needs botInfo). Failing the request here hands the
      // update back to Telegram, which redelivers it later.
      try {
        await unpin.ensureInit();
      } catch (err) {
        console.error(`getMe failed: ${err}`);
        return new Response("Bot identity unavailable", { status: 503 });
      }
      return webhookCallback(unpin.bot, "cloudflare-mod", {
        secretToken: env.WEBHOOK_SECRET,
        // A ceiling, not a promise that the handler fits inside it: a
        // flood-wait sleep in withRetry overruns it deliberately, and the
        // resulting 5xx is what hands the update back to Telegram (see the
        // note on withRetry).
        timeoutMilliseconds: 30_000,
      })(request);
    }

    if (pathname === "/register" && request.method === "POST") {
      return handleRegister(request, env, bootFor(env));
    }

    // Liveness only, deliberately: no Telegram round trip and no D1 read,
    // so the answer says the Worker is serving and nothing more — an
    // uptime probe that keeps working when the token or the webhook
    // secret is misconfigured is the whole point.
    if (pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  },
};
