import { describe, expect, test } from "bun:test";
import { Auth, LoginThrottle, SESSION_DAYS } from "../src/auth.ts";
import { FAST_HASH, migratedDb, ORIGIN, quietLog, testApi } from "./helpers.ts";

const PASSWORD = "correct horse battery";

describe("first-run setup", () => {
  test("reports setup until the admin exists, then signs the new admin in", async () => {
    const t = await testApi();
    expect(await (await t.request("/api/v1/session")).json()).toEqual({
      state: "setup",
      managed: false,
    });
    await t.setUp("luke", PASSWORD);
    expect(t.cookie).toStartWith("wakewright_session=");
    expect(await (await t.request("/api/v1/session")).json()).toEqual({
      state: "signed_in",
      user: { username: "luke" },
      managed: false,
    });
  });

  test("can run only once", async () => {
    const t = await testApi();
    await t.setUp();
    const again = await t.request("/api/v1/setup", {
      json: { username: "mallory", password: "another long password" },
    });
    expect(again.status).toBe(409);
  });

  test("two racing setups create one account", async () => {
    const t = await testApi();
    const body = (u: string) => ({ json: { username: u, password: PASSWORD } });
    const results = await Promise.all([
      t.request("/api/v1/setup", body("a")),
      t.request("/api/v1/setup", body("b")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(t.db.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("rejects a short password and a bad username", async () => {
    const t = await testApi();
    const short = await t.request("/api/v1/setup", { json: { username: "a", password: "short" } });
    expect(short.status).toBe(400);
    expect((await short.json()).message).toContain("at least 12");
    const bad = await t.request("/api/v1/setup", {
      json: { username: "no spaces", password: PASSWORD },
    });
    expect(bad.status).toBe(400);
  });

  test("is disabled when configuration manages the password", async () => {
    const t = await testApi({ managed: true });
    expect(
      (await t.request("/api/v1/setup", { json: { username: "a", password: PASSWORD } })).status,
    ).toBe(409);
  });

  test("stores an argon2id hash, never the password", async () => {
    const t = await testApi();
    await t.setUp("admin", PASSWORD);
    const row = t.db.query<{ password_hash: string }, []>("SELECT password_hash FROM users").get();
    expect(row?.password_hash).toStartWith("$argon2id$");
    expect(row?.password_hash).not.toContain(PASSWORD);
  });
});

describe("sign-in and sign-out", () => {
  test("sets a HttpOnly, SameSite=Lax session cookie; sign-out ends the session", async () => {
    const t = await testApi();
    await t.setUp();
    t.signOutLocally();
    const res = await t.request("/api/v1/session", {
      json: { username: "admin", password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const set = res.headers.get("Set-Cookie") ?? "";
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/); // plain http, no https public URL

    const cookie = t.cookie;
    expect((await t.request("/api/v1/session", { method: "DELETE" })).status).toBe(204);
    expect(t.cookie).toBeUndefined();
    // The old cookie no longer works: the session row is gone.
    const reused = await t.api.request(`${ORIGIN}/api/v1/session`, {
      headers: { Cookie: cookie ?? "" },
    });
    expect((await reused.json()).state).toBe("signed_out");
  });

  test("usernames are case-insensitive; a wrong password is a 401", async () => {
    const t = await testApi();
    await t.setUp("Admin", PASSWORD);
    t.signOutLocally();
    expect(
      (await t.request("/api/v1/session", { json: { username: "admin", password: PASSWORD } }))
        .status,
    ).toBe(200);
    const wrong = await t.request("/api/v1/session", {
      json: { username: "admin", password: "not the password" },
    });
    expect(wrong.status).toBe(401);
    const unknown = await t.request("/api/v1/session", {
      json: { username: "nobody", password: PASSWORD },
    });
    expect(unknown.status).toBe(401);
  });

  test("throttles repeated failures with 429 and Retry-After", async () => {
    const t = await testApi();
    await t.setUp();
    t.signOutLocally();
    const attempt = (password: string) =>
      t.request("/api/v1/session", { json: { username: "admin", password } });
    for (let i = 0; i < LoginThrottle.FREE_FAILURES; i++) {
      expect((await attempt("wrong")).status).toBe(401);
    }
    expect((await attempt("wrong")).status).toBe(401); // the 6th failure starts the lock
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("a cross-site form post is refused", async () => {
    const t = await testApi();
    const res = await t.api.request(`${ORIGIN}/api/v1/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "cross-site",
        Origin: "http://evil.example",
      },
      body: "username=admin&password=x",
    });
    expect(res.status).toBe(403);
  });

  test("a non-JSON body is refused", async () => {
    const t = await testApi();
    const res = await t.api.request(`${ORIGIN}/api/v1/setup`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ username: "a", password: PASSWORD }),
    });
    expect(res.status).toBe(415);
  });
});

describe("sessions", () => {
  test("slide forward with use and expire after SESSION_DAYS of disuse", async () => {
    const db = migratedDb();
    let now = Date.parse("2026-11-17T12:00:00Z");
    const auth = new Auth({
      db,
      log: quietLog,
      managed: false,
      now: () => now,
      hashOptions: FAST_HASH,
    });
    const setup = await auth.setup("admin", PASSWORD);
    if (!setup.ok) throw new Error("setup failed");
    const day = 86_400_000;

    now += day / 2;
    expect(auth.authenticate(setup.token)?.renewed).toBeUndefined();
    now += day;
    const renewed = auth.authenticate(setup.token)?.renewed;
    expect(renewed?.getTime()).toBe(now + SESSION_DAYS * day);

    now += SESSION_DAYS * day + 1;
    expect(auth.authenticate(setup.token)).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("a made-up token is not a session", async () => {
    const auth = new Auth({
      db: migratedDb(),
      log: quietLog,
      managed: false,
      hashOptions: FAST_HASH,
    });
    expect(auth.authenticate("nope")).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
  });
});

describe("admin password from configuration", () => {
  test("creates the account, then follows a changed password and ends old sessions", async () => {
    const db = migratedDb();
    const auth = new Auth({ db, log: quietLog, managed: true, hashOptions: FAST_HASH });
    await auth.applyConfiguredAdmin({ username: "admin", password: PASSWORD });
    const first = await auth.login("admin", PASSWORD, "test");
    if (!first.ok) throw new Error("login failed");

    // Same configuration again: nothing changes, the session survives.
    await auth.applyConfiguredAdmin({ username: "admin", password: PASSWORD });
    expect(auth.authenticate(first.token)).not.toBeNull();

    // A rotated secret replaces the password and signs everyone out.
    await auth.applyConfiguredAdmin({ username: "owner", password: "a brand new password" });
    expect(auth.authenticate(first.token)).toBeNull();
    expect((await auth.login("owner", PASSWORD, "test")).ok).toBe(false);
    expect((await auth.login("owner", "a brand new password", "test")).ok).toBe(true);
    expect(db.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });
});

describe("sign-in off (auth mode none)", () => {
  test("the session is open, with no setup and no cookie", async () => {
    const t = await testApi({ mode: "none" });
    const res = await t.request("/api/v1/session");
    expect(await res.json()).toEqual({ state: "open", managed: false });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("the API answers without a session; pausing records no user", async () => {
    const t = await testApi({ mode: "none" });
    expect((await t.request("/api/v1/devices")).status).toBe(200);
    expect((await t.request("/api/v1/clips")).status).toBe(200);
    const paused = await t.request("/api/v1/collection", { method: "PUT", json: { paused: true } });
    expect(paused.status).toBe(200);
    expect(t.db.query("SELECT started_by FROM collection_pauses").get()).toEqual({
      started_by: null,
    });
    expect(t.cookie).toBeUndefined();
  });

  test("setup, sign-in and sign-out answer 409 and create nothing", async () => {
    const t = await testApi({ mode: "none" });
    const credentials = { json: { username: "admin", password: PASSWORD } };
    for (const res of [
      await t.request("/api/v1/setup", credentials),
      await t.request("/api/v1/session", credentials),
      await t.request("/api/v1/session", { method: "DELETE" }),
    ]) {
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("auth_off");
    }
    expect(t.db.query("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(t.cookie).toBeUndefined();
  });

  test("cross-site writes are still refused", async () => {
    const t = await testApi({ mode: "none" });
    const res = await t.api.request(`${ORIGIN}/api/v1/collection`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "cross-site",
        Origin: "http://evil.example",
      },
      body: "paused=true",
    });
    expect(res.status).toBe(403);
    const json = await t.api.request(`${ORIGIN}/api/v1/collection`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ paused: true }),
    });
    expect(json.status).toBe(415);
  });

  test("health checks stay open", async () => {
    const t = await testApi({ mode: "none" });
    expect((await t.request("/healthz")).status).toBe(200);
    expect((await t.request("/readyz")).status).toBe(200);
  });
});

describe("LoginThrottle", () => {
  test("doubles the lock after the free failures, caps it, and forgets", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < LoginThrottle.FREE_FAILURES; i++) throttle.fail("a");
    expect(throttle.retryAfter("a")).toBe(0);
    throttle.fail("a");
    expect(throttle.retryAfter("a")).toBe(1);
    throttle.fail("a");
    expect(throttle.retryAfter("a")).toBe(2);
    for (let i = 0; i < 30; i++) throttle.fail("a");
    expect(throttle.retryAfter("a")).toBe(LoginThrottle.MAX_LOCK_MS / 1000);
    expect(throttle.retryAfter("b")).toBe(0);

    now += LoginThrottle.MAX_LOCK_MS + 1;
    expect(throttle.retryAfter("a")).toBe(0);
    throttle.fail("a"); // forgotten, so this is the first failure again
    expect(throttle.retryAfter("a")).toBe(0);
  });

  test("a successful sign-in clears the record", () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 8; i++) throttle.fail("a");
    throttle.succeed("a");
    expect(throttle.retryAfter("a")).toBe(0);
  });
});
