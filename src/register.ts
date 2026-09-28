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

/** Ceiling on one state import. D1 allows 1000 queries per Worker
 * invocation on the Workers Paid plan and 50 on the Free one (the plan
 * the README recommends), and every imported id costs one query — so this
 * ceiling is what keeps a single /register call inside the free-plan
 * limit, with the table DDL as headroom. Anything larger goes in through
 * `wrangler d1 execute --file`, which does not run inside an invocation. */
const MAX_IMPORT = 40;

export async function handleRegister(
  request: Request,
  env: Env,
  unpin: UnpinBot,
): Promise<Response> {
  // The three secrets are the entire input to the setup below, so a missing
  // one is a setup error rather than a wrong key. Continuing would hand
  // Telegram a webhook we can never authenticate (unset WEBHOOK_SECRET:
  // every genuine update 401s) or no admin gate at all.
  const missing: string[] = [];
  for (const name of ["TELOXIDE_TOKEN", "WEBHOOK_SECRET", "ADMIN_KEY"] as const) {
    if (env[name] === undefined) missing.push(name);
  }
  if (missing.length > 0) {
    return Response.json(
      {
        ok: false,
        failures: missing.map((name) => `${name} is not set; run: wrangler secret put ${name}`),
      },
      { status: 500 },
    );
  }
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
  // The body is untrusted input, so nothing reaches D1 unvalidated: chat ids
  // are int64, and a wrong file would otherwise bind a string or a float.
  try {
    await ensureTable(env.DB);
    const body = (await request.text()).trim();
    if (body.length > 0) {
      const parsed = JSON.parse(body) as { enabled_chats?: unknown };
      const listed = parsed.enabled_chats;
      // A body without the field is a no-op; one that has it as something
      // other than a list is the wrong file, and importing zero ids while
      // reporting success is the worst answer we could give the operator.
      if (listed !== undefined && !Array.isArray(listed)) {
        throw new Error("enabled_chats is not a list of chat ids");
      }
      const ids: unknown[] = Array.isArray(listed) ? listed : [];
      const chatIds = ids.filter((id): id is number => Number.isSafeInteger(id));
      if (chatIds.length !== ids.length) {
        throw new Error(
          `${ids.length - chatIds.length} of ${ids.length} enabled_chats entries are not integers`,
        );
      }
      if (chatIds.length > MAX_IMPORT) {
        throw new Error(
          `enabled_chats holds ${chatIds.length} ids, over the ${MAX_IMPORT} limit; import them in batches`,
        );
      }
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

  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/tg`;
  // Dropping the queue is destructive and belongs to the first setup —
  // a stale update discarded now is an auto-forward that stays pinned
  // forever, and the documented way to re-run /register after a config
  // change would hit it. Opt in explicitly with ?drop_pending=1.
  const dropPending = url.searchParams.get("drop_pending") === "1";
  report.drop_pending = dropPending;
  await step("setWebhook", () =>
    unpin.bot.api.setWebhook(webhookUrl, {
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "my_chat_member"],
      drop_pending_updates: dropPending,
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
    // The default scope is the one a private chat with the bot resolves to
    // (Bot API order: chat → all_private_chats → default), and only the
    // group and administrator scopes were ever set — so opening the bot in
    // a private chat showed an empty menu. Basic commands only: enable and
    // disable are refused outside a group and to non-admins, so listing
    // them here would advertise commands the bot answers with a refusal.
    await step(`setMyCommands(default,${label})`, () =>
      unpin.bot.api.setMyCommands(basic, {
        scope: { type: "default" },
        language_code: code,
      }),
    );
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
    // The catalogs carry no short string, so the long description goes out
    // as the short one too — both stay well inside the 512-character limit.
    // A dedicated `short_description` key is the fix if either catalog ever
    // outgrows that.
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
