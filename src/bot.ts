//! grammY wiring: middleware order mirrors the Rust dispatcher's dptree
//! branches (auto-unpin → migration → commands → rights listener).

import { Bot } from "grammy";
import type { Context } from "grammy";

import { disable, enable, help, start } from "./commands";
import { resolve } from "./i18n";
import type { Lang } from "./i18n";
import { myChatMember, routeMessage } from "./unpin";

export interface UnpinBot {
  readonly bot: Bot;
  /** Resolves once getMe succeeded (cached per isolate); rejects after a
   * failure so the next caller retries instead of inheriting a poisoned
   * cache — the Rust release got the same behavior by dying at startup. */
  ensureInit(): Promise<void>;
}

export function createBot(env: Env): UnpinBot {
  const bot = new Bot(env.TELOXIDE_TOKEN);

  let init: Promise<void> | null = null;
  const ensureInit = async (): Promise<void> => {
    init ??= bot.init();
    try {
      await init;
    } catch (err) {
      init = null;
      throw err;
    }
  };

  // Branch order mirrors build_handler() in the Rust release: auto-unpin
  // first (a channel post whose text is a command still unpins), then chat
  // migration, then fall through to the command handlers.
  bot.on("message", (ctx, next) => routeMessage(ctx, env, next));

  const command = (
    name: string,
    fn: (ctx: Context, lang: Lang, env: Env) => Promise<void>,
  ): void => {
    bot.command(name, async (ctx) => {
      const lang = resolve(ctx.from?.language_code);
      console.log(
        `command /${name} from user ${ctx.from?.id ?? "<anon>"} in chat ${ctx.chatId}`,
      );
      await fn(ctx, lang, env);
    });
  };
  command("start", start);
  command("help", help);
  command("enable", enable);
  command("disable", disable);

  bot.on("my_chat_member", (ctx) => myChatMember(ctx, env));

  // Handler failures are logged and answered with 200, like the Rust
  // dispatcher consuming an endpoint error: the update is spent, and
  // withRetry already exhausted the transient budget inside the handler.
  bot.catch((err) => console.error(`update handler error: ${err.error}`));

  return { bot, ensureInit };
}
