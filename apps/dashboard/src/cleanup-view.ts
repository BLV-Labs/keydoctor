import type { KdReport, Member } from "key-doctor";
import { planSteps, type Level, type Step, type StepId } from "./cleanup.ts";
import { formatInt, formatUtc, keyAgeMs, plural, relativeAge, truncateKey } from "./format.ts";
import { html, type Html } from "./html.ts";
import { WALLETS } from "./wallets.ts";
import { icon, statusIcon } from "./icons.ts";
import { breadcrumb, breakAfterDots, keyButton } from "./report.ts";
import { walletBar } from "./session.ts";
import { keyDialogShell, viewButton } from "./key-detail.ts";
import { NO_PAGING, pageOf, pager, slicePage, type Paging } from "./paging.ts";
import { routeHref } from "./route.ts";
import { freshKeys, keyStatus } from "./key-verdict.ts";

const TITLE: Record<StepId, string> = {
  revoke_app_keys: "Revoke app keys you do not use",
  delete_old_full_access: "Remove old or unused master keys",
  add_ml_dsa: "Add an ML-DSA key",
  test_sign: "Test-sign with the ML-DSA key",
  delete_remaining_ed25519: "Delete the remaining Ed25519 full-access keys",
};

const DONE_WHEN: Record<StepId, string> = {
  revoke_app_keys: "Done when Check again shows none of the listed app keys.",
  delete_old_full_access: "Done when Check again shows none of the listed keys and at least one master key remains.",
  add_ml_dsa: "Done when a rescan shows at least one ML-DSA full-access key.",
  test_sign: "Done when the ML-DSA key has been used at least once.",
  delete_remaining_ed25519: "Done when no Ed25519 full-access key remains.",
};

/** The one line a later step shows while an earlier step is still open. */
const SUMMARY: Record<StepId, string> = {
  revoke_app_keys: "Cut off apps that can still act for this account.",
  delete_old_full_access: "Remove master keys nobody uses, one at a time.",
  add_ml_dsa: "Add a key that future computers cannot break.",
  test_sign: "Prove the new key works before you rely on it.",
  delete_remaining_ed25519: "Remove the last old master keys.",
};

/** The first two steps are the everyday cleanup. The rest is the post-quantum upgrade, shown under "Going further". */
const MAIN_STEPS: ReadonlySet<StepId> = new Set(["revoke_app_keys", "delete_old_full_access"]);

const HOW: Record<StepId, string> = {
  revoke_app_keys:
    "Connect your wallet as this account and revoke these keys one at a time with the Revoke button on each key, or in the wallet itself (Meteor groups them under connected apps). An app only asks you to connect again.",
  delete_old_full_access:
    "Before you remove a master key: each one usually belongs to a seed phrase or a device, and that seed phrase or device loses access. Check that you can still sign with the key you keep. Then remove the keys one at a time with the Remove button on each key.",
  add_ml_dsa:
    "Do this after steps 1 and 2. In Meteor Wallet, open the post-quantum (PQ) screen and add an ML-DSA key. The account needs some NEAR for the fee. Back up the new key the way Meteor tells you to.",
  test_sign: "Sign any small transaction with the ML-DSA key in Meteor and wait for it to finalize. Skipping this test is dangerous.",
  delete_remaining_ed25519:
    "Only when the ML-DSA key is backed up and your wallets, hardware wallet and daily apps all work with it. Delete the remaining Ed25519 full-access keys in Meteor.",
};

/** The list id a step's keys page under (`step1_page` in the URL). */
export const stepList = (step: Step): string => `step${String(step.number)}`;

/** `statusId` set = each key gets its own Revoke/Remove button, reporting to that status element. Same row as the Key check page. */
function keyList(step: Step, m: Member, report: KdReport, statusId: string | null, paging: Paging, known: ReadonlySet<string>): Html {
  if (step.keys.length === 0) return html``;
  const list = stepList(step);
  const { items: keys, window } = slicePage(step.keys, pageOf(paging, list));
  const fresh = new Set(freshKeys(m, report, known).map((f) => f.key.public_key));
  return html`<ol class="key-list" start="${String(window.first)}">
    ${keys.map((k) => {
      const status = keyStatus(k, m, fresh.has(k.public_key));
      const full = k.permission.type === "full_access";
      return html`<li>
        <div class="key-info">
          <span class="mono" title="${k.public_key}">${truncateKey(k.public_key)}</span>
          <span class="muted small">${full ? "Everything (master key)" : html`Use ${breakAfterDots(k.permission.type === "function_call" ? k.permission.receiver_id : "")}`} · added ${relativeAge(keyAgeMs(k, report.chain.block_timestamp)).toLowerCase()} · ${k.use_count === null ? "uses unknown" : plural(k.use_count, "use")}</span>
          <span class="pill pill-sm pill-${status.tone} self-start">${statusIcon(status.tone, 12)}${status.label}</span>
        </div>
        <span class="actions">${statusId === null ? "" : keyButton(k, statusId, full ? "Remove" : "Revoke")}${viewButton(k)}</span>
      </li>`;
    })}
  </ol>
  ${pager(list, `Step ${String(step.number)} keys`, window, paging)}`;
}

/** The open step, or any step under "Going further": the full card. */
function stepCard(step: Step, m: Member, report: KdReport, blocked: string | null, paging: Paging, known: ReadonlySet<string>): Html {
  return html`<li class="card pad stack-sm step-card${step.done ? " step-done" : ""}" tabindex="-1" data-list-anchor="${stepList(step)}">
    <div class="step-head">
      <span class="step-num${step.done ? " step-num-done" : ""}" aria-hidden="true">${step.done ? statusIcon("ok", 16) : String(step.number)}</span>
      <h2 class="h3">${step.number}. ${TITLE[step.id]}</h2>
      <span class="pill pill-sm ${step.done ? "pill-ok" : "pill-note"}">${step.done ? "Done" : "To do"}</span>
    </div>
    ${!step.done && step.keys.length > 0 ? html`<p class="small muted">${plural(step.keys.length, "key")}, in this order:</p>${keyList(step, m, report, blocked ? null : `sign-status-${step.id}`, paging, known)}` : ""}
    ${step.keep ? html`<p class="small"><strong>Keep:</strong> <span class="mono">${truncateKey(step.keep.public_key)}</span> (${plural(step.keep.use_count ?? 0, "use")}). Key Doctor never lists the last master key.</p>` : ""}
    ${!step.done ? html`<p>${HOW[step.id]}</p>` : ""}
    ${!step.done && blocked ? html`<p class="small field-hint">${blocked}</p>` : ""}
    ${!step.done && step.keys.length > 0 && !blocked ? html`<p class="small muted" id="sign-status-${step.id}" role="status"></p>` : ""}
    <p class="small muted">${DONE_WHEN[step.id]}</p>
  </li>`;
}

/** A finished step is one line with a green check; a step that is not open yet is its title and one line. */
function stepLine(step: Step): Html {
  return step.done
    ? html`<li class="step-line step-line-done" data-list-anchor="${stepList(step)}" tabindex="-1">
        <span class="step-num step-num-done" aria-hidden="true">${statusIcon("ok", 16)}</span>
        <span class="grow-min"><strong>${step.number}. ${TITLE[step.id]}</strong></span>
        <span class="pill pill-sm pill-ok">Done</span>
      </li>`
    : html`<li class="step-line" data-list-anchor="${stepList(step)}" tabindex="-1">
        <span class="step-num" aria-hidden="true">${String(step.number)}</span>
        <span class="grow-min stack-xs"><strong>${step.number}. ${TITLE[step.id]}</strong><span class="small muted">${SUMMARY[step.id]}</span></span>
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

export function renderCleanup(report: KdReport, from: string | null, level: Level, paging: Paging = NO_PAGING, known: ReadonlySet<string> = new Set()): Html {
  const m = report.members[0];
  const id = report.target.id;
  if (m === undefined || report.target.type !== "account") return html`${breadcrumb(id, from)}<p>Clean up keys works on one account.</p>`;
  const steps = planSteps(m, level);
  const main = steps.filter((s) => MAIN_STEPS.has(s.id));
  const further = steps.filter((s) => !MAIN_STEPS.has(s.id));
  const done = main.filter((s) => s.done).length;
  const recent = freshKeys(m, report, known)[0];
  const href = (l: Level) => `${routeHref(id, from, report.chain.network)}&view=cleanup${l === "full" ? "&level=full" : ""}`;
  const firstOpen = main.find((s) => !s.done);
  const blockedMsg = (s: Step): string | null => (s.id === "delete_remaining_ed25519" && !steps.slice(0, 4).every((x) => x.done) ? "Still needed: finish steps 1 to 4 first." : null);
  return html`${breadcrumb(id, from)}
    <section class="page-head">
      <div class="stack-sm grow">
        <div class="tags"><span class="tag">Clean up keys · ${report.chain.network}</span></div>
        <h1 class="h1 mono wrap">${id}</h1>
        <p class="meta" id="progress-label">${done} of ${main.length} steps done · Checked ${formatUtc(report.chain.block_timestamp)} · <button type="button" class="btn btn-ghost btn-link" data-action="rescan">Check again</button></p>
        <progress class="progress" aria-labelledby="progress-label" value="${done}" max="${main.length}"></progress>
      </div>
      <div class="actions">
        <a class="btn btn-secondary" href="${routeHref(id, from, report.chain.network)}" data-nav>Back to key check</a>
      </div>
    </section>
    ${walletBar("visitor", id, null, report.chain.network)}
    ${recent
      ? html`<section role="alert" class="alert-box">${icon.alert()}<div class="stack-xs">
          <p class="alert-title">Remove this key now</p>
          <p>Master key <span class="mono">${truncateKey(recent.key.public_key)}</span> was added ${relativeAge(recent.ageMs).toLowerCase()}. If you did not add it, remove it in your wallet before anything else, and check the account from a device you trust.</p>
        </div></section>`
      : ""}
    <ol class="plain stack-sm" role="list">
      ${main.map((s) => (s === firstOpen ? stepCard(s, m, report, blockedMsg(s), paging, known) : stepLine(s)))}
    </ol>
    ${firstOpen ? "" : html`<p class="card pad ok-box">${statusIcon("ok", 18)}All steps are done.</p>`}
    <details class="card tech more-checks">
      <summary>Going further</summary>
      <div class="stack-sm more-body">
        <p class="muted">Optional. Swap your old keys for a post-quantum (ML-DSA) key. Only when you can back it up and your wallets support it.</p>
        <section class="stack-sm" aria-label="Cleanup level">
          <div class="segmented" role="group" aria-label="Cleanup level">
            <a class="seg" href="${href("safe")}" data-nav aria-pressed="${String(level === "safe")}">Safe cleanup</a>
            <a class="seg" href="${href("full")}" data-nav aria-pressed="${String(level === "full")}">Go fully post-quantum</a>
          </div>
          <p class="small muted">${level === "safe"
            ? "Steps 3 and 4: add the new key and test it."
            : "Adds step 5. Only after the ML-DSA key is backed up and everything you use works with it."}</p>
        </section>
        <ol class="plain stack-sm" role="list">
          ${further.map((s) => stepCard(s, m, report, blockedMsg(s), paging, known))}
        </ol>
      </div>
    </details>
    ${keyDialogShell()}
    <p class="small muted">Key Doctor never signs transactions or holds keys: every change happens in your wallet, and this page reads the result from the chain when you check again.</p>`;
}
