/*
 * FOUC guard: a blocking classic script, loaded in <head> before the stylesheets, so the stored
 * scheme and palette are on <html> before first paint. A file rather than an inline script
 * because the Content-Security-Policy in docker/nginx.conf has no 'unsafe-inline'.
 */
(function () {
  try {
    var r = document.documentElement;
    var s = localStorage.getItem("evu-color-scheme") || "system";
    var d = s === "dark" || (s !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    r.classList.toggle("dark", d);
    r.style.colorScheme = d ? "dark" : "light";
    var p = localStorage.getItem("evu-palette");
    r.setAttribute("data-evu-palette", p === "blue" || p === "indigo" ? p : "indigo");
  } catch (e) {}
})();
