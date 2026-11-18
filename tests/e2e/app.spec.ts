import { expect, type Page, test } from "@playwright/test";
import { scoreNumbers } from "../../apps/web/src/score.ts";
import { fakeVerdicts, runFakeWorker } from "../../devtools/fake-worker/src/worker.ts";

// The user's path through a fresh instance, in order: first-run setup,
// sign out and in, add the fake device, see its clips arrive, play one,
// then have the fake worker judge them and find the disagreements.
// Later steps build on earlier ones, so the file runs serially.
test.describe.configure({ mode: "serial" });

const USERNAME = "admin";
const PASSWORD = "e2e correct horse battery";
// Where the server under test reaches the fake device, and where the test does.
const DEVICE_URL = process.env.E2E_FAKE_KIOSK_URL ?? "http://127.0.0.1:23250";
const FAKE_CONTROL = "http://127.0.0.1:23250";
// The server under test's worker token (playwright.config.ts, ci.yml).
const WORKER_TOKEN = "e2e-worker-token-not-secret";

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
  const numbers = scoreNumbers(heard.score, heard.threshold);
  await expect(page.getByText(numbers.score, { exact: false }).first()).toBeVisible();

  const waveform = page.getByRole("img", { name: /^Waveform, 3\.00 s$/ });
  await expect(waveform).toBeVisible();
  await page.getByRole("button", { name: /^Play / }).click();
  await expect(page.getByRole("button", { name: /^Pause / })).toBeVisible();
  await expect(page.getByText(/^0\.\d\d s \/ 3\.00 s$/)).not.toBeVisible({ timeout: 5_000 });
});

test("the fake worker judges every clip, and the Disagreements filter finds them", async ({
  page,
  baseURL,
}) => {
  await signIn(page);
  await expect(page.getByText("No worker has connected yet")).toBeVisible();

  // What the judges will say about each clip: the fake's verdicts, counted
  // as the parent counts them (abstentions are not votes).
  const { clips } = await (await page.request.get("/api/v1/clips?pageSize=100")).json();
  const expected = new Map<string, string>();
  for (const clip of clips as { id: string; wakeWord: string }[]) {
    const audio = await (await page.request.get(`/api/v1/clips/${clip.id}/audio`)).body();
    const results = await fakeVerdicts(new Uint8Array(audio), clip.wakeWord, [
      "openwakeword",
      "microwakeword",
      "stt",
    ]);
    const yes = results.filter((r) => r.verdict === "yes").length;
    const no = results.filter((r) => r.verdict === "no").length;
    expected.set(
      clip.id,
      yes + no < 2 ? "inconclusive" : yes && no ? "disagree" : yes ? "agree_yes" : "agree_no",
    );
  }
  const disagreeing = [...expected].filter(([, a]) => a === "disagree").map(([id]) => id);
  // The fake device's clips must include a disagreement for this test to mean anything.
  expect(disagreeing.length).toBeGreaterThan(0);

  const controller = new AbortController();
  const worker = runFakeWorker({
    parentUrl: baseURL ?? "",
    token: WORKER_TOKEN,
    name: "e2e-worker",
    waitSeconds: 5,
    signal: controller.signal,
  });
  try {
    await expect
      .poll(async () => (await (await page.request.get("/api/v1/judging")).json()).waiting, {
        timeout: 20_000,
      })
      .toBe(0);

    await page.reload();
    await expect(page.getByText("e2e-worker connected")).toBeVisible();
    await page.getByRole("link", { name: /^\d+ disagreements?$/ }).click();
    await expect(page.getByLabel("Judges")).toHaveValue("disagree");
    await expect(page.getByRole("button", { name: /Disagreements/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const n = disagreeing.length;
    await expect(page.getByText(`1–${n} of ${n} clips`)).toBeVisible();
    const rows = page.getByRole("list", { name: "Clips" }).getByRole("listitem");
    await expect(rows).toHaveCount(n);
    await expect(rows.first()).toContainText(/\d of 3 yes/);

    // A disagreement's page shows each judge's verdict.
    await rows.first().getByRole("link").click();
    await expect(page.getByRole("heading", { name: "What the judges said" })).toBeVisible();
    await expect(page.getByText(/^The judges disagree/)).toBeVisible();
    for (const judge of ["openWakeWord", "microWakeWord", "Speech to text"]) {
      await expect(page.getByRole("heading", { name: judge })).toBeVisible();
    }

    // The quick filter turns off again.
    await page.getByRole("link", { name: "All clips" }).click();
    await page.getByRole("button", { name: /Disagreements/ }).click();
    await expect(page.getByLabel("Judges")).toHaveValue("");
    await expect(page.getByText(`of ${expected.size} clips`)).toBeVisible();
  } finally {
    controller.abort();
    await worker;
  }
});

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
}
