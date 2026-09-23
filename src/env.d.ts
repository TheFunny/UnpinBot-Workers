// Secrets come from `wrangler secret put` (or .dev.vars locally), so the
// generated worker-configuration.d.ts never contains them. This global
// interface merges with the generated `interface Env`.

interface Env {
  /** Bot token from @BotFather. */
  TELOXIDE_TOKEN: string;
  /** `secret_token` handed to setWebhook; validated by grammY as the
   * X-Telegram-Bot-Api-Secret-Token header on every webhook request. */
  WEBHOOK_SECRET: string;
  /** Key required by POST /register (X-Register-Key header). */
  ADMIN_KEY: string;
}
