import { expect, test } from "@playwright/test";

// The server serves the SPA, and the SPA reaches the server's API.
test("the SPA loads and shows the server's health", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Wakewright" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(/Server running, version \d+\.\d+\.\d+/);
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
