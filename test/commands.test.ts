//! Command handlers — the gate every user-facing answer passes through:
//! group check, caller privileges, the bot's own pin rights, and what the
//! enabled set says afterwards.

import { describe, expect, it } from "vitest";
import { GrammyError } from "grammy";
import type { Context } from "grammy";
import type { Chat, ChatMember, User } from "@grammyjs/types";

import { disable, enable, help, start } from "../src/commands";
import type { Lang } from "../src/i18n";
import { resolve } from "../src/i18n";
import { fakeD1 } from "./fake-d1";
import type { FakeD1 } from "./fake-d1";

const lang = resolve("en");
const BOT_ID = 42;
const ADMIN_ID = 7;
const SUPERGROUP_ID = -1001;

type ChatKind = Chat["type"];

/** A chat stub with just the fields the handlers read. */
const chat = (type: ChatKind, id = SUPERGROUP_ID): Chat =>
  ({ id, type }) as Chat;

/** A membership record; the right under test rides along in `extra`. */
const member = (status: ChatMember["status"], extra = {}): ChatMember =>
  ({ status, user: { id: BOT_ID }, ...extra }) as ChatMember;

const user = (id: number): User =>
  ({ id, is_bot: false, first_name: "u" }) as User;

function apiError(description: string, error_code = 400): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code, description },
    "testMethod",
    {},
  );
}

interface ContextOptions {
  chat?: Chat;
  from?: User | undefined;
  senderChatId?: number;
  botMember?: ChatMember;
  chatMember?: ChatMember;
  getChatPermissions?: { can_pin_messages?: boolean };
  getChatMemberError?: GrammyError;
  getChatError?: GrammyError;
}

/** A context stub carrying exactly what the command handlers touch. */
function context(options: ContextOptions = {}): {
  ctx: Context;
  replies: string[];
} {
  const replies: string[] = [];
  const where = options.chat ?? chat("supergroup");
  const from = "from" in options ? options.from : user(ADMIN_ID);
  const stub = {
    chatId: where.id,
    chat: where,
    me: { id: BOT_ID },
    from,
    message: {
      message_id: 1,
      chat: where,
      from,
      ...(options.senderChatId === undefined
        ? {}
        : { sender_chat: { id: options.senderChatId } }),
    },
    reply: async (text: string) => {
      replies.push(text);
    },
    api: {
      sendChatAction: async () => true,
      getChatMember: async (_chatId: number, userId: number) => {
        if (options.getChatMemberError) throw options.getChatMemberError;
        return userId === BOT_ID
          ? (options.botMember ??
            member("administrator", { can_pin_messages: true }))
          : (options.chatMember ?? member("administrator"));
      },
      getChat: async () => {
        if (options.getChatError) throw options.getChatError;
        return {
          ...where,
          permissions: options.getChatPermissions ?? { can_pin_messages: true },
        };
      },
    },
  };
  return { ctx: stub as unknown as Context, replies };
}

type Command = (ctx: Context, l: Lang, env: Env) => Promise<void>;

/** Runs a command against a fresh store and returns what the user was told. */
async function run(
  command: Command,
  options: ContextOptions = {},
): Promise<{ replies: string[]; fake: FakeD1 }> {
  const fake = fakeD1();
  const { ctx, replies } = context(options);
  await command(ctx, lang, { DB: fake.db } as unknown as Env);
  return { replies, fake };
}

describe("/start and /help", () => {
  it("answer in any chat and touch no state", async () => {
    const started = await run(start, { chat: chat("private", 5) });
    expect(started.replies).toEqual([lang.start]);
    expect(started.fake.statements).toEqual([]);
    const helped = await run(help, { chat: chat("private", 5) });
    expect(helped.replies).toEqual([lang.help]);
  });
});

describe("/enable", () => {
  it("refuses outside a discussion group", async () => {
    const { replies, fake } = await run(enable, { chat: chat("private", 5) });
    expect(replies).toEqual([lang.error.not_group]);
    expect(fake.statements).toEqual([]);
  });

  it("refuses a member who is not an administrator", async () => {
    const { replies, fake } = await run(enable, {
      chatMember: member("member"),
    });
    expect(replies).toEqual([lang.error.not_admin]);
    expect(fake.statements).toEqual([]);
  });

  it("refuses a message with no sender at all", async () => {
    const { replies } = await run(enable, { from: undefined });
    expect(replies).toEqual([lang.error.not_admin]);
  });

  it("enables a supergroup where the bot may pin", async () => {
    const { replies, fake } = await run(enable);
    expect(replies).toEqual([lang.enable]);
    expect(fake.rows.has(SUPERGROUP_ID)).toBe(true);
  });

  it("reports the second /enable as already enabled", async () => {
    const fake = fakeD1();
    const env = { DB: fake.db } as unknown as Env;
    const first = context();
    const second = context();
    await enable(first.ctx, lang, env);
    await enable(second.ctx, lang, env);
    expect(first.replies).toEqual([lang.enable]);
    expect(second.replies).toEqual([lang.error.already_enabled]);
    expect(fake.rows.size).toBe(1);
  });

  it("refuses when the bot cannot pin in the supergroup", async () => {
    const { replies, fake } = await run(enable, {
      botMember: member("administrator", { can_pin_messages: false }),
    });
    expect(replies).toEqual([lang.error.require_rights]);
    expect(fake.statements).toEqual([]);
  });

  it("refuses when the bot is not even an administrator", async () => {
    const { replies } = await run(enable, { botMember: member("member") });
    expect(replies).toEqual([lang.error.require_rights]);
  });

  it("reads the default pin right in a basic group", async () => {
    const allowed = await run(enable, {
      chat: chat("group"),
      getChatPermissions: { can_pin_messages: true },
    });
    expect(allowed.replies).toEqual([lang.enable]);
    const denied = await run(enable, {
      chat: chat("group"),
      getChatPermissions: { can_pin_messages: false },
    });
    expect(denied.replies).toEqual([lang.error.require_rights]);
  });

  it("asks the caller to retry when Telegram fails the rights lookup", async () => {
    const { replies, fake } = await run(enable, {
      getChatMemberError: apiError("Bad Request: chat not found"),
    });
    expect(replies).toEqual([lang.error.retry_later]);
    expect(fake.statements).toEqual([]);
  });

  it("does not flip state when the chat lookup fails", async () => {
    const { replies, fake } = await run(enable, {
      chat: chat("group"),
      getChatError: apiError("Bad Gateway"),
    });
    expect(replies).toEqual([lang.error.retry_later]);
    expect(fake.statements).toEqual([]);
  });

  it("treats an anonymous admin (sender_chat) as an administrator", async () => {
    // A linked channel posting as the chat itself has no user to look up;
    // it must still reach the bot's own rights check.
    const { replies } = await run(enable, {
      from: undefined,
      senderChatId: SUPERGROUP_ID,
      botMember: member("administrator", { can_pin_messages: false }),
    });
    expect(replies).toEqual([lang.error.require_rights]);
  });
});

describe("/disable", () => {
  it("refuses outside a discussion group", async () => {
    const { replies } = await run(disable, { chat: chat("private", 5) });
    expect(replies).toEqual([lang.error.not_group]);
  });

  it("refuses a non-administrator", async () => {
    const { replies, fake } = await run(disable, {
      chatMember: member("member"),
    });
    expect(replies).toEqual([lang.error.not_admin]);
    expect(fake.statements).toEqual([]);
  });

  it("disables an enabled chat, then reports the resulting state", async () => {
    const fake = fakeD1();
    const env = { DB: fake.db } as unknown as Env;
    const enabled = context();
    await enable(enabled.ctx, lang, env);
    const first = context();
    await disable(first.ctx, lang, env);
    expect(first.replies).toEqual([lang.disable]);
    expect(fake.rows.has(SUPERGROUP_ID)).toBe(false);
    const second = context();
    await disable(second.ctx, lang, env);
    expect(second.replies).toEqual([lang.error.already_disabled]);
  });
});
