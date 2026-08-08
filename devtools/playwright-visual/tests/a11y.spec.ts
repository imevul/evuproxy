/**
 * axe-core accessibility gate for the admin UI.
 *
 * Fails on critical/serious violations only — moderate/minor findings are reported
 * in the console so regressions stay visible without blocking on advisory rules.
 * Runs in both colour schemes because contrast results differ between them.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Result } from "axe-core";

import { ROUTES, SCHEMES, gotoRoute, seed } from "./helpers";

const BLOCKING = new Set(["critical", "serious"]);

function format(violations: Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 5)
        .map((n) => {
          // The summary carries the numbers needed to act on a finding, e.g. the
          // measured contrast ratio and the two colours axe compared.
          const why = (n.failureSummary || "")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("Fix"))
            .join("; ");
          return [
            `      ${n.target.join(" ")}`,
            `        ${n.html.replace(/\s+/g, " ").slice(0, 160)}`,
            why ? `        ${why}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");
      const more = v.nodes.length > 5 ? `\n      … ${v.nodes.length - 5} more` : "";
      return `  [${v.impact}] ${v.id}: ${v.help}\n${targets}${more}\n      ${v.helpUrl}`;
    })
    .join("\n\n");
}

test.describe("accessibility (axe-core)", () => {
  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`a11y ${route} ${scheme}`, async ({ page, baseURL }) => {
        test.skip(!baseURL, "baseURL unset");
        await seed(page, { scheme });
        await gotoRoute(page, baseURL!, route);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();

        const blocking = results.violations.filter((v) => BLOCKING.has(v.impact || ""));
        const advisory = results.violations.filter((v) => !BLOCKING.has(v.impact || ""));

        if (advisory.length > 0) {
          console.log(`\nadvisory findings — ${route} (${scheme}):\n${format(advisory)}\n`);
        }

        // Assert on rule ids so a failure prints a short diff; the detail is in the message.
        const ids = blocking.map((v) => `${v.id} (${v.nodes.length})`);
        expect(ids, `blocking a11y violations on ${route} (${scheme}):\n${format(blocking)}`).toEqual([]);
      });
    }
  }
});
