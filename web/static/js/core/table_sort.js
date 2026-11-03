import { escapeHtml } from "./dom.js";

/*
 * Click-to-sort for the config tables. Sorting only changes the order rows are drawn
 * in: config order is never touched, and each row keeps its config index for its
 * actions. Tables re-render from config (the peers table on every ping poll), so the
 * choice lives here. Third click returns to config order.
 */
const sorts = new Map();

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** An empty value sorts last in both directions: a gap at the top hides what you sorted for. */
function isEmptyValue(v) {
  return v === null || v === undefined || v === "";
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * @param {string} tableId
 * @param {unknown[]} items in config order
 * @param {Record<string, (item: any) => string|number|null>} columns value to sort on, per column
 * @returns {{ item: any, index: number }[]} in display order, `index` being the config index
 */
export function sortedRows(tableId, items, columns) {
  const rows = items.map((item, index) => ({ item, index }));
  const sort = sorts.get(tableId);
  const value = sort && columns[sort.col];
  if (!value) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  const keyed = rows.map((row) => ({ row, key: value(row.item) }));
  keyed.sort((x, y) => {
    const xEmpty = isEmptyValue(x.key);
    const yEmpty = isEmptyValue(y.key);
    if (xEmpty || yEmpty) return xEmpty === yEmpty ? 0 : xEmpty ? 1 : -1;
    return dir * compareValues(x.key, y.key);
  });
  return keyed.map((k) => k.row);
}

/** Whether `tableId` is currently sorted on `col`, in either direction. */
export function isSortedBy(tableId, col) {
  const sort = sorts.get(tableId);
  return !!sort && sort.col === col;
}

/** A `<th>` whose label is a button that sorts on `col`. */
export function sortHeaderHtml(tableId, col, label) {
  const sort = sorts.get(tableId);
  const active = !!sort && sort.col === col;
  const ariaSort = active ? ` aria-sort="${sort.dir === "desc" ? "descending" : "ascending"}"` : "";
  return (
    `<th scope="col"${ariaSort}><button type="button" class="table-sort" data-sort-col="${escapeHtml(col)}">` +
    `${escapeHtml(label)}<span class="table-sort__icon" aria-hidden="true"></span></button></th>`
  );
}

/*
 * Lets style/mobile.css draw a rendered table's rows as cards on a phone. Each cell gets
 * its column's name to show as a label. `display: block` drops a table's native roles,
 * so explicit ones keep it a table for screen readers. None of this renders on wider
 * screens, where the same roles are already implied.
 */
export function prepareTableCards(wrap) {
  const table = wrap.querySelector("table.data");
  if (!table) return;
  table.setAttribute("role", "table");
  table.setAttribute("data-cards", "");
  table.querySelectorAll("thead, tbody").forEach((group) => group.setAttribute("role", "rowgroup"));
  table.querySelectorAll("tr").forEach((tr) => tr.setAttribute("role", "row"));
  const headers = [...table.querySelectorAll("thead th")];
  headers.forEach((th) => th.setAttribute("role", "columnheader"));
  table.querySelectorAll("tbody tr").forEach((tr) => {
    [...tr.cells].forEach((td, i) => {
      td.setAttribute("role", "cell");
      // A colspan cell is a message across the row, not a value of one column.
      if (td.colSpan === 1 && headers[i]) td.setAttribute("data-label", headers[i].textContent.trim());
    });
  });
}

/** Replaces a table, keeping its scroll position and focus on a sort button. Polls re-render under the user. */
export function setTableHtml(wrap, html) {
  const focused = document.activeElement;
  const focusCol = focused && wrap.contains(focused) ? focused.getAttribute("data-sort-col") : null;
  const { scrollTop, scrollLeft } = wrap;
  wrap.innerHTML = html;
  prepareTableCards(wrap);
  wrap.scrollTop = scrollTop;
  wrap.scrollLeft = scrollLeft;
  if (focusCol) {
    const again = wrap.querySelector(`[data-sort-col="${focusCol}"]`);
    if (again) again.focus();
  }
}

/** Wires the headers drawn by sortHeaderHtml; call after each render. */
export function bindSortHeaders(wrap, tableId, rerender) {
  wrap.querySelectorAll("[data-sort-col]").forEach((b) => {
    b.addEventListener("click", () => {
      const col = b.getAttribute("data-sort-col");
      const sort = sorts.get(tableId);
      if (!sort || sort.col !== col) sorts.set(tableId, { col, dir: "asc" });
      else if (sort.dir === "asc") sorts.set(tableId, { col, dir: "desc" });
      else sorts.delete(tableId);
      rerender();
    });
  });
}
