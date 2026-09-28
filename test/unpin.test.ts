//! Predicate, classification, and routing tests — ported from the Rust
//! release's unpin.rs suite; message fixtures are the original JSON.

import type { Context } from "grammy";
import type { Chat, ChatMember, Message } from "@grammyjs/types";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";

import {
  autoUnpin,
  botCanUnpin,
  classify,
  isAutomaticForward,
  isPrivileged,
  migrationPair,
  myChatMember,
  routeMessage,
} from "../src/unpin";
import { insert } from "../src/state";
import en from "../src/i18n/en.json";
import { fakeD1 } from "./fake-d1";

const message = (json: string): Message => JSON.parse(json) as Message;

/** A chat parsed from the wire format, like the Rust fixtures. */
function chat(kind: string): Chat {
  const json =
    kind === "private"
      ? `{"id":42,"type":"private","first_name":"Test"}`
      : `{"id":-1001234567890,"title":"Test","type":"${kind}"}`;
  return JSON.parse(json) as Chat;
}

function member(json: Record<string, unknown>): ChatMember {
  return {
    user: { id: 1, is_bot: false, first_name: "Test" },
    ...json,
  } as ChatMember;
}

const admin = (canPin: boolean): ChatMember =>
  member({ status: "administrator", can_pin_messages: canPin });
const regular = (): ChatMember => member({ status: "member" });

function apiError(
  description: string,
  parameters?: { retry_after?: number; migrate_to_chat_id?: number },
): GrammyError {
  return new GrammyError(
    description,
    { ok: false, error_code: 400, description, parameters },
    "unpinChatMessage",
    {},
  );
}

describe("migration messages", () => {
  const OLD_CHAT = -599075523;
  const NEW_CHAT = -1001555296434;

  it("the upgraded supergroup names the old group", () => {
    const m = message(
      `{"chat":{"id":${NEW_CHAT},"title":"test","type":"supergroup"},
        "date":1629404938,
        "from":{"first_name":"n","id":729497414,"is_bot":true,"username":"unpinbot"},
        "message_id":1,"migrate_from_chat_id":${OLD_CHAT}}`,
    );
    expect(migrationPair(m)).toEqual([OLD_CHAT, NEW_CHAT]);
  });

  it("the legacy shape has the old group name the new one", () => {
    const m = message(
      `{"chat":{"id":${OLD_CHAT},"title":"test","type":"group"},
        "date":1629404938,
        "from":{"first_name":"n","id":729497414,"is_bot":true,"username":"unpinbot"},
        "message_id":2,"migrate_to_chat_id":${NEW_CHAT}}`,
    );
    expect(migrationPair(m)).toEqual([OLD_CHAT, NEW_CHAT]);
  });

  it("an ordinary message carries no migration", () => {
    expect(
      migrationPair(
        message(
          `{"chat":{"id":${OLD_CHAT},"title":"test","type":"group"},
            "date":1,"message_id":3,"text":"hi"}`,
        ),
      ),
    ).toBeNull();
  });
});

describe("unpin failure classification", () => {
  it("classifies by what the caller can do", () => {
    expect(classify(apiError("nope", { migrate_to_chat_id: -1001234567890 }))).toEqual({
      kind: "migrated",
      newId: -1001234567890,
    });
    for (const description of [
      "Bad Request: not enough rights to pin a message",
      "Bad Request: not enough rights to manage pinned messages in the chat",
    ]) {
      expect(classify(apiError(description))).toEqual({ kind: "noRights" });
    }
    expect(classify(apiError("Bad Request: chat not found"))).toEqual({
      kind: "chatGone",
    });
    // The two shapes of "there is nothing pinned any more".
    expect(classify(apiError("Bad Request: MESSAGE_ID_INVALID"))).toEqual({
      kind: "alreadyDone",
    });
    expect(classify(apiError("Bad Request: message to unpin not found"))).toEqual({
      kind: "alreadyDone",
    });
    // An unrelated failure must not pass for a completed unpin; network
    // failures surface here only after withRetry exhausted its budget.
    expect(classify(apiError("Bad Request: nope"))).toEqual({ kind: "fatal" });
    expect(classify(new TypeError("fetch failed"))).toEqual({ kind: "fatal" });
  });
});

describe("auto-forward filter", () => {
  it("matches only Telegram's automatic channel forwards", () => {
    expect(
      isAutomaticForward(
        message(
          `{"chat":{"id":-1001,"type":"supergroup"},"message_id":1,"date":1,
            "is_automatic_forward":true}`,
        ),
      ),
    ).toBe(true);
    // A manually forwarded channel post: same origin, no auto-forward flag.
    expect(
      isAutomaticForward(
        message(
          `{"chat":{"id":-1001,"type":"supergroup"},"message_id":2,"date":1,
            "forward_origin":{"type":"channel","date":1,
              "chat":{"id":-1002,"type":"channel","title":"C"},"message_id":3}}`,
        ),
      ),
    ).toBe(false);
    expect(
      isAutomaticForward(
        message(`{"chat":{"id":-1001,"type":"supergroup"},"message_id":3,"date":1,"text":"hi"}`),
      ),
    ).toBe(false);
  });
});

describe("privileged members", () => {
  it("owners and administrators pass, everyone else does not", () => {
    expect(isPrivileged(member({ status: "creator" }))).toBe(true);
    expect(isPrivileged(admin(true))).toBe(true);
    expect(isPrivileged(admin(false))).toBe(true);
    expect(isPrivileged(regular())).toBe(false);
    expect(isPrivileged(member({ status: "left" }))).toBe(false);
  });
});

describe("botCanUnpin", () => {
  it("supergroup requires the admin pin right", () => {
    const supergroup = chat("supergroup");
    expect(botCanUnpin(supergroup, admin(true), false)).toBe(true);
    expect(botCanUnpin(supergroup, admin(false), false)).toBe(false);
    expect(botCanUnpin(supergroup, regular(), false)).toBe(false);
  });

  it("basic group requires the default pin permission", () => {
    const group = chat("group");
    expect(botCanUnpin(group, admin(false), true)).toBe(true);
    expect(botCanUnpin(group, admin(false), false)).toBe(false);
    expect(botCanUnpin(group, regular(), true)).toBe(false);
  });

  it("other chat types are never unpinnable", () => {
    expect(botCanUnpin(chat("private"), admin(true), true)).toBe(false);
    expect(botCanUnpin(chat("channel"), admin(true), true)).toBe(false);
  });

  it("the owner holds the right without an admin record or a default", () => {
    const owner = member({ status: "creator" });
    expect(botCanUnpin(chat("supergroup"), owner, false)).toBe(true);
    expect(botCanUnpin(chat("group"), owner, false)).toBe(true);
  });
});

describe("message routing", () => {
  const next = () => Promise.resolve();

  it("the auto-forward branch consumes the update, commands never see it", async () => {
    const { db } = fakeD1();
    const ctx = {
      message: message(
        `{"chat":{"id":-1001,"type":"supergroup"},"message_id":1,"date":1,
          "text":"/enable","is_automatic_forward":true}`,
      ),
    } as unknown as Context;
    const fallthrough = vi.fn(next);
    await routeMessage(ctx, { DB: db } as unknown as Env, fallthrough);
    expect(fallthrough).not.toHaveBeenCalled();
  });

  it("migration messages are consumed by the migration branch", async () => {
    const { db } = fakeD1();
    const ctx = {
      message: message(
        `{"chat":{"id":-1001555296434,"title":"t","type":"supergroup"},
          "date":1,"message_id":1,"migrate_from_chat_id":-599075523}`,
      ),
    } as unknown as Context;
    const fallthrough = vi.fn(next);
    await routeMessage(ctx, { DB: db } as unknown as Env, fallthrough);
    expect(fallthrough).not.toHaveBeenCalled();
  });

  it("ordinary messages fall through to the command handlers", async () => {
    const { db } = fakeD1();
    const ctx = {
      message: message(
        `{"chat":{"id":-1001,"type":"supergroup"},"message_id":1,"date":1,"text":"/enable"}`,
      ),
    } as unknown as Context;
    const fallthrough = vi.fn(next);
    await routeMessage(ctx, { DB: db } as unknown as Env, fallthrough);
    expect(fallthrough).toHaveBeenCalledTimes(1);
  });
});

describe("auto-unpin", () => {
  const OLD_ID = -1001;
  const NEW_ID = -1002;
  const autoForward = (chatId: number): Message =>
    message(
      `{"chat":{"id":${chatId},"type":"supergroup"},"message_id":7,"date":1,
        "is_automatic_forward":true}`,
    );

  /** An auto-forward whose unpin throws each queued error in turn. */
  function forwardIn(
    chatId: number,
    errors: GrammyError[],
  ): {
    ctx: Context;
    unpin: ReturnType<typeof vi.fn>;
  } {
    const unpin = vi.fn(async () => {
      throw errors.shift();
    });
    return {
      ctx: {
        message: autoForward(chatId),
        api: { unpinChatMessage: unpin },
      } as unknown as Context,
      unpin,
    };
  }

  it("does nothing in a chat nobody enabled", async () => {
    const { db } = fakeD1();
    const { ctx, unpin } = forwardIn(OLD_ID, []);
    await autoUnpin(ctx, { DB: db } as unknown as Env);
    expect(unpin).not.toHaveBeenCalled();
  });

  it("follows the chat across a migration and unpins on the new id", async () => {
    const { db, rows } = fakeD1();
    await insert(db, OLD_ID);
    const { ctx, unpin } = forwardIn(OLD_ID, [
      apiError("Bad Request: chat not found", { migrate_to_chat_id: NEW_ID }),
    ]);
    await autoUnpin(ctx, { DB: db } as unknown as Env);
    expect(unpin.mock.calls).toEqual([
      [OLD_ID, 7],
      [NEW_ID, 7],
    ]);
    expect(rows.has(OLD_ID)).toBe(false);
    expect(rows.has(NEW_ID)).toBe(true);
  });

  it("stops chasing a chat that migrates a second time", async () => {
    // One follow-up is the whole budget: a telegram-side loop must not turn
    // into an unbounded chase, and the first move is left standing.
    const { db, rows } = fakeD1();
    await insert(db, OLD_ID);
    const { ctx, unpin } = forwardIn(OLD_ID, [
      apiError("Bad Request: chat not found", { migrate_to_chat_id: NEW_ID }),
      apiError("Bad Request: chat not found", { migrate_to_chat_id: -1003 }),
    ]);
    await autoUnpin(ctx, { DB: db } as unknown as Env);
    expect(unpin).toHaveBeenCalledTimes(2);
    expect(rows.has(NEW_ID)).toBe(true);
    expect(rows.has(-1003)).toBe(false);
  });
});

describe("the bot's own rights changing", () => {
  // The fixture chat's real id — the handler works off upd.chat.id, not a
  // constant of our own.
  const CHAT_ID = chat("supergroup").id;

  function rightsChanged(
    kind: string,
    next: ChatMember,
    announce: "succeeds" | "fails" = "succeeds",
  ): {
    ctx: Context;
    sendMessage: ReturnType<typeof vi.fn>;
    getChat: ReturnType<typeof vi.fn>;
  } {
    // A removed bot cannot post in the chat it was removed from: the
    // announcement still has to be attempted, and its failure swallowed.
    const sendMessage = vi.fn(async () => {
      if (announce === "fails") throw new Error("Forbidden: bot was kicked");
      return true;
    });
    // A removal or a revoked right must not turn into a getChat that can
    // fail for good and be read as a transient error.
    const getChat = vi.fn(async () => {
      throw new Error("getChat must not be called here");
    });
    return {
      ctx: {
        myChatMember: {
          chat: chat(kind),
          new_chat_member: next,
          from: { id: 5, is_bot: true, language_code: "en" },
        },
        api: { sendMessage, getChat },
      } as unknown as Context,
      sendMessage,
      getChat,
    };
  }

  it("disables the chat and announces it when the pin right is revoked", async () => {
    const { db, rows } = fakeD1();
    await insert(db, CHAT_ID);
    const { ctx, sendMessage, getChat } = rightsChanged("supergroup", admin(false));
    await myChatMember(ctx, { DB: db } as unknown as Env);
    expect(getChat).not.toHaveBeenCalled(); // a supergroup carries the right itself
    expect(rows.has(CHAT_ID)).toBe(false);
    expect(sendMessage.mock.calls).toEqual([[CHAT_ID, en.error.rights_revoked]]);
  });

  it("keeps the chat enabled while the rights hold", async () => {
    const { db, rows } = fakeD1();
    await insert(db, CHAT_ID);
    const { ctx, sendMessage } = rightsChanged("supergroup", admin(true));
    await myChatMember(ctx, { DB: db } as unknown as Env);
    expect(rows.has(CHAT_ID)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("says nothing about a chat that was never enabled", async () => {
    const { db, rows } = fakeD1();
    const { ctx, sendMessage } = rightsChanged("supergroup", admin(false));
    await myChatMember(ctx, { DB: db } as unknown as Env);
    expect(rows.size).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("disables a basic group the bot was removed from, even when it cannot say so", async () => {
    const { db, rows } = fakeD1();
    await insert(db, CHAT_ID);
    // Kicked in a basic group: the rights question answers itself, so no
    // getChat (which would now fail for good), and the send cannot land.
    const { ctx, sendMessage, getChat } = rightsChanged(
      "group",
      member({ status: "kicked" }),
      "fails",
    );
    await myChatMember(ctx, { DB: db } as unknown as Env);
    expect(getChat).not.toHaveBeenCalled();
    expect(rows.has(CHAT_ID)).toBe(false);
    expect(sendMessage.mock.calls).toEqual([[CHAT_ID, en.error.rights_revoked]]);
  });
});
