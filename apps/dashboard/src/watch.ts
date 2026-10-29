import { html, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { BOT_URL, BOT_USERNAME } from "./route.ts";

export const watchCommand = (target: string): string => `/watch ${target}`;

/** MVP alerts dialog (docs/final-idea.md §10): a copyable command and the bot link. It never calls the Worker. */
export function renderWatchDialog(target: string, type: "dao" | "account"): Html {
  const isDao = type === "dao";
  return html`<dialog id="watch-dialog" class="dialog" aria-labelledby="watch-h">
    <div class="dialog-inner">
    <div class="dialog-head">
      <div class="stack-xs">
        <h2 id="watch-h" class="h2">Get Telegram alerts</h2>
        <p class="muted">For <span class="mono wrap strong">${target}</span></p>
      </div>
      <button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon.close()}</button>
    </div>
    <ol class="steps">
      <li><span class="step-num" aria-hidden="true">1</span><div class="stack-sm grow">
        <p class="strong">Open the Key Doctor On Call bot</p>
        <a class="btn btn-primary self-start" href="${BOT_URL}" target="_blank" rel="noopener">${icon.send()}Open @${BOT_USERNAME}</a>
      </div></li>
      <li><span class="step-num" aria-hidden="true">2</span><div class="stack-sm grow">
        <p class="strong">Send this command to the bot, or in a group chat</p>
        <div class="command-row">
          <code class="command mono">${watchCommand(target)}</code>
          <button type="button" class="btn btn-secondary" data-action="copy-command" data-command="${watchCommand(target)}">${icon.copy()}<span data-copy-label>Copy</span></button>
        </div>
        <p class="small muted">To alert a whole team, add the bot to your Telegram group and send the command there.</p>
      </div></li>
    </ol>
    <div class="dialog-box stack-sm">
      <p class="strong">You will get</p>
      <p class="check-line">${icon.check()}<span>${
        isDao
          ? "A daily message at 02:00 UTC when a key is added to or removed from any council account, or the council changes."
          : "A daily message at 02:00 UTC when a key is added to or removed from this account."
      }</span></p>
      ${isDao
        ? html`<p class="check-line">${icon.check()}<span>A warning before the final vote when a voter on a pending proposal has a new full-access key. Checked every 15 minutes.</span></p>
          <p class="check-line">${icon.check()}<span>A warning for every new proposal that changes members, policy or contract code.</span></p>`
        : html`<p class="small muted">Proposal warnings come with a DAO. If this account sits in a council, also send <span class="mono">/watch</span> with the DAO name.</p>`}
    </div>
    <p class="dialog-foot small muted">${icon.info()}<span>This page does not store subscriptions. List and cancel them in the bot with <span class="mono">/list</span> and <span class="mono">/unwatch</span>.</span></p>
    </div>
  </dialog>`;
}
