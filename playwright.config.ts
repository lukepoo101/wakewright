import { defineConfig, devices } from "@playwright/test";

// E2E tests (`mise run e2e`). By default Playwright builds dist/ and starts
// that production build with a throwaway data directory. CI sets
// E2E_BASE_URL to test the built container image instead.
//
// A fake Kiosk Satellite always starts on FAKE_PORT. The tests drive it at
// 127.0.0.1; the server under test reaches it at E2E_FAKE_KIOSK_URL (CI
// points that at the Docker host).
const external = process.env.E2E_BASE_URL;
const port = 18080;
const fakePort = 23250;
const fake = {
  command: `bun devtools/fake-kiosk/src/main.ts --host 0.0.0.0 --port ${fakePort} --name e2e-kiosk --initial 4`,
  url: `http://127.0.0.1:${fakePort}/api/health`,
  reuseExistingServer: false,
  timeout: 15_000,
};

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: external
    ? [fake]
    : [
        fake,
        {
          command: "bun run build && bun tests/e2e/serve-dist.ts",
          url: `http://127.0.0.1:${port}/readyz`,
          env: { WAKEWRIGHT__SERVER__PORT: String(port), WAKEWRIGHT__SERVER__HOST: "127.0.0.1" },
          reuseExistingServer: false,
          timeout: 30_000,
        },
      ],
});
