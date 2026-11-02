// Used by run.sh: applies from the real panel in a real browser, waits for run.sh to press
// Keep (the file "press"), and writes what the page then showed to $BROWSER_OUT.
import { existsSync, renameSync, writeFileSync } from "node:fs";

import { chromium } from "playwright-core";

// Never outlive run.sh's wait: the container only goes away when the script ends.
setTimeout(() => process.exit(1), 300000).unref();

const out = process.env.BROWSER_OUT;
const until = async (file) => {
  while (!existsSync(file)) await new Promise((done) => setTimeout(done, 200));
};

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
process.on("SIGTERM", () => void browser.close().finally(() => process.exit(0)));
const page = await browser.newPage();
await page.addInitScript((token) => {
  localStorage.setItem("evuproxy_api_token", token);
  localStorage.setItem("evuproxy_api_base", "/api");
  localStorage.setItem("evuproxy_gh_release_check_v1", JSON.stringify({ t: Date.now(), tag: "v0.0.0" }));
}, process.env.TOKEN);

let pageLoadRequests = 0;
page.on("request", (request) => {
  if (new URL(request.url()).port === "9080") pageLoadRequests++;
});
await page.goto("http://127.0.0.1:9080/#/overview", { waitUntil: "load" });
await page.locator("#apply-bar-apply").click({ timeout: 30000 });
await page.locator("#apply-session-keep").waitFor({ state: "visible", timeout: 60000 });
const requestsAtKeepPrompt = pageLoadRequests;
writeFileSync("applied", "");

await until("press");
const note = page.locator("#apply-session-note");
const panel = page.locator("#apply-session");
const started = Date.now();
if (await page.locator("#apply-session-keep").isVisible()) await page.locator("#apply-session-keep").click();
// Whichever comes first: the panel closes because it was kept, or an error shows.
await Promise.race([
  panel.waitFor({ state: "hidden", timeout: 35000 }),
  note.and(page.locator(".err")).waitFor({ state: "visible", timeout: 35000 }),
]).catch(() => {});
const result = {
  kept: await panel.isHidden(),
  elapsedMs: Date.now() - started,
  note: await note.textContent(),
  detail: await page.locator("#apply-session-detail").textContent(),
  pageLoadRequests: requestsAtKeepPrompt,
};
const save = () => {
  writeFileSync(`${out}.tmp`, JSON.stringify(result));
  renameSync(`${out}.tmp`, out);
};
save();

// run.sh leaves the panel open until the host has settled, and a kept change has no more to show.
if (!result.kept) {
  await page.getByText("Reverted to the last confirmed config", { exact: false }).first().waitFor({ timeout: 90000 }).catch(() => {});
}
await until("finish");
result.afterRevert = (await page.locator("#apply-session-title").textContent()) || "";
save();
await browser.close();
