// The three tools the dashboard is built around, all for a Sputnik DAO: Scan DAO (key checks), Agent Budget
// (agents paying within a Guard's limits) and Yield (idle stablecoins on Rhea Lend). Each page names its pillar, so the
// nav, the page head and the charts share one color per tool (--kd-p-* in tokens-keyfence.css).
import { html, type Html } from "./html.ts";
import type { Page } from "./route.ts";

export type Pillar = "scan" | "budget" | "yield";

export const PILLAR_LABEL: Readonly<Record<Pillar, string>> = {
  scan: "Scan DAO",
  budget: "Agent Budget",
  yield: "Yield",
};

/** The pillar a page belongs to; null for pages that serve all three (Roadmap, MCP). */
export function pagePillar(page: Page): Pillar | null {
  switch (page) {
    case "check":
      return "scan";
    case "budget":
    case "guard":
    case "my-agents":
      return "budget";
    case "yield":
      return "yield";
    default:
      return null;
  }
}

/**
 * The words above a page title: the tool's name alone. Inner pages are written in plain words for newcomers (no "DAO",
 * "Guard" or "proposal" outside Technical details, docs/final-idea.md §10.4, enforced by their tests), so "Sputnik DAO"
 * is said on the home page and the color does the rest.
 */
const TAG: Readonly<Record<Pillar, string>> = { scan: "Key scan", budget: PILLAR_LABEL.budget, yield: PILLAR_LABEL.yield };

/** The small line above a page title. The dot is decorative; the words carry the meaning. */
export const pillarTag = (p: Pillar): Html =>
  html`<p class="pillar-tag pillar-${p}"><span class="pillar-dot" aria-hidden="true"></span>${TAG[p]}</p>`;
