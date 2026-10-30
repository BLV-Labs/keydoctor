import type { KdReport, Member } from "key-doctor";
import { planSteps, type Level, type Step, type StepId } from "./cleanup.ts";
import { formatInt, keyAgeMs, relativeAge, truncateKey } from "./format.ts";
import { clamp } from "./clamp.ts";
import { html, type Html } from "./html.ts";
import { WALLETS } from "./wallets.ts";
import { icon, statusIcon } from "./icons.ts";
import { breadcrumb, keyButton, walletControls } from "./report.ts";
import { keyDialogShell, viewButton } from "./key-detail.ts";
import { NO_PAGING, pageOf, pager, slicePage, type Paging } from "./paging.ts";
import { routeHref } from "./route.ts";
import { keyReasons, keySeverity, keyType, recentFullAccessKeys } from "./view.ts";

const TITLE: Record<StepId, string> = {
  revoke_app_keys: "Revoke app keys you do not need",
  delete_old_full_access: "Delete old or never-used Ed25519 full-access keys",
  add_ml_dsa: "Add an ML-DSA key",
  test_sign: "Test-sign with the ML-DSA key",
  delete_remaining_ed25519: "Delete the remaining Ed25519 full-access keys",
};

const DONE_WHEN: Record<StepId, string> = {
  revoke_app_keys: "Done when a rescan shows none of the listed app keys.",
  delete_old_full_access: "Done when a rescan shows none of the listed keys and at least one full-access key remains.",
  add_ml_dsa: "Done when a rescan shows at least one ML-DSA full-access key.",
  test_sign: "Done when the ML-DSA key has been used at least once.",
  delete_remaining_ed25519: "Done when no Ed25519 full-access key remains.",
};

const HOW: Record<StepId, string> = {
  revoke_app_keys:
    "Connect your wallet as this account and revoke these keys one at a time with the Revoke button on each key, or in the wallet itself (Meteor groups them under connected apps). An app only asks you to connect again.",
  delete_old_full_access:
    "Before you delete a full-access key: each one usually belongs to a seed phrase or a device, and that seed phrase or device loses access. Check that you can still sign with the key you keep. Then delete the keys one at a time with the Delete button on each key.",
  add_ml_dsa:
    "Do this after steps 1 and 2. In Meteor Wallet, open the post-quantum (PQ) screen and add an ML-DSA key. The account needs some NEAR for the fee. Back up the new key the way Meteor tells you to.",
  test_sign: "Sign any small transaction with the ML-DSA key in Meteor and wait for it to finalize. Skipping this test is dangerous.",
  delete_remaining_ed25519:
    "Only when the ML-DSA key is backed up and your wallets, hardware wallet and daily apps all work with it. Delete the remaining Ed25519 full-access keys in Meteor.",
};

/** The list id a step's keys page under (`step1_page` in the URL). */
export const stepList = (step: Step): string => `step${String(step.number)}`;

/** `statusId` set = each key gets its own Revoke/Delete button, reporting to that status element. */
function keyList(step: Step, m: Member, report: KdReport, statusId: string | null, paging: Paging): Html {
  if (step.keys.length === 0) return html``;
  const list = stepList(step);
  const { items: keys, window } = slicePage(step.keys, pageOf(paging, list));
  return html`<ol class="key-list" start="${String(window.first)}">
    ${keys.map((k) => {
      const t = keyType(k);
      const reasons = keyReasons(k, m);
      const severity = keySeverity(k, m);
      return html`<li class="${severity ? `key-${severity}` : ""}">
        <div class="key-info">
        <span class="mono" title="${k.public_key}">${truncateKey(k.public_key)}</span>
        <span class="muted small">${t.label}${t.detail ? html` · <span class="mono">${t.detail}</span>` : ""} · added ${relativeAge(keyAgeMs(k, report.chain.block_timestamp)).toLowerCase()} · ${k.use_count === null ? "uses unknown" : `${formatInt(k.use_count)} uses`}</span>
        ${reasons.length > 0 ? clamp(html`<span class="small">${reasons.join(" · ")}</span>`, 2) : ""}
        </div>
        <span class="actions">${statusId === null ? "" : keyButton(k, statusId)}${viewButton(k)}</span>
      </li>`;
    })}
  </ol>
  ${pager(list, `Step ${String(step.number)} keys`, window, paging)}`;
}

function stepCard(step: Step, m: Member, report: KdReport, blocked: string | null, paging: Paging): Html {
  return html`<li class="card pad stack-sm step-card${step.done ? " step-done" : ""}" tabindex="-1" data-list-anchor="${stepList(step)}">
    <div class="step-head">
      <span class="step-num${step.done ? " step-num-done" : ""}" aria-hidden="true">${step.done ? statusIcon("ok", 16) : String(step.number)}</span>
      <h2 class="h3">${step.number}. ${TITLE[step.id]}</h2>
      <span class="pill pill-sm ${step.done ? "pill-ok" : "pill-note"}">${step.done ? "Done" : "To do"}</span>
    </div>
    ${!step.done && step.keys.length > 0 ? html`<p class="small muted">${step.keys.length === 1 ? "1 key" : `${step.keys.length} keys`}, in this order:</p>${keyList(step, m, report, blocked ? null : `sign-status-${step.id}`, paging)}` : ""}
    ${step.keep ? html`<p class="small"><strong>Keep:</strong> <span class="mono">${truncateKey(step.keep.public_key)}</span> (${formatInt(step.keep.use_count ?? 0)} uses). Key Doctor never lists the last full-access key.</p>` : ""}
    ${!step.done ? html`<p>${HOW[step.id]}</p>` : ""}
    ${!step.done && blocked ? html`<p class="small field-hint">${blocked}</p>` : ""}
    ${!step.done && step.keys.length > 0 && !blocked ? html`<p class="small muted" id="sign-status-${step.id}" role="status"></p>` : ""}
    <p class="small muted">${DONE_WHEN[step.id]}</p>
  </li>`;
}

/** Opened by Connect Wallet, Revoke and Delete: the user picks the wallet that will sign. */
export function walletDialog(): Html {
  return html`<dialog id="wallet-dialog" class="dialog" aria-labelledby="wallet-h">
    <div class="dialog-inner">
      <div class="dialog-head">
        <div class="stack-xs">
          <h2 id="wallet-h" class="h2">Choose a wallet</h2>
          <p class="muted">The wallet opens its own window and shows every change before you approve it.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button>
      </div>
      <div class="dialog-box stack-sm">
        ${WALLETS.map((w) => html`<button type="button" class="btn btn-secondary" data-action="choose-wallet" data-wallet="${w.id}">${w.label}</button>`)}
      </div>
    </div>
  </dialog>`;
}

export function renderCleanup(report: KdReport, from: string | null, level: Level, paging: Paging = NO_PAGING): Html {
  const m = report.members[0];
  const id = report.target.id;
  if (m === undefined || report.target.type !== "account") return html`${breadcrumb(id, from)}<p>The cleanup plan is for one account.</p>`;
  const steps = planSteps(m, level);
  const done = steps.filter((s) => s.done).length;
  const recent = recentFullAccessKeys(m, report.chain.block_timestamp)[0];
  const href = (l: Level) => `${routeHref(id, from, report.chain.network)}&view=cleanup${l === "full" ? "&level=full" : ""}`;
  const firstOpen = steps.find((s) => !s.done);
  return html`${breadcrumb(id, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">Cleanup plan · ${report.chain.network}</span></div>
        <h1 class="h1 mono wrap">${id}</h1>
        <p class="meta" id="progress-label">${done} of ${steps.length} steps done · read at block <span class="mono">${formatInt(report.chain.block_height)}</span></p>
        <progress class="progress" aria-labelledby="progress-label" value="${done}" max="${steps.length}"></progress>
      </div>
      <div class="actions">
        <a class="btn btn-secondary" href="${routeHref(id, from, report.chain.network)}" data-nav>Back to profile</a>
        ${walletControls()}
        <button type="button" class="btn btn-primary" data-action="rescan">${icon.rescan()}Rescan</button>
      </div>
    </section>
    ${recent
      ? html`<section role="alert" class="alert-box">${icon.alert()}<div class="stack-xs">
          <p class="alert-title">Delete this key now</p>
          <p>Full-access key <span class="mono">${truncateKey(recent.key.public_key)}</span> was added ${relativeAge(recent.ageMs).toLowerCase()}. If you did not add it, delete it in your wallet before anything else, and check the account from a device you trust.</p>
        </div></section>`
      : ""}
    <p class="small muted" id="wallet-status" role="status"></p>
    <section class="stack-sm" aria-label="Cleanup level">
      <div class="segmented" role="group" aria-label="Cleanup level">
        <a class="seg" href="${href("safe")}" data-nav aria-pressed="${String(level === "safe")}">Safe cleanup</a>
        <a class="seg" href="${href("full")}" data-nav aria-pressed="${String(level === "full")}">Go fully post-quantum</a>
      </div>
      <p class="small muted">${level === "safe"
        ? "Steps 1 to 4: every account should do these."
        : "Adds step 5. Only after the ML-DSA key is backed up and everything you use works with it."}</p>
    </section>
    <ol class="plain stack" role="list">
      ${steps.map((s) => stepCard(s, m, report, s.id === "delete_remaining_ed25519" && !steps.slice(0, 4).every((x) => x.done) ? "Still needed: finish steps 1 to 4 first." : null, paging))}
    </ol>
    ${keyDialogShell()}
    ${walletDialog()}
    <p class="small muted">${firstOpen ? `Next: step ${firstOpen.number}.` : "All steps are done."} Key Doctor never signs transactions or holds keys: every change happens in your wallet, and this page reads the result from the chain when you rescan.</p>`;
}
