//! Predicate, classification, and routing tests — ported from the Rust
//! release's unpin.rs suite; message fixtures are the original JSON.

import type { Context } from "grammy";
import type { Chat, ChatMember, Message } from "@grammyjs/types";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";

import {
  botCanUnpin,
  classify,
  isAutomaticForward,
  isPrivileged,
  migrationPair,
  routeMessage,
} from "../src/unpin";
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
    expect(
      classify(apiError("Bad Request: message to unpin not found")),
    ).toEqual({ kind: "alreadyDone" });
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
        message(
          `{"chat":{"id":-1001,"type":"supergroup"},"message_id":3,"date":1,"text":"hi"}`,
        ),
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
