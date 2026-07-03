import { $ } from "./dom.js";
import { api } from "./api.js";

const GITHUB_RELEASES_LATEST_API =
  "https://api.github.com/repos/imevul/evuproxy/releases/latest";
const GITHUB_RELEASES_PAGE_BASE = "https://github.com/imevul/evuproxy";
const UPDATE_CHECK_STORAGE_KEY = "evuproxy_gh_release_check_v1";
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

function parseSemverPrefix(s) {
  const t = String(s || "")
    .trim()
    .replace(/^v/i, "");
  const m = t.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function semverCompare(a, b) {
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

async function fetchLatestGitHubReleaseTag() {
  const r = await fetch(GITHUB_RELEASES_LATEST_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error("release lookup failed");
  const j = await r.json();
  const tag = String(j.tag_name || "").trim();
  if (!tag) throw new Error("no tag");
  return tag;
}

async function applySidebarUpdateNotice(currentVersion) {
  const note = $("sidebar-update-note");
  const link = $("sidebar-update-link");
  if (!note || !link) return;
  const cur = parseSemverPrefix(currentVersion);
  const vLow = String(currentVersion || "").trim().toLowerCase();
  if (!cur || vLow === "dev") {
    note.classList.add("is-hidden");
    return;
  }
  let latestTag = null;
  const now = Date.now();
  try {
    const raw = sessionStorage.getItem(UPDATE_CHECK_STORAGE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (
        cached &&
        typeof cached.tag === "string" &&
        typeof cached.t === "number" &&
        now - cached.t < UPDATE_CHECK_TTL_MS
      ) {
        latestTag = cached.tag;
      }
    }
  } catch (_) {}
  if (!latestTag) {
    try {
      latestTag = await fetchLatestGitHubReleaseTag();
      try {
        sessionStorage.setItem(
          UPDATE_CHECK_STORAGE_KEY,
          JSON.stringify({ t: now, tag: latestTag })
        );
      } catch (_) {}
    } catch {
      note.classList.add("is-hidden");
      return;
    }
  }
  const remote = parseSemverPrefix(latestTag);
  if (!remote || semverCompare(remote, cur) <= 0) {
    note.classList.add("is-hidden");
    return;
  }
  const tagEnc = encodeURIComponent(latestTag);
  link.href = GITHUB_RELEASES_PAGE_BASE + "/releases/tag/" + tagEnc;
  const label = latestTag.replace(/^v/i, "");
  link.textContent = "New: v" + label;
  note.classList.remove("is-hidden");
}

export async function refreshSidebarAbout() {
  const el = $("sidebar-version");
  if (!el || el.dataset.loaded === "1") return;
  try {
    const a = await api("/v1/about");
    const ver =
      a.version != null && String(a.version).trim() !== "" ? String(a.version).trim() : "—";
    el.textContent = ver;
    el.dataset.loaded = "1";
    void applySidebarUpdateNotice(ver);
  } catch {
    /* no token or API down */
  }
}
