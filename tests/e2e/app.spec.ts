import { expect, test } from "@playwright/test";

// The user's path through a fresh instance, in order: first-run setup,
// sign out, sign in. Later steps build on earlier ones, so run serially.
test.describe.configure({ mode: "serial" });

const USERNAME = "admin";
const PASSWORD = "e2e correct horse battery";

test("first-run setup creates the admin account and signs in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up Wakewright" })).toBeVisible();
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("sign out, a wrong password, then sign in", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong username or password.");

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}
