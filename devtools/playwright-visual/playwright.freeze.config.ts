/**
 * Settings for frozen captures (see tests/freeze.ts). No retries: a retry would hide
 * the flakiness being measured.
 */
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

export default defineConfig({
  ...base,
  retries: 0,
  use: {
    ...base.use,
    locale: "en-US",
    timezoneId: "UTC",
    launchOptions: { args: ["--disable-gpu", "--disable-lcd-text"] },
  },
});
