//! One-shot setup endpoint (POST /register): state-table DDL, optional
//! state import (the old state.json as the request body), setWebhook, and
//! the bot profile — the Workers replacement for the Rust release's
//! startup sequence, kept idempotent so it can be re-run at any time.

import type { LanguageCode } from "@grammyjs/types";

import { keysMatch } from "./secret";
import { ensureTable, importChats } from "./state";
import { ALL, resolve } from "./i18n";
import type { Lang } from "./i18n";
import type { UnpinBot } from "./bot";

export async function handleRegister(
  request: Request,
  env: Env,
  unpin: UnpinBot,
): Promise<Response> {
  const key = request.headers.get("X-Register-Key") ?? "";
  if (!keysMatch(key, env.ADMIN_KEY)) {
    return new Response("Forbidden", { status: 403 });
  }

  const report: Record<string, unknown> = {};
  const failures: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${name}: ${err}`);
    }
  };

  // Storage first: table plus an optional import. The old state.json can be
  // posted verbatim — {"enabled_chats": [...]} — making migration a curl.
  try {
    await ensureTable(env.DB);
    report.table = "created";
    const body = (await request.text()).trim();
    if (body.length > 0) {
      const parsed = JSON.parse(body) as { enabled_chats?: number[] };
      const chatIds = Array.isArray(parsed.enabled_chats)
        ? parsed.enabled_chats
        : [];
      await importChats(env.DB, chatIds);
      report.imported = chatIds.length;
    }
  } catch (err) {
    report.storage = String(err);
    failures.push(`storage: ${err}`);
  }

  // getMe next: every step below needs the same reachable, valid token, so
  // a failure here is reported alone rather than as six identical ones.
  try {
    await unpin.ensureInit();
    report.bot = `@${unpin.bot.botInfo?.username ?? "?"}`;
  } catch (err) {
    failures.push(`getMe: ${err}`);
    return respond(report, failures, null);
  }

  const webhookUrl = `${new URL(request.url).origin}/tg`;
  await step("setWebhook", () =>
    unpin.bot.api.setWebhook(webhookUrl, {
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "my_chat_member"],
      drop_pending_updates: true,
    }),
  );
  await step("default_admin_rights", () =>
    unpin.bot.api.setMyDefaultAdministratorRights({
      rights: {
        is_anonymous: false,
        can_manage_chat: false,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: true,
        can_manage_topics: false,
        can_post_stories: false,
        can_edit_stories: false,
        // Required by the current Bot API type; false keeps the Rust
        // release's intent of granting nothing but can_pin_messages.
        can_delete_stories: false,
        can_send_welcome_messages: false,
        // can_post_messages / can_edit_messages: channel-only rights,
        // omitted exactly like the Rust release's default profile.
      },
    }),
  );

  // Command menus, description, and short description — once per embedded
  // language plus the no-language default, as setup_bot_profile did.
  const targets: ReadonlyArray<readonly [LanguageCode | undefined, Lang]> = [
    ...ALL.map(([code, lang]) => [code as LanguageCode, lang] as const),
    [undefined, resolve(undefined)],
  ];
  for (const [code, lang] of targets) {
    const basic = [
      { command: "start", description: lang.cmd.start },
      { command: "help", description: lang.cmd.help },
    ];
    const admin = [
      ...basic,
      { command: "enable", description: lang.cmd.enable },
      { command: "disable", description: lang.cmd.disable },
    ];
    const label = code ?? "default";
    await step(`setMyCommands(groups,${label})`, () =>
      unpin.bot.api.setMyCommands(basic, {
        scope: { type: "all_group_chats" },
        language_code: code,
      }),
    );
    await step(`setMyCommands(admins,${label})`, () =>
      unpin.bot.api.setMyCommands(admin, {
        scope: { type: "all_chat_administrators" },
        language_code: code,
      }),
    );
    await step(`setMyDescription(${label})`, () =>
      unpin.bot.api.setMyDescription(lang.description, {
        language_code: code,
      }),
    );
    await step(`setMyShortDescription(${label})`, () =>
      unpin.bot.api.setMyShortDescription(lang.description, {
        language_code: code,
      }),
    );
  }

  report.webhook = webhookUrl;
  return respond(report, failures, webhookUrl);
}

function respond(
  report: Record<string, unknown>,
  failures: string[],
  webhookUrl: string | null,
): Response {
  const ok = failures.length === 0;
  return Response.json(
    { ok, webhook: webhookUrl, failures, ...report },
    { status: ok ? 200 : 502 },
  );
}
