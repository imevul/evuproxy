/**
 * The Changes list on Pending: plain language, and a Revert per row that takes out only
 * that change, into fresh config.
 *
 * /pending is stubbed to report a chosen applied config, so a test can set up any
 * difference without a reload moving the mock's baseline under the other specs.
 */
import { expect, test, type APIRequestContext, type Page } from "./fixtures";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const auth = () => ({ Authorization: "Bearer " + token() });

const laptopKey = "a".repeat(43) + "=";
const phoneKey = "b".repeat(43) + "=";

async function fetchConfig(request: APIRequestContext) {
  const res = await request.get(origin + "/api/v1/config", { headers: auth() });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function putConfig(request: APIRequestContext, cfg: unknown) {
  const res = await request.put(origin + "/api/v1/config", {
    headers: { ...auth(), "Content-Type": "application/json" },
    data: cfg,
  });
  expect(res.ok()).toBeTruthy();
}

/** Two peers, two routes and two inbound rules, with no settings of note. */
function appliedConfig(base: any) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.peers = [
    { name: "laptop", tunnel_ip: "10.99.0.2/32", public_key: laptopKey },
    { name: "phone", tunnel_ip: "10.99.0.3/32", public_key: phoneKey },
  ];
  cfg.forwarding = cfg.forwarding || {};
  cfg.forwarding.routes = [
    { proto: "udp", ports: ["53"], target_ip: "10.99.0.2" },
    { proto: "tcp", ports: ["443"], target_ip: "10.99.0.3" },
  ];
  cfg.input_allows = [
    { proto: "tcp", dport: "22", note: "SSH" },
    { proto: "tcp", dport: "9080", note: "UI" },
  ];
  return cfg;
}

const clone = (v: any) => JSON.parse(JSON.stringify(v));
const rows = (page: Page) => page.locator("#pending-changes-list .pending-change");
const revertOf = (page: Page, text: string | RegExp) =>
  rows(page).filter({ hasText: text }).getByRole("button", { name: /^Revert/ });
const toast = (page: Page) => page.locator("#toaster .evu-toast");

/** Makes /pending report `applied` as what the host runs. Everything else stays real. */
async function stubApplied(page: Page, applied: unknown) {
  await page.route("**/api/v1/pending", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), pending: true, applied_config: applied } });
  });
}

test.describe("Changes list on Pending", () => {
  let snapshot: unknown;
  let applied: any;

  test.beforeEach(async ({ page, request }) => {
    snapshot = await fetchConfig(request);
    applied = appliedConfig(snapshot);
    await seed(page, { scheme: "light" });
    await stubApplied(page, applied);
  });

  test.afterEach(async ({ request }) => {
    await putConfig(request, snapshot);
  });

  async function openWith(page: Page, request: APIRequestContext, edit: (cfg: any) => void) {
    const saved = clone(applied);
    edit(saved);
    await putConfig(request, saved);
    await gotoRoute(page, origin, "pending");
    await expect(page.locator("#pending-changes")).toBeVisible();
  }

  const texts = (page: Page) => page.locator("#pending-changes-list .pending-change__text").allTextContents();

  const cases: [string, (cfg: any) => void, string][] = [
    [
      "adding a peer",
      (c) => c.peers.push({ name: "tablet", tunnel_ip: "10.99.0.4/32", public_key: "c".repeat(43) + "=" }),
      "Added peer tablet",
    ],
    ["removing a peer", (c) => c.peers.splice(1, 1), "Removed peer phone"],
    ["renaming a peer", (c) => (c.peers[1].name = "mobile"), "Renamed peer phone to mobile"],
    [
      "editing a peer",
      (c) => (c.peers[1].tunnel_ip = "10.99.0.9/32"),
      "Changed peer phone: tunnel IP 10.99.0.3/32 to 10.99.0.9/32",
    ],
    ["disabling a peer", (c) => (c.peers[1].disabled = true), "Disabled peer phone"],
    [
      "adding a route",
      (c) => c.forwarding.routes.push({ proto: "tcp", ports: ["80"], target_ip: "10.99.0.2" }),
      "Added route TCP 80 → laptop",
    ],
    ["removing a route", (c) => c.forwarding.routes.splice(0, 1), "Removed route UDP 53 → laptop"],
    ["editing a route", (c) => (c.forwarding.routes[1].ports = ["8443"]), "Changed route TCP 443 → phone: ports 443 to 8443"],
    ["disabling a route", (c) => (c.forwarding.routes[1].disabled = true), "Disabled route TCP 443 → phone"],
    ["adding an inbound rule", (c) => c.input_allows.push({ proto: "udp", dport: "51820" }), "Added inbound rule UDP 51820"],
    ["removing an inbound rule", (c) => c.input_allows.splice(0, 1), "Removed inbound rule TCP 22 (SSH)"],
    ["editing an inbound rule", (c) => (c.input_allows[0].dport = "2222"), "Changed inbound rule TCP 22 (SSH): port 22 to 2222"],
    ["disabling an inbound rule", (c) => (c.input_allows[1].disabled = true), "Disabled inbound rule TCP 9080 (UI)"],
  ];

  for (const [what, edit, expected] of cases) {
    test(`${what} reads "${expected}" and reverts`, async ({ page, request }) => {
      await openWith(page, request, edit);
      expect(await texts(page)).toEqual([expected]);

      await revertOf(page, expected).click();
      await expect(rows(page)).toHaveCount(0);
      await expect(page.locator("#pending-changes-note")).toContainText("Only comments or formatting");
      const after = await fetchConfig(request);
      expect(after.peers).toEqual(applied.peers);
      expect(after.forwarding.routes).toEqual(applied.forwarding.routes);
      expect(after.input_allows).toEqual(applied.input_allows);
    });
  }

  test("enabling reads as such, from an applied config that had it off", async ({ page, request }) => {
    applied.forwarding.routes[1].disabled = true;
    await openWith(page, request, (c) => delete c.forwarding.routes[1].disabled);
    expect(await texts(page)).toEqual(["Enabled route TCP 443 → phone"]);
  });

  test("uses the IP when no peer has that address", async ({ page, request }) => {
    await openWith(page, request, (c) =>
      c.forwarding.routes.push({ proto: "tcp", ports: ["80"], target_ip: "10.99.0.77" })
    );
    expect(await texts(page)).toEqual(["Added route TCP 80 → 10.99.0.77"]);
  });

  test("a removed route still shows the name of a peer removed with it", async ({ page, request }) => {
    await openWith(page, request, (c) => {
      c.peers.splice(0, 1);
      c.forwarding.routes.splice(0, 1);
    });
    expect(await texts(page)).toContain("Removed route UDP 53 → laptop");
  });

  test("Revert takes out only that change and sends the revision", async ({ page, request }) => {
    await openWith(page, request, (c) => {
      c.forwarding.routes.splice(0, 1);
      c.forwarding.routes[0].disabled = true;
      c.input_allows.splice(1, 1);
    });
    await expect(rows(page)).toHaveCount(3);

    const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/api/v1/config"));
    await revertOf(page, "Removed route UDP 53").click();
    expect((await put).headers()["if-match"]).toBeTruthy();

    await expect(rows(page)).toHaveCount(2);
    expect(await texts(page)).toEqual(["Disabled route TCP 443 → phone", "Removed inbound rule TCP 9080 (UI)"]);
    const after = await fetchConfig(request);
    // Back in its old position, with the other route's pending disable untouched.
    expect(after.forwarding.routes).toEqual([
      { proto: "udp", ports: ["53"], target_ip: "10.99.0.2" },
      { proto: "tcp", ports: ["443"], target_ip: "10.99.0.3", disabled: true },
    ]);
    expect(after.input_allows).toEqual([applied.input_allows[0]]);
  });

  test("Revert keeps what was saved elsewhere after the list loaded", async ({ page, request }) => {
    await openWith(page, request, (c) => c.forwarding.routes.splice(0, 1));

    const elsewhere = await fetchConfig(request);
    elsewhere.peers[1].name = "renamed-elsewhere";
    elsewhere.input_allows.push({ proto: "tcp", dport: "8080" });
    await putConfig(request, elsewhere);

    await revertOf(page, "Removed route UDP 53").click();
    await expect(toast(page)).toContainText("Reverted: Removed route UDP 53");

    const after = await fetchConfig(request);
    expect(after.forwarding.routes).toEqual(applied.forwarding.routes);
    expect(after.peers[1].name).toBe("renamed-elsewhere");
    expect(after.input_allows).toContainEqual({ proto: "tcp", dport: "8080" });
  });

  test("refuses when the row was edited elsewhere, and says so with no time limit", async ({ page, request }) => {
    await openWith(page, request, (c) => (c.forwarding.routes[1].ports = ["8443"]));

    const elsewhere = await fetchConfig(request);
    elsewhere.forwarding.routes[1].ports = ["9443"];
    await putConfig(request, elsewhere);

    await revertOf(page, "Changed route TCP 443").click();
    await expect(page.locator("#pending-changes-msg")).toContainText("edited elsewhere");
    expect((await fetchConfig(request)).forwarding.routes[1].ports).toEqual(["9443"]);
    // The list caught up with what is really saved.
    expect(await texts(page)).toEqual(["Changed route TCP 443 → phone: ports 443 to 9443"]);
  });

  test("a refused save is reported on the page and changes nothing", async ({ page, request }) => {
    await openWith(page, request, (c) => c.forwarding.routes.splice(0, 1));
    const before = await fetchConfig(request);
    await page.route("**/api/v1/config", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 400, json: { error: "route target 10.99.0.2 has no peer" } });
    });

    await revertOf(page, "Removed route UDP 53").click();
    await expect(page.locator("#pending-changes-msg")).toContainText("Could not revert: route target 10.99.0.2 has no peer");
    expect(await fetchConfig(request)).toEqual(before);
    await expect(rows(page)).toHaveCount(1);
  });

  test("a peer removed with its routes is one change that reverts as one", async ({ page, request }) => {
    await openWith(page, request, (c) => {
      c.peers.splice(0, 1);
      c.forwarding.routes[0].disabled = true;
    });
    expect(await texts(page)).toEqual(["Removed peer laptop and disabled route UDP 53"]);

    await revertOf(page, "Removed peer laptop").click();
    await expect(rows(page)).toHaveCount(0);
    const after = await fetchConfig(request);
    expect(after.peers).toEqual(applied.peers);
    expect(after.forwarding.routes).toEqual(applied.forwarding.routes);
  });

  test("a route disabled on its own is not folded into an unrelated peer", async ({ page, request }) => {
    await openWith(page, request, (c) => {
      c.peers.splice(0, 1);
      c.forwarding.routes[0].disabled = true;
      c.forwarding.routes[1].disabled = true;
    });
    expect(await texts(page)).toEqual(["Removed peer laptop and disabled route UDP 53", "Disabled route TCP 443 → phone"]);
  });

  test("twin rows: reverting one removal restores it next to the survivor", async ({ page, request }) => {
    const twin = { proto: "tcp", ports: ["80"], target_ip: "10.99.0.2" };
    applied.forwarding.routes = [twin, clone(twin)];
    await openWith(page, request, (c) => c.forwarding.routes.splice(0, 1));
    expect(await texts(page)).toEqual(["Removed route TCP 80 → laptop"]);

    await revertOf(page, "Removed route TCP 80").click();
    await expect(toast(page)).toContainText("Reverted");
    expect((await fetchConfig(request)).forwarding.routes).toEqual([twin, twin]);
  });

  test("settings outside the three lists are listed and revert too", async ({ page, request }) => {
    applied.forwarding.maintenance_mode = false;
    applied.network = { ...applied.network, public_interface: "eth0" };
    applied.geo = { ...applied.geo, break_glass_cidrs: ["203.0.113.1/32"] };
    await openWith(page, request, (c) => {
      c.forwarding.maintenance_mode = true;
      c.network.public_interface = "ens3";
      c.geo.break_glass_cidrs = ["203.0.113.1/32", "198.51.100.7/32"];
    });
    const listed = await texts(page);
    expect(listed).toContain("Turned on maintenance mode");
    expect(listed).toContain("Changed public interface from eth0 to ens3");
    expect(listed).toContain("Added 198.51.100.7/32 to break-glass");

    await revertOf(page, "198.51.100.7/32").click();
    await expect(rows(page)).toHaveCount(2);
    let after = await fetchConfig(request);
    expect(after.geo.break_glass_cidrs).toEqual(["203.0.113.1/32"]);
    expect(after.forwarding.maintenance_mode).toBe(true);

    await revertOf(page, "maintenance mode").click();
    await expect(rows(page)).toHaveCount(1);
    after = await fetchConfig(request);
    expect(!!after.forwarding.maintenance_mode).toBe(false);
    expect(after.network.public_interface).toBe("ens3");
  });

  test("a change of row order alone is listed and reverts", async ({ page, request }) => {
    await openWith(page, request, (c) => c.input_allows.reverse());
    expect(await texts(page)).toEqual(["Changed the order of inbound rules"]);
    await revertOf(page, "order").click();
    await expect(rows(page)).toHaveCount(0);
    expect((await fetchConfig(request)).input_allows).toEqual(applied.input_allows);
  });

  test("Undo on the toast puts a reverted change back", async ({ page, request }) => {
    await openWith(page, request, (c) => c.forwarding.routes.splice(0, 1));
    await revertOf(page, "Removed route UDP 53").click();
    await expect(rows(page)).toHaveCount(0);
    expect((await fetchConfig(request)).forwarding.routes).toHaveLength(2);

    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("Removed route UDP 53 → laptop");
    expect((await fetchConfig(request)).forwarding.routes).toEqual([applied.forwarding.routes[1]]);
    await expect(revertOf(page, "Removed route UDP 53")).toBeFocused();
  });

  test("focus moves to the next row, then to the heading when the list empties", async ({ page, request }) => {
    await openWith(page, request, (c) => {
      c.forwarding.routes.splice(0, 1);
      c.input_allows.splice(0, 1);
    });
    await revertOf(page, "Removed route UDP 53").click();
    await expect(rows(page)).toHaveCount(1);
    await expect(revertOf(page, "Removed inbound rule TCP 22")).toBeFocused();

    await revertOf(page, "Removed inbound rule TCP 22").click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator("#pending-changes-title")).toBeFocused();
  });

  /** Real /pending, so the mock itself decides whether anything is still pending. */
  async function openOneRealChange(page: Page, request: APIRequestContext) {
    await page.unroute("**/api/v1/pending");
    const res = await request.get(origin + "/api/v1/pending", { headers: auth() });
    const baseline = (await res.json()).applied_config;
    const saved = clone(baseline);
    saved.input_allows = [...(saved.input_allows || []), { proto: "udp", dport: "51820" }];
    await putConfig(request, saved);
    await gotoRoute(page, origin, "pending");
    await expect(rows(page)).toHaveCount(1);
    return baseline;
  }

  test("focus moves to the page heading when the last Revert clears pending", async ({ page, request }) => {
    await openOneRealChange(page, request);
    await revertOf(page, "Added inbound rule UDP 51820").click();

    await expect(page.locator("#pending-status")).toContainText("No pending changes");
    await expect(page.locator("#pending-changes")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Pending changes" })).toBeFocused();
  });

  test("focus moves to the page heading when the change is already gone and nothing is pending", async ({
    page,
    request,
  }) => {
    const baseline = await openOneRealChange(page, request);
    await putConfig(request, baseline);
    await revertOf(page, "Added inbound rule UDP 51820").click();

    await expect(toast(page)).toContainText("Already gone");
    await expect(page.locator("#pending-changes")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Pending changes" })).toBeFocused();
  });

  test("each Revert names what it reverts, and peer names are not parsed as HTML", async ({ page, request }) => {
    await openWith(page, request, (c) => (c.peers[1].name = "<img src=x onerror=alert(1)>"));
    await expect(rows(page).locator("img")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Revert: Renamed peer phone to <img src=x onerror=alert(1)>" })
    ).toBeVisible();
  });

  test("the raw diff is collapsed underneath and still works", async ({ page, request }) => {
    await openWith(page, request, (c) => c.forwarding.routes.splice(0, 1));
    const raw = page.locator("#pending-raw-diff");
    await expect(raw).not.toHaveAttribute("open");
    await expect(page.locator("#pending-mode-unified")).toBeHidden();

    await raw.locator("summary").click();
    await expect(page.locator("#pending-mode-unified")).toBeVisible();
    await expect(page.locator("#pending-diff-panel")).not.toBeEmpty();

    const order = await page.evaluate(() => {
      const changes = document.getElementById("pending-changes")!;
      const diff = document.getElementById("pending-raw-diff")!;
      return !!(changes.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
  });

  test("with no applied config to compare, says so and opens the raw diff", async ({ page, request }) => {
    await page.unroute("**/api/v1/pending");
    await stubApplied(page, null);
    await putConfig(request, applied);
    await gotoRoute(page, origin, "pending");
    await expect(page.locator("#pending-changes-note")).toContainText("not available to compare");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.locator("#pending-raw-diff")).toHaveAttribute("open");
  });

  test("an API older than applied_config behaves the same", async ({ page, request }) => {
    await page.unroute("**/api/v1/pending");
    await page.route("**/api/v1/pending", async (route) => {
      const res = await route.fetch();
      const { applied_config: _gone, ...old } = await res.json();
      await route.fulfill({ response: res, json: { ...old, pending: true } });
    });
    await putConfig(request, applied);
    await gotoRoute(page, origin, "pending");
    await expect(page.locator("#pending-changes-note")).toContainText("not available to compare");
    await expect(page.locator("#pending-raw-diff")).toHaveAttribute("open");
  });

  test("nothing pending hides the list", async ({ page, request }) => {
    await page.unroute("**/api/v1/pending");
    await page.route("**/api/v1/pending", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), pending: false } });
    });
    await putConfig(request, applied);
    await gotoRoute(page, origin, "pending");
    await expect(page.locator("#pending-status")).toContainText("No pending changes");
    await expect(page.locator("#pending-changes")).toBeHidden();
  });
});

test("the mock reports its applied config on /pending", async ({ request }) => {
  const res = await request.get(origin + "/api/v1/pending", { headers: auth() });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.applied_config).toHaveProperty("wireguard");
  expect(body.applied_config).toHaveProperty("peers");
});
