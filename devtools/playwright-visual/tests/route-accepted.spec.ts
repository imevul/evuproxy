/**
 * The Accepted column on Routes. The counts come from GET /stats route_accepted, which
 * describes the applied config, while the rows come from the saved one.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";

import { SCHEMES, gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const CONFIG = {
  wireguard: { interface: "wg0", listen_port: 51820, private_key_file: "/key", address: "10.100.0.1/24" },
  network: { public_interface: "eth0" },
  forwarding: {
    routes: [
      { name: "Game", proto: "tcp", ports: ["25566", "25565"], target_ip: "10.100.0.2" },
      { proto: "tcp,udp", ports: ["53"], target_ip: "10.100.0.2" },
      { proto: "tcp", ports: ["8080"], target_ip: "10.100.0.2" },
      { proto: "tcp", ports: ["9090"], target_ip: "10.100.0.3", disabled: true },
    ],
  },
  geo: { enabled: false },
  input_allows: [],
  peers: [
    { name: "alpha", public_key: "k", tunnel_ip: "10.100.0.2/32" },
    { name: "beta", public_key: "l", tunnel_ip: "10.100.0.3/32" },
  ],
};

const counter = (route_index: number, proto: string, ports: string[], packets: number, bytes: number) => ({
  route_index,
  proto,
  ports,
  target_ip: "10.100.0.2",
  packets,
  bytes,
});

const GAME = counter(0, "tcp", ["25565", "25566"], 1234567, 7082475);
const DNS_TCP = counter(1, "tcp", ["53"], 1000, 2048);
const DNS_UDP = counter(1, "udp", ["53"], 500, 1024);

const row = (page: Page, i: number) => page.locator(`#routes-table-wrap tr[data-row="${i}"]`);
const cell = (page: Page, i: number) => row(page, i).locator(".route-accepted-cell");
const fmt = (n: number) => n.toLocaleString("en-US");

test.describe("Accepted on Routes", () => {
  /** What GET /stats answers; a test changes it to act as the host. */
  let accepted: unknown;
  /** What GET /config answers. */
  let config: unknown;

  const withRoutes = (routes: unknown[]) => ({ ...CONFIG, forwarding: { routes } });

  async function open(page: Page, scheme: (typeof SCHEMES)[number] = "light") {
    await seed(page, { scheme });
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: config }));
    await page.route("**/api/v1/stats", (route) => route.fulfill({ json: { route_accepted: accepted } }));
    await gotoRoute(page, origin, "routes");
    await expect(row(page, 0)).toBeVisible();
    // The rows don't wait for GET /stats, and these tests start from its answer.
    await expect(cell(page, 0)).not.toHaveText("…");
  }

  test.beforeEach(() => {
    accepted = [GAME, DNS_TCP, DNS_UDP];
    config = CONFIG;
  });

  test("shows readable packets and bytes, with the column in the table", async ({ page }) => {
    await open(page);
    await expect(page.locator("#routes-table-wrap thead").getByRole("button", { name: "Accepted" })).toBeVisible();
    await expect(cell(page, 0)).toHaveText(`${fmt(1234567)} pkts · 6.8 MiB`);
    await expect(cell(page, 0)).toHaveCSS("font-variant-numeric", "tabular-nums");
  });

  test("the hover text says what the number is not", async ({ page }) => {
    await open(page);
    await expect(cell(page, 0)).toHaveAttribute("title", /Accepted traffic since the last Apply, not players or legitimate clients/);
  });

  test("adds up both protocols and splits them on hover", async ({ page }) => {
    await open(page);
    await expect(cell(page, 1)).toHaveText(`${fmt(1500)} pkts · 3 KiB`);
    await expect(cell(page, 1)).toHaveAttribute("title", /TCP: 1,000 packets, 2 KiB; UDP: 500 packets, 1 KiB/);
  });

  test("a protocol without a count still shows the other", async ({ page }) => {
    accepted = [DNS_UDP];
    await open(page);
    await expect(cell(page, 1)).toHaveText("500 pkts · 1 KiB");
    await expect(cell(page, 1)).toHaveAttribute("title", /TCP: no count; UDP: 500 packets, 1 KiB/);
  });

  test("zero is a count, not missing data", async ({ page }) => {
    accepted = [counter(2, "tcp", ["8080"], 0, 0)];
    await open(page);
    await expect(cell(page, 2)).toHaveText("0 pkts · 0 B");
  });

  test("routes with no data show a dash that explains itself", async ({ page }) => {
    await open(page);
    for (const i of [2, 3]) {
      await expect(cell(page, i)).toHaveText("—");
      await expect(cell(page, i)).toHaveAttribute("title", /No count for this route/);
    }
  });

  for (const [name, value] of [
    ["an empty list", []],
    ["an API without the field", undefined],
  ] as const) {
    test(`${name} leaves every route without data`, async ({ page }) => {
      accepted = value;
      await open(page);
      for (const i of [0, 1, 2, 3]) await expect(cell(page, i)).toHaveText("—");
    });
  }

  test("the table still loads when GET /stats fails", async ({ page }) => {
    await seed(page, { scheme: "light" });
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: CONFIG }));
    await page.route("**/api/v1/stats", (route) => route.fulfill({ status: 500, json: { error: "no" } }));
    await gotoRoute(page, origin, "routes");
    await expect(row(page, 0)).toBeVisible();
    await expect(cell(page, 0)).toHaveText("—");
    await expect(page.locator("#routes-msg")).toHaveText("");
  });

  /**
   * Opens Routes with GET /stats held until the returned function is called with what to answer.
   * Not gotoRoute: it waits for the network to go idle, which a held request never lets it.
   */
  async function openWithStatsHeld(page: Page) {
    let release: (answer: { status: number; json: unknown }) => void = () => {};
    const answer = new Promise<{ status: number; json: unknown }>((resolve) => (release = resolve));
    await seed(page, { scheme: "light" });
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: CONFIG }));
    await page.route("**/api/v1/stats", async (route) => route.fulfill(await answer));
    await page.goto(origin + "/#/routes");
    return release;
  }

  test("the rows draw without waiting for GET /stats, and the counts follow", async ({ page }) => {
    const release = await openWithStatsHeld(page);
    await expect(row(page, 0)).toBeVisible();
    await expect(cell(page, 0)).toHaveText("…");
    await expect(cell(page, 0)).toHaveAttribute("title", /Loading/);

    release({ status: 200, json: { route_accepted: accepted } });
    await expect(cell(page, 0)).toHaveText(`${fmt(1234567)} pkts · 6.8 MiB`);
    await expect(cell(page, 2)).toHaveText("—");
  });

  test("a held GET /stats that fails ends in a dash, not a wait", async ({ page }) => {
    const release = await openWithStatsHeld(page);
    await expect(cell(page, 0)).toHaveText("…");

    release({ status: 500, json: { error: "no" } });
    await expect(cell(page, 0)).toHaveText("—");
    await expect(cell(page, 0)).toHaveAttribute("title", /No count for this route/);
  });

  test("sorting by Accepted while the counts load orders the rows once they arrive", async ({ page }) => {
    accepted = [counter(0, "tcp", ["25565", "25566"], 9, 1), counter(1, "udp", ["53"], 100, 1)];
    const release = await openWithStatsHeld(page);
    await expect(cell(page, 0)).toHaveText("…");
    const sort = page.locator("#routes-table-wrap thead").getByRole("button", { name: "Accepted" });
    await sort.click();
    await sort.click();

    release({ status: 200, json: { route_accepted: accepted } });
    await expect
      .poll(() => page.locator("#routes-table-wrap tr[data-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row"))))
      .toEqual(["1", "0", "2", "3"]);
  });

  test("matches by route, not by position in the applied config", async ({ page }) => {
    // Saved routes were reordered since the last Apply, so these indexes point elsewhere.
    accepted = [{ ...GAME, route_index: 2 }, counter(0, "tcp", ["8080"], 77, 1024)];
    await open(page);
    await expect(cell(page, 0)).toHaveText(`${fmt(1234567)} pkts · 6.8 MiB`);
    await expect(cell(page, 2)).toHaveText("77 pkts · 1 KiB");
  });

  test("a route edited since the last Apply has no count yet", async ({ page }) => {
    // Applied with other ports and another target than the saved routes now have.
    accepted = [counter(0, "tcp", ["25565"], 5, 5), { ...counter(2, "tcp", ["8080"], 5, 5), target_ip: "10.100.0.9" }];
    await open(page);
    await expect(cell(page, 0)).toHaveText("—");
    await expect(cell(page, 2)).toHaveText("—");
  });

  test("a route disabled since the last Apply keeps its count while its rule is live", async ({ page }) => {
    config = withRoutes([{ proto: "tcp", ports: ["8080"], target_ip: "10.100.0.2", disabled: true }]);
    accepted = [counter(0, "tcp", ["8080"], 77, 1024)];
    await open(page);
    await expect(cell(page, 0)).toHaveText("77 pkts · 1 KiB");
  });

  const TWIN = { proto: "tcp", ports: ["25565"], target_ip: "10.100.0.2" };

  for (const [name, routes, enabled, disabled] of [
    ["after", [TWIN, { ...TWIN, disabled: true }], 0, 1],
    ["before", [{ ...TWIN, disabled: true }, TWIN], 1, 0],
  ] as const) {
    test(`a disabled route ${name} its enabled twin doesn't show the twin's count`, async ({ page }) => {
      config = withRoutes([...routes]);
      accepted = [counter(0, "tcp", ["25565"], 77, 1024)];
      await open(page);
      await expect(cell(page, enabled)).toHaveText("77 pkts · 1 KiB");
      await expect(cell(page, disabled)).toHaveText("—");
      await expect(cell(page, disabled)).toHaveAttribute("title", /No count for this route/);
    });
  }

  test("a disabled twin sorts as no data", async ({ page }) => {
    config = withRoutes([
      { proto: "tcp", ports: ["8080"], target_ip: "10.100.0.2" },
      { ...TWIN, disabled: true },
      TWIN,
    ]);
    accepted = [counter(0, "tcp", ["8080"], 5, 1), counter(1, "tcp", ["25565"], 77, 1)];
    await open(page);
    const sort = page.locator("#routes-table-wrap thead").getByRole("button", { name: "Accepted" });
    const order = () =>
      page.locator("#routes-table-wrap tr[data-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row")));
    await sort.click();
    await expect.poll(order).toEqual(["0", "2", "1"]);
    await sort.click();
    await expect.poll(order).toEqual(["2", "0", "1"]);
  });

  test("two disabled twins show no count, since it could be either's", async ({ page }) => {
    config = withRoutes([
      { ...TWIN, disabled: true },
      { ...TWIN, disabled: true },
    ]);
    accepted = [counter(0, "tcp", ["25565"], 77, 1024)];
    await open(page);
    await expect(cell(page, 0)).toHaveText("—");
    await expect(cell(page, 1)).toHaveText("—");
  });

  test("a disabled route with both protocols keeps the one no enabled route shares", async ({ page }) => {
    config = withRoutes([TWIN, { ...TWIN, proto: "tcp,udp", disabled: true }]);
    accepted = [counter(0, "tcp", ["25565"], 77, 1024), counter(1, "udp", ["25565"], 5, 1024)];
    await open(page);
    await expect(cell(page, 0)).toHaveText("77 pkts · 1 KiB");
    await expect(cell(page, 1)).toHaveText("5 pkts · 1 KiB");
    await expect(cell(page, 1)).toHaveAttribute("title", /TCP: no count; UDP: 5 packets, 1 KiB/);
  });

  test("sorts by packets as numbers, with no data last either way", async ({ page }) => {
    accepted = [counter(0, "tcp", ["25565", "25566"], 9, 1), counter(1, "udp", ["53"], 100, 1)];
    await open(page);
    const sort = page.locator("#routes-table-wrap thead").getByRole("button", { name: "Accepted" });
    const order = () =>
      page.locator("#routes-table-wrap tr[data-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row")));
    await sort.click();
    await expect.poll(order).toEqual(["0", "1", "2", "3"]);
    await sort.click();
    await expect.poll(order).toEqual(["1", "0", "2", "3"]);
  });

  test("a poll updates the digits in place, without animation, focus loss or a new row", async ({ page }) => {
    await page.clock.install();
    await open(page);
    const focused = row(page, 2).locator("input[data-route-disabled]");
    await focused.focus();
    await page.evaluate(() => {
      (window as any).__acceptedRow = document.querySelector('#routes-table-wrap tr[data-row="0"]');
    });

    accepted = [{ ...GAME, packets: 1234568 }, DNS_TCP, DNS_UDP];
    await page.clock.fastForward(15_000);
    await expect(cell(page, 0)).toHaveText(`${fmt(1234568)} pkts · 6.8 MiB`);
    await expect(focused).toBeFocused();
    expect(
      await page.evaluate(() => (window as any).__acceptedRow === document.querySelector('#routes-table-wrap tr[data-row="0"]'))
    ).toBe(true);
    expect(await cell(page, 0).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await cell(page, 0).evaluate((el) => !!el.closest("[aria-live]"))).toBe(false);
  });

  test("a poll that changes nothing leaves the cell's nodes alone", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await page.evaluate(() => {
      (window as any).__acceptedUnit = document.querySelector('tr[data-row="0"] .route-accepted-cell span');
    });
    const stats = page.waitForResponse("**/api/v1/stats");
    await page.clock.fastForward(15_000);
    await stats;
    expect(
      await page.evaluate(
        () => (window as any).__acceptedUnit === document.querySelector('tr[data-row="0"] .route-accepted-cell span')
      )
    ).toBe(true);
  });

  test("a failed poll leaves what's on screen, and leaving the page stops polling", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await page.route("**/api/v1/stats", (route) => route.fulfill({ status: 500, json: { error: "no" } }));
    const failed = page.waitForResponse("**/api/v1/stats");
    await page.clock.fastForward(15_000);
    await failed;
    await expect(cell(page, 0)).toHaveText(`${fmt(1234567)} pkts · 6.8 MiB`);

    await page.goto(origin + "/#/inbound");
    await page.locator("#page-inbound").waitFor({ state: "visible" });
    let requests = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/v1/stats")) requests++;
    });
    await page.clock.fastForward(45_000);
    expect(requests).toBe(0);
  });

  test("a row error still spans every column", async ({ page }) => {
    await open(page);
    await page.route("**/api/v1/config", (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: CONFIG }) : route.fulfill({ status: 500, json: { error: "no" } })
    );
    await row(page, 2).locator("label.evu-switch").click();
    const error = page.locator("#routes-table-wrap tr.row-error td");
    await expect(error).toBeVisible();
    const columns = await page.locator("#routes-table-wrap thead th").count();
    await expect(error).toHaveAttribute("colspan", String(columns));
  });

  test("the page's help says what Accepted means", async ({ page }) => {
    await open(page);
    await page.locator("#page-routes [data-help-template='help-routes-intro']").click();
    const help = page.locator(".help-modal-body:visible");
    await expect(help).toContainText("does not mean players or legitimate clients");
    await expect(help).toContainText("reset on Apply");
    await expect(help).toContainText("A dash means no count");
  });

  test("on a phone the card labels the count", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page);
    await expect(cell(page, 0)).toHaveAttribute("data-label", "Accepted");
    await expect(cell(page, 0)).toBeVisible();
  });

  for (const scheme of SCHEMES) {
    test(`the column passes axe (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      const results = await new AxeBuilder({ page })
        .include("#page-routes")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
