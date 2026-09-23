//! `/start` `/help` `/enable` `/disable` command handlers — ported from the
//! Rust release (src/commands.rs).

import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";

import type { Lang } from "./i18n";
import * as state from "./state";
import {
  basicGroupCanPin,
  botCanUnpin,
  isPrivileged,
  withRetry,
} from "./unpin";

/** Replies to the triggering message so the answer reads in context in busy
 * groups; the message may be gone by the time we answer, which the
 * allow_sending_without_reply flag tolerates. Commands only ever fire on
 * messages, so both lookups below are safe. */
async function reply(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_parameters: {
      message_id: ctx.message!.message_id,
      allow_sending_without_reply: true,
    },
  });
}

/** Best-effort typing indicator — failures ignored, as in the Rust release. */
async function typing(ctx: Context): Promise<void> {
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  } catch {
    // ignored
  }
}

/** Rejects non-group chats, returning true when the caller may proceed. */
async function ensureGroup(ctx: Context, lang: Lang): Promise<boolean> {
  const chat = ctx.chat!;
  if (chat.type !== "group" && chat.type !== "supergroup") {
    await reply(ctx, lang.error.not_group);
    return false;
  }
  return true;
}

/** Rejects non-admin callers. A `sender_chat` equal to the chat is an
 * anonymous group admin — there is no real user to look up, so it passes;
 * a message without a sender (`from`) is treated as not-admin. */
async function ensureCallerAdmin(ctx: Context, lang: Lang): Promise<boolean> {
  const msg = ctx.message!;
  if (msg.sender_chat?.id === msg.chat.id) return true;
  const from = msg.from;
  if (from === undefined) {
    await reply(ctx, lang.error.not_admin);
    return false;
  }
  let member: ChatMember;
  try {
    member = await withRetry(() => ctx.api.getChatMember(msg.chat.id, from.id));
  } catch (err) {
    console.error(`getChatMember failed in chat ${ctx.chatId}: ${err}`);
    await reply(ctx, lang.error.retry_later);
    return false;
  }
  if (isPrivileged(member)) return true;
  console.info(`user ${from.id} is not an admin in chat ${ctx.chatId}`);
  await reply(ctx, lang.error.not_admin);
  return false;
}

export async function start(ctx: Context, lang: Lang): Promise<void> {
  await typing(ctx);
  await reply(ctx, lang.start);
}

export async function help(ctx: Context, lang: Lang): Promise<void> {
  await typing(ctx);
  await reply(ctx, lang.help);
}

export async function enable(
  ctx: Context,
  lang: Lang,
  env: Env,
): Promise<void> {
  await typing(ctx);
  if (!(await ensureGroup(ctx, lang))) return;
  if (!(await ensureCallerAdmin(ctx, lang))) return;

  const chat = ctx.chat!;
  // Supergroups expose the pin right on the bot's own admin record; basic
  // groups only via the chat's default permissions (queried there alone).
  let defaultCanPin = false;
  if (chat.type === "group") {
    try {
      defaultCanPin = await basicGroupCanPin(ctx, chat);
    } catch (err) {
      console.error(`getChat failed in chat ${chat.id}: ${err}`);
      await reply(ctx, lang.error.retry_later);
      return;
    }
  }
  let botMember: ChatMember;
  try {
    botMember = await withRetry(() => ctx.api.getChatMember(chat.id, ctx.me.id));
  } catch (err) {
    console.error(`getChatMember(bot) failed in chat ${chat.id}: ${err}`);
    await reply(ctx, lang.error.retry_later);
    return;
  }
  if (!botCanUnpin(chat, botMember, defaultCanPin)) {
    console.info(
      `bot cannot unpin in chat ${chat.id} (missing rights); /enable rejected`,
    );
    await reply(ctx, lang.error.require_rights);
    return;
  }

  try {
    if (await state.insert(env.DB, chat.id)) {
      console.info(`chat ${chat.id} enabled`);
      await reply(ctx, lang.enable);
    } else {
      console.info(`chat ${chat.id} already enabled`);
      await reply(ctx, lang.error.already_enabled);
    }
  } catch (err) {
    console.error(`failed to persist enabled state for chat ${chat.id}: ${err}`);
    await reply(ctx, lang.error.retry_later);
  }
}

export async function disable(
  ctx: Context,
  lang: Lang,
  env: Env,
): Promise<void> {
  await typing(ctx);
  if (!(await ensureGroup(ctx, lang))) return;
  if (!(await ensureCallerAdmin(ctx, lang))) return;
  try {
    if (await state.remove(env.DB, ctx.chat!.id)) {
      console.info(`chat ${ctx.chat!.id} disabled`);
      await reply(ctx, lang.disable);
    } else {
      console.info(`chat ${ctx.chat!.id} already disabled`);
      await reply(ctx, lang.error.already_disabled);
    }
  } catch (err) {
    console.error(
      `failed to persist disabled state for chat ${ctx.chat!.id}: ${err}`,
    );
    await reply(ctx, lang.error.retry_later);
  }
}
