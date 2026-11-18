import { expect, type Page, test } from "@playwright/test";

// The user's path through a fresh instance, in order: first-run setup,
// sign out and in, add the fake device, see its clips arrive, play one.
// Later steps build on earlier ones, so the file runs serially.
test.describe.configure({ mode: "serial" });

const USERNAME = "admin";
const PASSWORD = "e2e correct horse battery";
// Where the server under test reaches the fake device, and where the test does.
const DEVICE_URL = process.env.E2E_FAKE_KIOSK_URL ?? "http://127.0.0.1:23250";
const FAKE_CONTROL = "http://127.0.0.1:23250";

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
  await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
});

test("add the device: a wrong password is refused, then it connects", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Add a device" }).click();
  await page.getByLabel("Name").fill("Kitchen");
  await page.getByLabel("Address").fill(DEVICE_URL);
  await page.getByLabel("Remote administration password").fill("wrong");
  await page.getByRole("button", { name: "Add device" }).click();
  await expect(page.getByText("The device rejected the password").first()).toBeVisible();

  await page.getByLabel("Remote administration password").fill("dev");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connected to “e2e-kiosk”")).toBeVisible();
  await page.getByRole("button", { name: "Add device" }).click();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "4 clips" })).toBeVisible({ timeout: 15_000 });
});

test("a new clip appears and plays with its waveform", async ({ page, request }) => {
  await signIn(page);
  const heard = await (await request.post(`${FAKE_CONTROL}/_fake/hear`, { data: {} })).json();
  await page.goto("/devices");
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("link", { name: "5 clips" })).toBeVisible();
  await page.getByRole("link", { name: "Clips", exact: true }).click();
  await expect(page.getByText(/of 5 clips/)).toBeVisible();

  // Keyboard: the newest row first, Enter opens it.
  const rows = page.getByRole("list", { name: "Clips" }).getByRole("listitem");
  await rows.first().getByRole("link").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "What the device reported" })).toBeVisible();
  await expect(page.getByText(`${heard.score.toFixed(2)}`, { exact: false }).first()).toBeVisible();

  const waveform = page.getByRole("img", { name: /^Waveform, 3\.00 s$/ });
  await expect(waveform).toBeVisible();
  await page.getByRole("button", { name: /^Play / }).click();
  await expect(page.getByRole("button", { name: /^Pause / })).toBeVisible();
  await expect(page.getByText(/^0\.\d\d s \/ 3\.00 s$/)).not.toBeVisible({ timeout: 5_000 });
});

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
}
