/**
 * The `test` every spec imports: fails a test on any Content-Security-Policy violation
 * in its browser console, so a change the policy would break is caught by whichever
 * spec reaches it. Import from here, not from "@playwright/test".
 */
import { expect, test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * axe-core, not the UI, downloads the Google Fonts stylesheet with XHR for its CSS analysis, and
 * connect-src rightly refuses it. Only css-orientation-lock uses that data, and our CSS has no
 * orientation queries, so nothing is lost. The UI itself loads that sheet with a <link>.
 */
const AXE_FONT_FETCH = /^Connecting to 'https:\/\/fonts\.googleapis\.com\//;

export const isCspViolation = (text: string): boolean =>
  /Content Security Policy/i.test(text) && !AXE_FONT_FETCH.test(text);

export const test = base.extend<{ noCspViolations: void }>({
  noCspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      context.on("console", (msg) => {
        if (isCspViolation(msg.text())) violations.push(msg.text());
      });
      await use();
      expect(violations, "Content-Security-Policy violations in the console").toEqual([]);
    },
    { auto: true },
  ],
});
