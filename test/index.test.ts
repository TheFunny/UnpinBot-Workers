import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = (over: Partial<Env> = {}): Env =>
  ({
    TELOXIDE_TOKEN: "0:t",
    WEBHOOK_SECRET: "hook",
    ADMIN_KEY: "adm",
    DB: {} as D1Database,
    ...over,
  }) as Env;

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://bot.example${path}`, { method: "POST", headers });

describe("endpoint gates", () => {
  it("rejects /tg without the secret", async () => {
    const res = await worker.fetch(req("/tg"), env());
    expect(res.status).toBe(401);
  });

  it("rejects /tg with a wrong secret", async () => {
    const res = await worker.fetch(
      req("/tg", { "X-Telegram-Bot-Api-Secret-Token": "nope" }),
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects /register without the key", async () => {
    const res = await worker.fetch(req("/register"), env());
    expect(res.status).toBe(403);
  });

  it("never lets an unset secret authenticate", async () => {
    const bare = env({
      WEBHOOK_SECRET: undefined as unknown as string,
      ADMIN_KEY: undefined as unknown as string,
    });
    const tg = await worker.fetch(req("/tg"), bare);
    expect(tg.status).toBe(401);
    // An unauthenticated probe is refused like any wrong key and told
    // nothing: a 500 naming the unset secret was a configuration oracle.
    const reg = await worker.fetch(req("/register"), bare);
    expect(reg.status).toBe(403);
    expect(await reg.text()).not.toContain("ADMIN_KEY");
    // The operator who does hold the key still gets the setup error.
    const unhooked = env({ WEBHOOK_SECRET: undefined as unknown as string });
    const keyed = await worker.fetch(req("/register", { "X-Register-Key": "adm" }), unhooked);
    expect(keyed.status).toBe(500);
    expect(await keyed.text()).toContain("WEBHOOK_SECRET is not set");
  });

  it("404s everything else", async () => {
    expect((await worker.fetch(req("/nope"), env())).status).toBe(404);
  });

  it("answers /health without secrets or a body", async () => {
    const bare = env({
      WEBHOOK_SECRET: undefined as unknown as string,
      ADMIN_KEY: undefined as unknown as string,
    });
    const res = await worker.fetch(new Request("https://bot.example/health"), bare);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // GET only: a POST there is still a 404, not a second way in.
    expect((await worker.fetch(req("/health"), env())).status).toBe(404);
  });
});
