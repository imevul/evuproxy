/**
 * The Auto-paused banner and row badges. The state is runtime-only and comes from
 * GET /auto-pause, apart from config, and pausing must never read as the route being disabled.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";

import { SCHEMES, gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";
const auth = () => ({ Authorization: "Bearer " + token(), "Content-Type": "application/json" });

const CONFIG = {
  wireguard: { interface: "wg0", listen_port: 51820, private_key_file: "/key", address: "10.100.0.1/24" },
  network: { public_interface: "eth0" },
  forwarding: {
    routes: [
      { name: "Game", proto: "tcp", ports: ["25566", "25565"], target_ip: "10.100.0.2", pause_when_peer_offline: true },
      { proto: "both", ports: ["53"], target_ip: "10.100.0.2", pause_when_peer_offline: true },
      { proto: "tcp", ports: ["8080"], target_ip: "10.100.0.2" },
      { proto: "tcp", ports: ["9090"], target_ip: "10.100.0.3", pause_when_peer_offline: true, disabled: true },
    ],
  },
  geo: { enabled: false },
  input_allows: [],
  peers: [
    { name: "alpha", public_key: "k", tunnel_ip: "10.100.0.2/32" },
    { name: "beta", public_key: "l", tunnel_ip: "10.100.0.3/32" },
  ],
};

const GAME = { name: "Game", proto: "tcp", ports: ["25565", "25566"], target_ip: "10.100.0.2", peer: "alpha" };
const DNS = { proto: "tcp,udp", ports: ["53"], target_ip: "10.100.0.2", peer: "alpha" };
const DISABLED = { proto: "tcp", ports: ["9090"], target_ip: "10.100.0.3", peer: "beta" };

const banner = (page: Page) => page.locator("#routes-auto-paused");
const row = (page: Page, i: number) => page.locator(`#routes-table-wrap tr[data-row="${i}"]`);
const badge = (page: Page, i: number) => row(page, i).locator(".route-auto-paused-badge");

test.describe("Auto-paused on Routes", () => {
  /** What GET /auto-pause answers; a test changes it to act as the loop. */
  let paused: unknown[];

  async function open(page: Page, scheme: (typeof SCHEMES)[number] = "light") {
    await seed(page, { scheme });
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: CONFIG }));
    await page.route("**/api/v1/auto-pause", (route) => route.fulfill({ json: { paused_routes: paused } }));
    await gotoRoute(page, origin, "routes");
  }

  test.beforeEach(() => {
    paused = [];
  });

  test("nothing shows while no route is paused", async ({ page }) => {
    await open(page);
    await expect(row(page, 0)).toBeVisible();
    await expect(banner(page)).toBeHidden();
    await expect(page.locator(".route-auto-paused-badge")).toHaveCount(0);
  });

  test("the banner says which routes are paused and why", async ({ page }) => {
    paused = [GAME, DNS];
    await open(page);
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).locator(".evu-alert__title")).toHaveText("Auto-paused: 2 routes");
    await expect(banner(page).locator("li")).toHaveText(
      "Peer alpha is offline: Game (TCP 25565, 25566); TCP+UDP 53"
    );
  });

  test("one line per offline peer, and one route reads as singular", async ({ page }) => {
    paused = [GAME];
    await open(page);
    await expect(banner(page).locator(".evu-alert__title")).toHaveText("Auto-paused: 1 route");

    paused = [GAME, { ...DISABLED, peer: "beta", ports: ["7000"] }];
    await page.locator("#routes-refresh").click();
    await expect(banner(page).locator("li")).toHaveText([
      "Peer alpha is offline: Game (TCP 25565, 25566)",
      "Peer beta is offline: TCP 7000",
    ]);
  });

  test("names from the API are escaped", async ({ page }) => {
    paused = [{ ...GAME, name: "<img src=x>", peer: "<b>alpha</b>" }];
    await open(page);
    await expect(banner(page).locator("li")).toContainText("<b>alpha</b>");
    await expect(banner(page).locator("img, li b")).toHaveCount(0);
  });

  test("marks the paused rows, matching across port order and proto spelling", async ({ page }) => {
    paused = [GAME, DNS];
    await open(page);
    await expect(badge(page, 0)).toHaveText("Auto-paused");
    await expect(badge(page, 1)).toHaveText("Auto-paused");
    await expect(badge(page, 2)).toHaveCount(0);
    // Still enabled: pausing doesn't touch the user's setting.
    await expect(row(page, 0).locator("input[data-route-disabled]")).toBeChecked();
    await expect(row(page, 0)).not.toHaveClass(/is-row-disabled/);
  });

  test("a disabled row is never marked as paused", async ({ page }) => {
    paused = [DISABLED];
    await open(page);
    await expect(row(page, 3)).toHaveClass(/is-row-disabled/);
    await expect(badge(page, 3)).toHaveCount(0);
  });

  test("a sorted table keeps the badge on the right route", async ({ page }) => {
    paused = [GAME];
    await open(page);
    await page.locator("#routes-table-wrap thead").getByRole("button", { name: "Ports" }).click();
    await expect(badge(page, 0)).toHaveText("Auto-paused");
    await expect(page.locator(".route-auto-paused-badge")).toHaveCount(1);
  });

  test("polls while on the page, keeps focus, and stops after leaving", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await expect(banner(page)).toBeHidden();

    const focused = row(page, 2).locator("input[data-route-disabled]");
    await focused.focus();

    paused = [GAME];
    await page.clock.fastForward(15_000);
    await expect(banner(page)).toBeVisible();
    await expect(badge(page, 0)).toBeVisible();
    await expect(focused).toBeFocused();

    paused = [];
    await page.clock.fastForward(15_000);
    await expect(banner(page)).toBeHidden();
    await expect(badge(page, 0)).toHaveCount(0);

    let requests = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/v1/auto-pause")) requests++;
    });
    await page.goto(origin + "/#/inbound");
    await page.locator("#page-inbound").waitFor({ state: "visible" });
    await page.clock.fastForward(45_000);
    expect(requests).toBe(0);
  });

  test("a failed poll leaves what's on screen", async ({ page }) => {
    await page.clock.install();
    paused = [GAME];
    await open(page);
    await expect(banner(page)).toBeVisible();

    await page.route("**/api/v1/auto-pause", (route) => route.fulfill({ status: 500, json: { error: "no" } }));
    await page.clock.fastForward(15_000);
    await expect(banner(page)).toBeVisible();
    await expect(badge(page, 0)).toBeVisible();
  });

  for (const scheme of SCHEMES) {
    test(`banner and badges pass axe (${scheme})`, async ({ page }) => {
      paused = [GAME, DNS];
      await open(page, scheme);
      await expect(banner(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include("#page-routes")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe("mock API auto-pause state", () => {
  const url = (path: string) => origin + "/api/v1" + path;

  const getJson = async (request: APIRequestContext, path: string) =>
    (await request.get(url(path), { headers: auth() })).json();

  /**
   * In a confirm session, because the mock is shared: a plain reload would leave applied
   * history behind, which shows Restore previous applied to whichever spec runs next.
   * Reverting the session restores that history too.
   */
  const apply = (request: APIRequestContext) =>
    request.post(url("/reload"), { headers: auth(), data: { confirm_timeout_seconds: 600 } });

  let saved: any;
  let pendingBefore: any;

  test.beforeEach(async ({ request }) => {
    saved = await getJson(request, "/config");
    pendingBefore = await getJson(request, "/pending");
  });

  test.afterEach(async ({ request }) => {
    await request.post(url("/apply/revert"), { headers: auth() });
    await request.post(url("/apply/reverted/dismiss"), { headers: auth() });
    await request.put(url("/config"), { headers: auth(), data: saved });
    expect(await getJson(request, "/pending")).toEqual(pendingBefore);
  });

  test("a route with the setting pauses after Apply when its peer is offline", async ({ page, request }) => {
    await seed(page, { scheme: "light" });

    // The mock's last peer has no handshake; any earlier peer is online.
    const peers = [
      { name: "up", public_key: "AAAA", tunnel_ip: "10.100.0.2/32" },
      { name: "down", public_key: "BBBB", tunnel_ip: "10.100.0.3/32" },
    ];
    const routes = [
      { name: "Down", proto: "tcp", ports: ["7000"], target_ip: "10.100.0.3", pause_when_peer_offline: true },
      { proto: "tcp", ports: ["7001"], target_ip: "10.100.0.2", pause_when_peer_offline: true },
      { proto: "tcp", ports: ["7002"], target_ip: "10.100.0.3" },
    ];
    const res = await request.put(url("/config"), {
      headers: auth(),
      data: { ...saved, peers, forwarding: { ...saved.forwarding, routes } },
    });
    expect(res.ok()).toBeTruthy();

    // Saved but not applied, so the loop wouldn't know about it yet.
    const before = await getJson(request, "/auto-pause");
    expect(before.paused_routes.map((r: any) => r.name)).not.toContain("Down");

    expect((await apply(request)).ok()).toBeTruthy();
    const after = await getJson(request, "/auto-pause");
    expect(after.paused_routes).toEqual([
      { name: "Down", proto: "tcp", ports: ["7000"], target_ip: "10.100.0.3", peer: "down" },
    ]);

    await gotoRoute(page, origin, "routes");
    await expect(banner(page).locator("li")).toHaveText("Peer down is offline: Down (TCP 7000)");
    await expect(badge(page, 0)).toBeVisible();
    await expect(page.locator(".route-auto-paused-badge")).toHaveCount(1);
  });

  test("Pending changes names the setting when it changes", async ({ page, request }) => {
    await seed(page, { scheme: "light" });
    const route = saved.forwarding.routes[0];
    expect((await apply(request)).ok()).toBeTruthy();
    const res = await request.put(url("/config"), {
      headers: auth(),
      data: {
        ...saved,
        forwarding: { ...saved.forwarding, routes: [{ ...route, pause_when_peer_offline: true }, ...saved.forwarding.routes.slice(1)] },
      },
    });
    expect(res.ok()).toBeTruthy();
    await gotoRoute(page, origin, "pending");
    await expect(page.locator("#page-pending")).toContainText("pause when peer is offline changed");
  });
});
