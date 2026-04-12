(function () {
  const apiBase = window.EVUPROXY_API || "/api";
  const tokenKey = "evuproxy_api_token";

  const $ = (id) => document.getElementById(id);

  function token() {
    return sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || $("token").value.trim();
  }

  function headers() {
    const t = token();
    const h = { Accept: "application/json" };
    if (t) h["X-API-Token"] = t;
    return h;
  }

  async function api(path, opts = {}) {
    const r = await fetch(apiBase + path, {
      ...opts,
      headers: { ...headers(), ...opts.headers },
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (!r.ok) {
      const err = body.error || body.raw || r.statusText;
      throw new Error(err);
    }
    return body;
  }

  $("save-token").addEventListener("click", () => {
    const t = $("token").value.trim();
    if (!t) return;
    localStorage.setItem(tokenKey, t);
    $("action-msg").textContent = "Token saved in browser storage.";
    $("action-msg").classList.remove("err");
  });

  function showOut(obj) {
    $("out").textContent =
      typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  }

  function setMsg(text, isErr) {
    const el = $("action-msg");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const a = btn.getAttribute("data-action");
      setMsg("…");
      try {
        if (a === "reload") {
          const j = await api("/v1/reload", { method: "POST" });
          showOut(j);
          setMsg("Reload OK.");
        } else if (a === "geo") {
          const j = await api("/v1/update-geo", { method: "POST" });
          showOut(j);
          setMsg("Geo update OK.");
        } else if (a === "status") {
          const j = await api("/v1/status");
          showOut(j.report || j);
          setMsg("Status loaded.");
        } else if (a === "overview") {
          const j = await api("/v1/overview");
          showOut(j);
          setMsg("Overview loaded.");
        } else if (a === "metrics") {
          const j = await api("/v1/metrics");
          showOut(j);
          setMsg("Metrics loaded.");
        }
      } catch (e) {
        showOut(String(e.message || e));
        setMsg("Request failed.", true);
      }
    });
  });
})();
