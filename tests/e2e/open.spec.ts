import { expect, test } from "@playwright/test";

// An instance with sign-in off (WAKEWRIGHT__AUTH__MODE=none), as it runs
// behind an authenticating reverse proxy: the app opens straight away, with
// no setup or sign-in screen and no sign-out button.

test("opens the app with no setup or sign-in screen, not even briefly", async ({ page }) => {
  // Record every heading the page ever shows, from the first paint on.
  await page.addInitScript(() => {
    const headings: string[] = [];
    (window as unknown as { headings: string[] }).headings = headings;
    new MutationObserver(() => {
      for (const h of document.querySelectorAll("h1, h2")) {
        const text = h.textContent ?? "";
        if (!headings.includes(text)) headings.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No workers yet" })).toBeVisible();
  const headings = await page.evaluate(
    () => (window as unknown as { headings: string[] }).headings,
  );
  expect(headings.filter((h) => /set up|sign in/i.test(h))).toEqual([]);
});

test("the API answers without a session but still refuses cross-site writes", async ({
  request,
}) => {
  expect(await (await request.get("/api/v1/session")).json()).toEqual({
    state: "open",
    managed: false,
  });
  expect((await request.get("/api/v1/devices")).ok()).toBe(true);
  expect((await request.get("/api/v1/workers")).ok()).toBe(true);
  const signIn = await request.post("/api/v1/session", {
    data: { username: "admin", password: "x" },
  });
  expect(signIn.status()).toBe(409);
  const forged = await request.put("/api/v1/collection", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://evil.example",
    },
    data: "paused=true",
  });
  expect(forged.status()).toBe(403);
});
