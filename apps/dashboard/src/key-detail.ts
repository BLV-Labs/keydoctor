import type { KdReport, KeyInfo, Member } from "key-doctor";
import { formatInt, formatUtc, keyAgeMs, relativeAge, truncateKey, yoctoToNear } from "./format.ts";
import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { keyReasons, keyType } from "./view.ts";

/** The empty dialog the View buttons fill and open. */
export const keyDialogShell = (): Html => html`<dialog id="key-dialog" class="dialog" aria-labelledby="key-h"></dialog>`;

export function viewButton(k: KeyInfo): Html {
  return html`<button type="button" class="btn btn-secondary self-start" data-action="view-key" data-key="${k.public_key}" aria-label="View key ${truncateKey(k.public_key)}">Details</button>`;
}

/** Who the key is approved for: the dApp contract of an app key, or any contract for a full-access key. */
export function keyApproval(key: KeyInfo): { label: string; contract: string | null } {
  return key.permission.type === "function_call"
    ? { label: key.permission.receiver_id, contract: key.permission.receiver_id }
    : { label: "Any contract", contract: null };
}

function row(label: string, value: Html | string): Html {
  return html`<div class="kv-row"><dt class="muted small">${label}</dt><dd class="wrap">${value}</dd></div>`;
}

function permissionRows(key: KeyInfo): Html {
  const p = key.permission;
  if (p.type === "full_access") return row("Permission", "Full access: can do anything with this account, including deleting it and moving all its NEAR.");
  return html`${row("Permission", "App key: can only call the contract below, and cannot move NEAR out of the account.")}
    ${row("Approved for (dApp contract)", html`<span class="mono wrap">${p.receiver_id}</span>${key.receiver_exists === false ? html` <span class="muted">(no contract on this account)</span>` : ""}`)}
    ${row("Allowed methods", p.method_names.length === 0 ? "Any method" : html`<span class="mono wrap">${p.method_names.join(", ")}</span>`)}
    ${row("Fee allowance", p.allowance_yocto === null ? "Unlimited" : `${yoctoToNear(p.allowance_yocto)} NEAR`)}`;
}

/** The body of the key dialog: everything the scan knows about one key. */
export function renderKeyDetail(key: KeyInfo, member: Member, report: KdReport): Html {
  const reasons = keyReasons(key, member);
  const added = key.created.at === null ? "Unknown" : `${formatUtc(key.created.at)} (${relativeAge(keyAgeMs(key, report.chain.block_timestamp)).toLowerCase()})`;
  return html`<div class="dialog-inner">
    <div class="dialog-head">
      <div class="stack-xs">
        <div class="tags"><span class="pill pill-sm ${key.permission.type === "full_access" ? "pill-high" : "pill-note"}">${keyType(key).label}</span></div>
        <h2 id="key-h" class="h2">Key details</h2>
        <p class="muted">On <span class="mono wrap strong">${member.account_id}</span></p>
      </div>
      <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button>
    </div>
    <dl class="kv-list">
      ${row("Public key", html`<span class="mono wrap">${key.public_key}</span>`)}
      ${permissionRows(key)}
      ${row("Added", html`${added}${key.created.source === "nonce_estimate" ? html`<br><span class="muted small">Estimated from the nonce${key.created.block_height === null ? "" : `, block ${formatInt(key.created.block_height)}`}</span>` : ""}`)}
      ${row("Uses", key.use_count === null ? "Unknown" : formatInt(key.use_count))}
      ${row("Nonce", html`<span class="mono">${key.nonce}</span>`)}
      ${row("Why it matters", reasons.length === 0 ? "No issue found" : reasons.join(" · "))}
    </dl>
  </div>`;
}
