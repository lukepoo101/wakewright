import { defineConfig, devices } from "@playwright/test";

// E2E tests (`mise run e2e`). By default Playwright builds dist/ and starts
// that production build with a throwaway data directory. CI sets
// E2E_BASE_URL to test the built container image instead.
//
// A second instance with sign-in off (WAKEWRIGHT__AUTH__MODE=none) runs the
// `open` project's tests: locally on openPort, in CI at E2E_OPEN_BASE_URL.
// Against an external server without that variable the project is left out.
//
// The main server under test declares one worker, "e2e-declared" (CI
// passes the same value to the image), and the tests run the fake worker
// in-process with its token or one created in the UI.
//
// A fake Kiosk Satellite always starts on FAKE_PORT. The tests drive it at
// 127.0.0.1; the server under test reaches it at E2E_FAKE_KIOSK_URL (CI
// points that at the Docker host).
const external = process.env.E2E_BASE_URL;
const openExternal = process.env.E2E_OPEN_BASE_URL;
const port = 18080;
const openPort = 18081;
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
  projects: [
    {
      name: "chromium",
      testIgnore: "open.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    ...(external && !openExternal
      ? []
      : [
          {
            name: "open",
            testMatch: "open.spec.ts",
            use: {
              ...devices["Desktop Chrome"],
              baseURL: openExternal ?? `http://127.0.0.1:${openPort}`,
            },
          },
        ]),
  ],
  webServer: external
    ? [fake]
    : [
        fake,
        {
          command: "bun run build && bun tests/e2e/serve-dist.ts",
          url: `http://127.0.0.1:${port}/readyz`,
          env: {
            WAKEWRIGHT__SERVER__PORT: String(port),
            WAKEWRIGHT__SERVER__HOST: "127.0.0.1",
            WAKEWRIGHT__WORKERS__E2E_DECLARED__TOKEN: "e2e-worker-token-not-secret",
          },
          reuseExistingServer: false,
          timeout: 30_000,
        },
        // Started after the one above, so dist/ is already built.
        {
          command: "bun tests/e2e/serve-dist.ts",
          url: `http://127.0.0.1:${openPort}/readyz`,
          env: {
            WAKEWRIGHT__SERVER__PORT: String(openPort),
            WAKEWRIGHT__SERVER__HOST: "127.0.0.1",
            WAKEWRIGHT__AUTH__MODE: "none",
          },
          reuseExistingServer: false,
          timeout: 30_000,
        },
      ],
});
