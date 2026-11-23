import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 20000,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium-mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
