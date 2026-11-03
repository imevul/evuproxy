/**
 * The route editor rebuilds a route from its form, so a setting with no form control
 * yet has to be carried over by hand. `pause_when_peer_offline` can only be set in YAML
 * for now; saving the route from the UI must not silently turn it off.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const CONFIG = {
  wireguard: {
    interface: "wg0",
    listen_port: 51820,
    private_key_file: "/key",
    address: "10.100.0.1/24",
  },
  network: { public_interface: "eth0" },
  forwarding: {
    routes: [
      { proto: "tcp", ports: ["25565"], target_ip: "10.100.0.2", pause_when_peer_offline: true },
      { proto: "tcp", ports: ["8080"], target_ip: "10.100.0.2" },
    ],
  },
  auto_pause: { failures_to_pause: 5 },
  geo: { enabled: false },
  input_allows: [],
  peers: [{ name: "alpha", public_key: "k", tunnel_ip: "10.100.0.2/32" }],
};

type SavedConfig = typeof CONFIG & {
  forwarding: { routes: Array<{ pause_when_peer_offline?: boolean }> };
};

test.describe("route editor keeps pause_when_peer_offline", () => {
  let saved: SavedConfig | undefined;

  test.beforeEach(async ({ page }) => {
    saved = undefined;
    await seed(page, { scheme: "light" });
    await page.route("**/api/v1/config", async (route) => {
      if (route.request().method() === "PUT") {
        saved = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"result":"saved"}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CONFIG),
      });
    });
    await gotoRoute(page, origin, "routes");
  });

  async function editAndSave(page: import("@playwright/test").Page, index: number) {
    await page.locator(`[data-route-edit="${index}"]`).click();
    await page.locator("#route-modal").waitFor({ state: "visible" });
    await page.locator("#route-save").click();
    await expect.poll(() => saved).toBeTruthy();
  }

  test("editing a route with the setting keeps it, and auto_pause", async ({ page }) => {
    await editAndSave(page, 0);
    expect(saved?.forwarding.routes[0].pause_when_peer_offline).toBe(true);
    expect(saved?.auto_pause).toEqual({ failures_to_pause: 5 });
  });

  test("editing a route without the setting doesn't add it", async ({ page }) => {
    await editAndSave(page, 1);
    expect(saved?.forwarding.routes[1].pause_when_peer_offline).toBeUndefined();
    expect(saved?.forwarding.routes[0].pause_when_peer_offline).toBe(true);
  });
});
