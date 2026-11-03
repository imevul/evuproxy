import { $ } from "./dom.js";

/* The tab title: the page on screen, plus how many changes are waiting to be applied. */

let pageName = "";
let pendingCount = 0;

function renderTitle() {
  document.title = (pageName ? pageName + " · " : "") + "EvuProxy" + (pendingCount ? " (" + pendingCount + ")" : "");
}

/** Reads the name from the page's own heading, so the two cannot disagree. */
export function setTitlePage(route) {
  const section = $("page-" + route);
  const heading = section && section.querySelector(".page-title");
  pageName = heading ? heading.textContent.trim() : "";
  renderTitle();
}

export function setTitlePendingCount(count) {
  pendingCount = count;
  renderTitle();
}
