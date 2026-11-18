import { expect, test } from "@playwright/test";

// The server serves the SPA, and the SPA reaches the server's API.
test("the SPA loads without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByText("Wakewright").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a client-side route survives a reload", async ({ page }) => {
  const res = await page.goto("/some/client/route");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["cache-control"]).toBe("no-cache");
  await expect(page.getByText("Wakewright").first()).toBeVisible();
});

test("the API document is served next to the SPA", async ({ request }) => {
  const res = await request.get("/api/openapi.json");
  expect(res.ok()).toBe(true);
  expect((await res.json()).openapi).toBe("3.1.0");
});

test("the API needs a session and refuses cross-site writes", async ({ request }) => {
  expect((await request.get("/api/v1/session")).ok()).toBe(true);
  const forged = await request.post("/api/v1/session", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://evil.example",
    },
    data: "username=admin&password=x",
  });
  expect(forged.status()).toBe(403);
});
