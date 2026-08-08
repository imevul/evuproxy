/**
 * Classic-script theme helper (no ES modules).
 * Scheme: light | dark | system
 * Palette: indigo | blue  (data-evu-palette on <html>)
 */
(function (global) {
  var SCHEME_KEY = "evu-color-scheme";
  var PALETTE_KEY = "evu-palette";

  function getStoredScheme() {
    try {
      var v = localStorage.getItem(SCHEME_KEY);
      if (v === "light" || v === "dark" || v === "system") return v;
    } catch (e) {}
    return "system";
  }

  function setStoredScheme(scheme) {
    try {
      localStorage.setItem(SCHEME_KEY, scheme);
    } catch (e) {}
  }

  function getStoredPalette() {
    try {
      var v = localStorage.getItem(PALETTE_KEY);
      if (v === "indigo" || v === "blue") return v;
    } catch (e) {}
    return "indigo";
  }

  function setStoredPalette(palette) {
    try {
      localStorage.setItem(PALETTE_KEY, palette);
    } catch (e) {}
  }

  function resolveScheme(scheme) {
    scheme = scheme || getStoredScheme();
    if (scheme === "light" || scheme === "dark") return scheme;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyScheme(scheme) {
    scheme = scheme || getStoredScheme();
    var resolved = resolveScheme(scheme);
    var root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    root.dataset.evuScheme = scheme;
    root.dataset.evuResolved = resolved;
    return resolved;
  }

  function applyPalette(palette) {
    palette = palette || getStoredPalette();
    document.documentElement.dataset.evuPalette = palette;
    return palette;
  }

  function setScheme(scheme) {
    setStoredScheme(scheme);
    return applyScheme(scheme);
  }

  function setPalette(palette) {
    setStoredPalette(palette);
    return applyPalette(palette);
  }

  function bindThemeControls(root) {
    root = root || document;
    applyScheme();
    applyPalette();

    /* LOCAL PATCH (see VENDOR.md): must be button-qualified like the palette
       query below. applyScheme() puts data-evu-scheme on <html>, so the bare
       attribute selector also matched the root element and gave it an
       aria-pressed it is not allowed to have. */
    var schemeButtons = root.querySelectorAll("button[data-evu-scheme]");
    function syncScheme() {
      var current = getStoredScheme();
      schemeButtons.forEach(function (btn) {
        var value = btn.getAttribute("data-evu-scheme");
        btn.setAttribute("aria-pressed", value === current ? "true" : "false");
      });
    }
    schemeButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var value = btn.getAttribute("data-evu-scheme");
        if (value === "light" || value === "dark" || value === "system") {
          setScheme(value);
          syncScheme();
        }
      });
    });
    syncScheme();

    var paletteButtons = root.querySelectorAll("button[data-evu-palette]");
    function syncPalette() {
      var current = getStoredPalette();
      paletteButtons.forEach(function (btn) {
        var value = btn.getAttribute("data-evu-palette");
        btn.setAttribute("aria-pressed", value === current ? "true" : "false");
      });
    }
    paletteButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var value = btn.getAttribute("data-evu-palette");
        if (value === "indigo" || value === "blue") {
          setPalette(value);
          syncPalette();
        }
      });
    });
    syncPalette();

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (getStoredScheme() === "system") applyScheme("system");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  global.EvuTheme = {
    getStoredScheme: getStoredScheme,
    setScheme: setScheme,
    applyScheme: applyScheme,
    resolveScheme: resolveScheme,
    getStoredPalette: getStoredPalette,
    setPalette: setPalette,
    applyPalette: applyPalette,
    bindThemeControls: bindThemeControls,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bindThemeControls();
    });
  } else {
    bindThemeControls();
  }
})(typeof window !== "undefined" ? window : globalThis);
