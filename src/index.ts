//! Worker entry: webhook at POST /tg, one-shot setup at POST /register.

import { webhookCallback } from "grammy";

import { createBot } from "./bot";
import type { UnpinBot } from "./bot";
import { handleRegister } from "./register";
import { keysMatch } from "./secret";

// One bot per isolate, cached on the token it is built from. Keying on
// the identity of the `env` object was the tempting version: bindings
// are immutable per version, so the object can only change if the
// environment did. But nothing promises the *same* object across
// requests, and a miss here costs a getMe round trip on every single
// update — including the init cache inside the bot, which goes with it.
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
        // Matches the Rust release's REQUEST_TIMEOUT. It is a ceiling, not
        // a promise that the handler fits inside it: a flood-wait sleep in
        // withRetry overruns it deliberately, and the resulting 5xx is what
        // hands the update back to Telegram (see the note on withRetry).
        timeoutMilliseconds: 30_000,
      })(request);
    }

    if (pathname === "/register" && request.method === "POST") {
      return handleRegister(request, env, bootFor(env));
    }

    // Liveness only, deliberately: no Telegram round trip and no D1 read,
    // so the answer says the Worker is serving and nothing more. It exists
    // so an uptime probe has a path that depends on neither the bot token
    // nor the webhook secret, whose misconfiguration this project has
    // already shipped once. Add a readiness signal here if you ever need
    // to know the bot can actually serve traffic.
    if (pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  },
};
