// Prev/Next paging for the dashboard's lists. Each list keeps its page in the URL as `<list>_page`, so a page
// survives a reload and the back button. Changing page re-renders from the last scan; it never rescans.
import { formatInt } from "./format.ts";
import { html, type Html } from "./html.ts";

export const PAGE_SIZE = 10;

/** The URL search the page was rendered from, and the page each list is on (1 when absent). */
export interface Paging {
  search: string;
  pages: Readonly<Record<string, number>>;
}

export const NO_PAGING: Paging = { search: "", pages: {} };

const PARAM = /^([a-z][a-z0-9]{0,15})_page$/;

export const pageParam = (list: string): string => `${list}_page`;

export function parsePaging(search: string): Paging {
  const pages: Record<string, number> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const m = PARAM.exec(key);
    if (m !== null && /^[1-9][0-9]{0,5}$/.test(value)) pages[m[1]!] = Number(value);
  }
  return { search, pages };
}

export const pageOf = (paging: Paging, list: string): number => paging.pages[list] ?? 1;

/** The same URL with `list` on `page`; page 1 drops the parameter. */
export function pageHref(search: string, list: string, page: number): string {
  const params = new URLSearchParams(search);
  if (page <= 1) params.delete(pageParam(list));
  else params.set(pageParam(list), String(page));
  const q = params.toString();
  return q === "" ? "./" : `?${q}`;
}

export interface PageWindow {
  /** Clamped to 1..pages. */
  page: number;
  pages: number;
  total: number;
  /** 1-based positions shown; 0 and 0 for an empty list. */
  first: number;
  last: number;
}

export function pageWindow(total: number, page: number, size = PAGE_SIZE): PageWindow {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  return { page: p, pages, total, first: total === 0 ? 0 : (p - 1) * size + 1, last: Math.min(total, p * size) };
}

export function slicePage<T>(items: readonly T[], page: number, size = PAGE_SIZE): { items: T[]; window: PageWindow } {
  const window = pageWindow(items.length, page, size);
  return { items: items.slice(window.first === 0 ? 0 : window.first - 1, window.last), window };
}

/** Nothing for a list that fits on one page. `label` names the list for screen readers ("Council members"). */
export function pager(list: string, label: string, w: PageWindow, paging: Paging): Html {
  if (w.pages <= 1) return html``;
  const step = (page: number, text: string, rel: "prev" | "next", enabled: boolean): Html =>
    enabled
      ? html`<a class="btn btn-secondary btn-sm" href="${pageHref(paging.search, list, page)}" rel="${rel}" data-page-list="${list}" aria-label="${text} page of ${label}">${rel === "prev" ? "← " : ""}${text}${rel === "next" ? " →" : ""}</a>`
      : html`<span class="btn btn-secondary btn-sm is-disabled" aria-disabled="true">${rel === "prev" ? "← " : ""}${text}${rel === "next" ? " →" : ""}</span>`;
  return html`<nav class="pager" aria-label="${label} pages">
    <p class="small muted">Showing <strong class="pager-range">${formatInt(w.first)}–${formatInt(w.last)}</strong> of ${formatInt(w.total)}</p>
    <div class="pager-btns">
      ${step(w.page - 1, "Previous", "prev", w.page > 1)}
      <span class="small muted pager-page">Page ${formatInt(w.page)} of ${formatInt(w.pages)}</span>
      ${step(w.page + 1, "Next", "next", w.page < w.pages)}
    </div>
  </nav>`;
}
