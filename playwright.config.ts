import { defineConfig, devices } from "@playwright/test";

// E2E tests (`mise run e2e`). By default Playwright builds dist/ and starts
// that production build with a throwaway data directory. CI sets
// E2E_BASE_URL to test the built container image instead.
const external = process.env.E2E_BASE_URL;
const port = 18080;

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
    ? undefined
    : {
        command: "bun run build && bun tests/e2e/serve-dist.ts",
        url: `http://127.0.0.1:${port}/readyz`,
        env: { WAKEWRIGHT__SERVER__PORT: String(port), WAKEWRIGHT__SERVER__HOST: "127.0.0.1" },
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
