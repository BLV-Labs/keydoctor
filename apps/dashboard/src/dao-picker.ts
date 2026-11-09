// "Your DAOs" select for the Guard, Yield and Budget DAO forms. The form's text input stays the submitted field;
// the select only fills it. Without a list (signed out, loading, failed) the form is the plain input.
import { html, type Html } from "./html.ts";

const OPENED_KEY = "kd.daos.seen";
const OPENED_MAX = 10;
const OTHER = "";

export const NO_DAO_HINT = "No DAO found for this wallet. Type its account name.";

/** DAOs this browser opened on the Guard, Yield or Budget page, newest first. Storage can be blocked: then it is empty. */
export function openedDaos(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string").slice(0, OPENED_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberOpenedDao(dao: string): void {
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify([dao, ...openedDaos().filter((d) => d !== dao)].slice(0, OPENED_MAX)));
  } catch {
    // storage blocked: the picker just will not list it
  }
}

/** The option to select for the input's current value: that DAO if listed, the first DAO if empty, else "Other". */
export function pickedValue(daos: readonly string[], current: string): string {
  const value = current.trim();
  if (value === "") return daos[0] ?? OTHER;
  return daos.includes(value) ? value : OTHER;
}

/** The labelled select. `describedBy` is the form's error element id, kept on the select too. */
export function renderDaoPicker(daos: readonly string[], current: string, id: string, describedBy: string | null): Html {
  const picked = pickedValue(daos, current);
  return html`<div class="dao-picker stack-xs" data-dao-picker>
      <label for="${id}" class="label">Your DAOs</label>
      <select id="${id}" class="input mono"${describedBy === null ? "" : html` aria-describedby="${describedBy}"`}>
        ${daos.map((d) => html`<option value="${d}"${d === picked ? " selected" : ""}>${d}</option>`)}
        <option value=""${picked === OTHER ? " selected" : ""}>Other DAO…</option>
      </select>
    </div>`;
}

/** Removes a picker and shows the plain input again. */
export function unhydrateDaoPicker(form: HTMLFormElement): void {
  form.querySelectorAll("[data-dao-picker], [data-dao-hint]").forEach((el) => el.remove());
  for (const el of form.querySelectorAll<HTMLElement>("[data-dao-plain]")) el.hidden = false;
  delete form.dataset.pickerFor;
}

/**
 * Turns the form's DAO input into the picker for `daos`, once per `key` (the wallet accounts). An empty list only adds
 * a hint. The input keeps its name, so the form's submit handler needs no change.
 */
export function hydrateDaoPicker(form: HTMLFormElement, daos: readonly string[], key: string): void {
  if (form.dataset.pickerFor === key) return;
  unhydrateDaoPicker(form);
  const input = form.querySelector<HTMLInputElement>('input[name="dao"]');
  const row = input?.closest<HTMLElement>(".input-row");
  if (input === null || input === undefined || row === null || row === undefined) return;
  form.dataset.pickerFor = key;
  if (daos.length === 0) {
    row.insertAdjacentHTML("afterend", html`<p class="small muted" data-dao-hint>${NO_DAO_HINT}</p>`.value);
    return;
  }
  const label = form.querySelector<HTMLElement>(`label[for="${input.id}"]`);
  const plain = [input, label].filter((el): el is HTMLElement => el !== null);
  for (const el of plain) el.dataset.daoPlain = "";
  const selectId = `${input.id}-pick`;
  (label ?? row).insertAdjacentHTML("beforebegin", renderDaoPicker(daos, input.value, selectId, input.getAttribute("aria-describedby")).value);
  const select = form.querySelector<HTMLSelectElement>(`#${selectId}`);
  if (select === null) return;
  const apply = (focus: boolean): void => {
    const other = select.value === OTHER;
    if (!other) input.value = select.value;
    else if (focus) input.value = "";
    for (const el of plain) el.hidden = !other;
    if (other && focus) input.focus();
  };
  select.addEventListener("change", () => apply(true));
  if (select.value !== OTHER) input.value = select.value;
  for (const el of plain) el.hidden = select.value !== OTHER;
}
