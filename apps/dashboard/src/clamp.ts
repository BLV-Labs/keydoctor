// Long chain text (descriptions, voter lists, reasons) is cut to a few lines with a "Show more" toggle.
// The toggle stays hidden until the browser measures that the text really overflows (see app.ts).
import { html, type Html } from "./html.ts";

export function clamp(content: Html | string, lines: 2 | 3 = 3): Html {
  return html`<div class="clamp clamp-${String(lines)}" data-clamp>
    <div class="clamp-body">${content}</div>
    <button type="button" class="link-btn" data-action="toggle-more" aria-expanded="false" hidden>Show more</button>
  </div>`;
}

/** Shows the toggle only where the text is cut. Runs after every paint and on resize. */
export function revealClampToggles(scope: ParentNode): void {
  scope.querySelectorAll<HTMLElement>("[data-clamp]").forEach((box) => {
    const body = box.querySelector<HTMLElement>(".clamp-body");
    const toggle = box.querySelector<HTMLButtonElement>("[data-action='toggle-more']");
    if (body === null || toggle === null) return;
    const open = box.classList.contains("is-open");
    toggle.hidden = !open && body.scrollHeight <= body.clientHeight + 1;
  });
}

export function toggleClamp(toggle: HTMLElement): void {
  const box = toggle.closest<HTMLElement>("[data-clamp]");
  if (box === null) return;
  const open = box.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "Show less" : "Show more";
}
