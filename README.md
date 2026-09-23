# UnpinBot for Cloudflare Workers

A Telegram bot that automatically unpins channel posts auto-forwarded into connected discussion groups. Runs entirely on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [grammY](https://grammy.dev) and D1 — no server to keep alive.

This is the Cloudflare Workers port of [TheFunny/UnpinBot](https://github.com/TheFunny/UnpinBot) (Rust, teloxide). The same bot token can only run one of them at a time: Telegram delivers updates either via webhook or via long polling, never both.

How it fits together:

- Telegram pushes every update to `POST /tg`. The `X-Telegram-Bot-Api-Secret-Token` header is checked before anything else (grammY verifies it again), so garbage requests never reach Telegram.
- `POST /register` (header `X-Register-Key`) is an idempotent one-shot setup: state table DDL, optional state import, `setWebhook`, command menus, descriptions, and default admin rights.
- Enabled chats live in one D1 table — one `SELECT` per incoming channel post, writes only on `/enable`, `/disable`, and group migrations.

## Requirement

- Node.js 22+ and npm
- A Cloudflare account — the Workers Free plan is more than enough for any realistic bot traffic
- A bot token from [@BotFather](https://t.me/BotFather)

## Configuration

Secrets are set with `npx wrangler secret put <NAME>` (local development reads them from a gitignored `.dev.vars`):

| Name | Required | Description |
| --- | --- | --- |
| `TELOXIDE_TOKEN` | yes | Bot token from @BotFather |
| `WEBHOOK_SECRET` | yes | `secret_token` for `setWebhook`; generate with `openssl rand -hex 16` (only `A-Z a-z 0-9 _ -` allowed) |
| `ADMIN_KEY` | yes | Key for `POST /register`; any random string you keep to yourself |

In `wrangler.jsonc`:

| Setting | Description |
| --- | --- |
| `d1_databases[0].database_id` | Paste what `npx wrangler d1 create unpinbot` prints |
| routes / custom domain | Recommended: Telegram may reject the wildcard `*.workers.dev` certificate. A custom domain gets an exact-match certificate |
| `compatibility_date` | Pinned to a date the bundled workerd actually supports; bump deliberately |

## Deployment

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create unpinbot` and paste the printed `database_id` into `wrangler.jsonc`
4. Set the three secrets (table above)
5. `npx wrangler deploy`
6. Register, and import the old release's state in the same call — the old `pers_data/state.json` is the request body verbatim (omit the body if there is nothing to import):

   ```bash
   curl -X POST -H "X-Register-Key: $ADMIN_KEY" \
     https://your-host/register --data-binary @pers_data/state.json
   ```

   `"ok": true` in the response means webhook, menus, rights, and import all succeeded. The endpoint is idempotent — re-run it after any config change.
7. Stop the old Docker bot (or don't start it yet). While a webhook is set, `getUpdates` stops working. To roll back: `curl "https://api.telegram.org/bot$TOKEN/deleteWebhook"` and start the Docker release again.

## Usage

- `/enable` — enable auto-unpin in the current group (administrator only; the bot needs the pin-messages permission)
- `/disable` — disable auto-unpin
- `/start`, `/help` — about and help

Behavior is identical to the Rust release:

- If the bot loses the pin-messages permission or is removed from the group, it disables auto-unpin there and says so (when it still can). Grant the permission again and run `/enable`.
- When a basic group is upgraded to a supergroup, the enabled entry follows the new chat id automatically.
- The bot follows each sender's Telegram client language (English and Chinese; English is the fallback). Command menus and the description match too.
- Manually forwarded channel posts are not unpinned — only Telegram's automatic forwards from linked discussion groups.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | `wrangler dev` — local workerd with local D1 state |
| `npm test` | vitest — the Rust test suite ported: retry budget, failure classification, state semantics, permission predicates, migration, routing, i18n |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cf-typegen` | regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

Local note: outbound calls to `api.telegram.org` must be reachable from your network. Behind a firewall they hang on `getMe` — the gates (401/403/404) still work, full webhook behavior needs a deployment.

## CI

Every push and pull request runs typecheck, the test suite, and `npm audit`. Pushes to `main` also deploy — gated behind the repository variable `DEPLOY_ENABLED=1` plus the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, so nothing ships until you opt in.

## License

[MIT](LICENSE)
