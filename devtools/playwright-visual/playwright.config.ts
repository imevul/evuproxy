import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    trace: process.env.PWTRACE === "1" ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    video: process.env.PWVIDEO === "1" ? "retain-on-failure" : "off",
    viewport: { width: 1280, height: 720 },
  },
  expect: {
    timeout: 15_000,
  },
});
