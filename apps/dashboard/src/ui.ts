// Small shared building blocks for the report pages: the card header and the account monogram.
import { html, type Html } from "./html.ts";

/**
 * Every list card opens the same way: title, a short note beside it, and at most one link on the right.
 * `link` is an in-app href (navigated with data-nav).
 */
export function cardHead(id: string, title: string, note: Html | string, link?: { href: string; label: string }): Html {
  return html`<div class="card-head">
    <div class="head-title"><h2 id="${id}" class="h2">${title}</h2><span class="muted small">${note}</span></div>
    ${link ? html`<a class="head-link" href="${link.href}" data-nav>${link.label} →</a>` : ""}
  </div>`;
}

/** Two letters for an account: first and last part of its first label (kdoncall-b.testnet → KB, a.kd-demo.testnet → A). */
export function initials(id: string): string {
  if (/^[0-9a-f]{64}$/.test(id)) return id.slice(0, 2).toUpperCase();
  const parts = (id.split(".")[0] ?? id).split(/[-_]/).filter((p) => p !== "");
  const first = parts[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  // A numbered name keeps its number's last digit (member-08 → M8), so neighbours do not all read "M0".
  const second = last === "" ? first.slice(1, 2) : /^[0-9]+$/.test(last) ? last.slice(-1) : last.slice(0, 1);
  return (first.slice(0, 1) + second).toUpperCase();
}

const AVATAR_TONES = 6;

/** Stable tone per account so the same member keeps its color across pages. Decorative only. */
export function avatarTone(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % AVATAR_TONES;
}

export const avatar = (id: string): Html =>
  html`<span class="avatar av-${String(avatarTone(id))}" aria-hidden="true">${initials(id)}</span>`;
