//! Auto-unpin handling, retry primitives, permission predicates, and the
//! message-routing branch — ported from the Rust release (src/unpin.rs)
//! with identical failure semantics.

import { GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import type { Chat, ChatMember, Message } from "@grammyjs/types";

import { resolve } from "./i18n";
import * as state from "./state";

/** Middleware continuation — grammY's `next` minus its error overload. */
type Next = () => Promise<void>;

/** Maximum attempts for a Telegram call retried on transient failures. */
export const MAX_ATTEMPTS = 3;

/** Backoff before each retry after the first attempt; this array's length is
 * the attempt budget, so a miscount cannot silently change the sleeps. */
const BACKOFF_MS = [500, 1000];

/** Bot API descriptions that mean "the same request may well succeed if
 * repeated": Telegram's own gateway and server failures. */
const TRANSIENT_API_ERRORS = [
  "Bad Gateway",
  "Gateway Timeout",
  "Internal Server Error",
  "Service Unavailable",
];

// Exact Bot API descriptions, mirrored from the Rust release's teloxide
// ApiError variants (teloxide-core/src/errors.rs) so the failure
// classification carries over verbatim.
const ERR_NOT_ENOUGH_RIGHTS = [
  "Bad Request: not enough rights to pin a message",
  "Bad Request: not enough rights to manage pinned messages in the chat",
];
const ERR_CHAT_NOT_FOUND = "Bad Request: chat not found";
const ERR_NOOP_UNPIN = [
  "Bad Request: MESSAGE_ID_INVALID",
  "message to unpin not found",
];

/** Whether repeating the exact same request could succeed: a flood-wait
 * (429), a Telegram gateway failure — or any fetch-level network failure.
 * A Bot API error saying nothing transient, and a non-Bot-API HTTP response
 * (HttpError ≡ the Rust release's undecodable-body InvalidJson), return
 * false. */
export function transientFailure(err: unknown): boolean {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) return true;
    return TRANSIENT_API_ERRORS.some((s) => err.description.includes(s));
  }
  if (err instanceof HttpError) return false;
  return true;
}

/** Telegram's demanded 429 pause in seconds, if this is a flood-wait. */
function retryAfterSeconds(err: unknown): number | null {
  return err instanceof GrammyError && err.error_code === 429
    ? (err.parameters?.retry_after ?? null)
    : null;
}

/** Runs `fn` up to MAX_ATTEMPTS times, retrying transient failures: a 429
 * waits exactly as long as Telegram demands (sharing the attempt budget, so
 * the loop stays bounded), other transients wait the fixed backoff. Any
 * other error is returned immediately. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!transientFailure(err) || attempt + 1 >= MAX_ATTEMPTS) throw err;
      const retryAfter = retryAfterSeconds(err);
      const delay =
        retryAfter !== null ? retryAfter * 1000 : (BACKOFF_MS[attempt] ?? 1000);
      attempt += 1;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delay);
      await promise;
    }
  }
}

/** True when the message is a channel post that Telegram auto-forwarded
 * into this discussion group — the exact wire flag the Rust dispatcher's
 * `is_automatic_forward` filter read. Manually forwarded posts stay pinned. */
export function isAutomaticForward(msg: Message): boolean {
  return msg.is_automatic_forward === true;
}

/** The [oldId, newId] pair a chat-migration service message moves the
 * enabled set between, or null for an ordinary message. */
export function migrationPair(msg: Message): [number, number] | null {
  // The service message in the upgraded supergroup names the old group.
  if (msg.migrate_from_chat_id !== undefined) {
    return [msg.migrate_from_chat_id, msg.chat.id];
  }
  // Legacy shape: the last message in the old group names the new one.
  if (msg.migrate_to_chat_id !== undefined) {
    return [msg.chat.id, msg.migrate_to_chat_id];
  }
  return null;
}

/** Whether `member` may run privileged commands (owner or administrator).
 * An anonymous group admin has no real user to look up and never reaches
 * this predicate. */
export function isPrivileged(member: ChatMember): boolean {
  return member.status === "creator" || member.status === "administrator";
}

/** Whether the bot itself can unpin in `chat`, given its membership there
 * and — consulted for basic groups only — the chat's default pin permission. */
export function botCanUnpin(
  chat: Chat,
  member: ChatMember,
  defaultCanPin: boolean,
): boolean {
  if (chat.type === "supergroup") {
    return (
      member.status === "administrator" && member.can_pin_messages === true
    );
  }
  if (chat.type === "group") {
    // An administrator bot in a basic group carries no can_pin_messages of
    // its own, so the right lives in the chat's default permissions.
    return member.status === "administrator" && defaultCanPin;
  }
  return false;
}

/** The default member permission to pin when `chat` is a basic group —
 * false without an API call for any other chat type. */
export async function basicGroupCanPin(
  ctx: Context,
  chat: Chat,
): Promise<boolean> {
  if (chat.type !== "group") return false;
  const full = await ctx.api.getChat(chat.id);
  return full.permissions?.can_pin_messages === true;
}

/** What an `unpinChatMessage` failure means for unpinWithRetry — classified
 * by the only thing the caller can do about it. */
export type UnpinFailure =
  | { kind: "migrated"; newId: number }
  | { kind: "noRights" }
  | { kind: "chatGone" }
  | { kind: "alreadyDone" }
  | { kind: "fatal" };

/** Classifies an unpin failure. Telegram reports some of these ambiguously,
 * so this mapping is the contract unpinWithRetry relies on. */
export function classify(err: unknown): UnpinFailure {
  if (err instanceof GrammyError) {
    const newId = err.parameters?.migrate_to_chat_id;
    if (typeof newId === "number") return { kind: "migrated", newId };
    if (ERR_NOT_ENOUGH_RIGHTS.includes(err.description)) {
      return { kind: "noRights" };
    }
    if (err.description === ERR_CHAT_NOT_FOUND) return { kind: "chatGone" };
    // Nothing left to unpin: the message is gone or already unpinned — an
    // admin got there first, or a retry that had actually succeeded.
    if (ERR_NOOP_UNPIN.some((d) => err.description.includes(d))) {
      return { kind: "alreadyDone" };
    }
  }
  return { kind: "fatal" };
}

/** Handler for automatically forwarded channel posts: unpins them in
 * enabled chats only. */
export async function autoUnpin(ctx: Context, env: Env): Promise<void> {
  const msg = ctx.message!;
  if (!(await state.has(env.DB, msg.chat.id))) {
    console.debug(`chat ${msg.chat.id} is not enabled; skipping unpin`);
    return;
  }
  console.info(
    `auto-forwarded channel post ${msg.message_id} in chat ${msg.chat.id}; unpinning`,
  );
  await unpinWithRetry(ctx, env, msg.chat.id, msg.message_id);
}

/** Unpins `message_id` with retry; follows the chat across a group →
 * supergroup migration by moving the enabled entry. */
async function unpinWithRetry(
  ctx: Context,
  env: Env,
  chatId: number,
  messageId: number,
): Promise<void> {
  let target = chatId;
  let migrated = false;
  for (;;) {
    try {
      await withRetry(() => ctx.api.unpinChatMessage(target, messageId));
      console.info(`unpinned message ${messageId} in chat ${chatId}`);
      return;
    } catch (err) {
      const failure = classify(err);
      if (failure.kind === "migrated") {
        if (migrated) {
          console.error(`chat ${chatId} migrated twice; giving up`);
          return;
        }
        console.info(`chat ${chatId} migrated to ${failure.newId}; migrating state`);
        try {
          const moved = await state.replace(env.DB, target, failure.newId);
          if (moved) {
            console.info(`enabled state migrated ${target} -> ${failure.newId}`);
          } else {
            console.warn(
              `chat ${target} was not in enabled state during migration`,
            );
          }
        } catch (e) {
          console.error(
            `failed to persist migration ${target} -> ${failure.newId}: ${e}`,
          );
        }
        migrated = true;
        target = failure.newId;
        continue;
      }
      if (failure.kind === "noRights") {
        console.warn(
          `bot lacks pin rights in chat ${chatId}; re-run /enable after granting them`,
        );
        return;
      }
      if (failure.kind === "chatGone") {
        console.warn(`chat ${chatId} not found while unpinning`);
        return;
      }
      if (failure.kind === "alreadyDone") {
        console.debug(`message ${messageId} in chat ${chatId} is not pinned`);
        return;
      }
      console.error(`unpin failed in chat ${chatId}: ${err}`);
      return;
    }
  }
}

/** Keeps the enabled set following a basic group upgraded to a supergroup. */
export async function chatMigrated(ctx: Context, env: Env): Promise<void> {
  const pair = migrationPair(ctx.message!);
  if (pair === null) return; // the router filtered on the same condition
  const [oldId, newId] = pair;
  try {
    const moved = await state.replace(env.DB, oldId, newId);
    if (moved) {
      console.info(`chat ${oldId} upgraded to ${newId}; migrating enabled state`);
    } else {
      console.debug(`chat ${oldId} was not enabled; nothing to migrate to ${newId}`);
    }
  } catch (e) {
    console.error(`failed to persist migration ${oldId} -> ${newId}: ${e}`);
  }
}

/** Keeps enabled state honest when the bot's own rights change. Telegram
 * pushes my_chat_member on promotion, demotion, and removal; /enable checks
 * the rights once, so without this a revoked pin right would leave the chat
 * "enabled" forever. */
export async function myChatMember(ctx: Context, env: Env): Promise<void> {
  // Guaranteed by the my_chat_member filter; the getter's type still allows
  // undefined because it exists on every update context.
  const upd = ctx.myChatMember!;
  const chatId = upd.chat.id;
  if (!(await state.has(env.DB, chatId))) return;
  const member = upd.new_chat_member;
  let canUnpin: boolean;
  if (member.status === "left" || member.status === "kicked") {
    // The rights question answers itself — and for a basic group the
    // getChat below would now fail permanently, which must not be mistaken
    // for a transient error.
    canUnpin = false;
  } else {
    let defaultCanPin = false;
    if (upd.chat.type === "group") {
      try {
        defaultCanPin = await basicGroupCanPin(ctx, upd.chat);
      } catch (err) {
        console.warn(`getChat failed for chat ${chatId} on rights change: ${err}`);
        return; // a transient failure must not flip state
      }
    }
    canUnpin = botCanUnpin(upd.chat, member, defaultCanPin);
  }
  if (canUnpin) return;
  try {
    if (!(await state.remove(env.DB, chatId))) return;
  } catch (err) {
    console.error(`failed to persist disable for chat ${chatId}: ${err}`);
    return;
  }
  console.info(`chat ${chatId} disabled: the bot can no longer unpin there`);
  const lang = resolve(upd.from.language_code);
  try {
    await ctx.api.sendMessage(chatId, lang.error.rights_revoked);
  } catch (err) {
    console.debug(`could not announce disabled state in chat ${chatId}: ${err}`);
  }
}

/** The Rust dispatcher's message branch, in order: auto-unpin, chat
 * migration, then fall through to the command handlers. */
export async function routeMessage(
  ctx: Context,
  env: Env,
  next: Next,
): Promise<void> {
  const msg = ctx.message;
  if (msg === undefined) return next(); // unreachable under the "message" filter
  if (isAutomaticForward(msg)) {
    await autoUnpin(ctx, env);
    return;
  }
  if (migrationPair(msg) !== null) {
    await chatMigrated(ctx, env);
    return;
  }
  await next();
}
