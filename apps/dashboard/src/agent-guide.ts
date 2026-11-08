// "How your agent works" (docs/final-idea.md §11.12): one page, for an owner who has never met the words behind it.
// Only what this build does: the strategy tools of §11.12.3 are not in `apps/guard-mcp` yet, so they are not here.
import { html, type Html } from "./html.ts";
import { budgetHref, pageHref } from "./route.ts";
import { AGENT_TEST_PROMPT } from "./budget-view.ts";

const CAN = [
  "See your rules, your balance and what is left of the 24-hour limit",
  "Ask to pay one recipient",
  "Pay at once when the payment is within your rules",
  "See the status of its own requests",
];

const CANNOT = [
  "Withdraw from the Budget",
  "Change rules, add recipients or raise limits",
  "Approve a payment that is outside your rules",
  "Add or remove other agents",
  "Call any other contract",
  "Use your key: it holds only its own",
];

const OUTCOMES: ReadonlyArray<readonly [string, string]> = [
  ["The recipient is on your list, and the amount fits the per-request and 24-hour limits", "Paid at once"],
  ["Any of those fails", "Waits for you, with the reason. It expires after 72 hours"],
  ["Agents are paused, this agent is off, too many requests wait, or it is a duplicate", "Rejected at once"],
];

const TOOLS: ReadonlyArray<readonly [string, string, string]> = [
  ["guard_get_policy", "Limits, what is spent and left, reset time, recipients, pause state", "No"],
  ["guard_request_transfer", "Asks to pay a recipient an amount with a memo. Answers paid, waiting (with the reason) or rejected (with the code)", "Yes: pays within your rules, or creates a waiting item"],
  ["guard_get_request_status", "The state of one request", "No"],
];

const EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  [AGENT_TEST_PROMPT, "Reads your limits with guard_get_policy"],
  ["Pay 2 NEAR to the API provider for invoice 12", "Asks with guard_request_transfer"],
  ["Was yesterday's payment to B approved?", "Reads it with guard_get_request_status"],
];

const AGENT_NOTES = [
  "Does not send a waiting item again",
  "Does not split a payment to get under the per-request limit: the 24-hour limit is still the ceiling",
  "Leaves anything outside your rules to you, and only reports it",
  "Never asks you for a private key or a seed phrase",
];

const SUSPECT: ReadonlyArray<readonly [string, string]> = [
  ["Pause agents", "at the top of Agent Budget. Works at once"],
  ["Turn off or remove the agent", "in its drawer, under Agents"],
  ["Reject what waits", "under Waiting for your approval"],
  ["Withdraw", "at the top of Agent Budget"],
];

const list = (items: readonly string[]): Html => html`<ul class="list small">${items.map((i) => html`<li>${i}</li>`)}</ul>`;

const table = (headers: readonly string[], rows: ReadonlyArray<readonly string[]>, code = false): Html =>
  html`<div class="card table-scroll"><table class="info-table"><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows.map(([first, ...rest]) => html`<tr><td>${code ? html`<code class="mono">${first ?? ""}</code>` : first ?? ""}</td>${rest.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;

export function renderAgentGuide(dao: string | null): Html {
  const back = dao === null ? pageHref("budget") : budgetHref(dao);
  return html`<section class="page-head"><div class="stack-sm grow">
      <a class="small" href="${back}" data-nav>Back to Agent Budget</a>
      <h1 class="h1">How your agent works</h1>
      <p class="lead">Your agent can spend only inside the rules you set. Everything else waits for you.</p>
    </div></section>
    <section class="grid-2" aria-label="What an agent can and cannot do">
      <div class="card pad stack-xs"><h2 class="h3">What it can do</h2>${list(CAN)}</div>
      <div class="card pad stack-xs"><h2 class="h3">What it cannot do</h2>
        <p class="small muted">The blockchain guarantees this, not the agent: its key can only ask to pay, and cannot attach money.</p>${list(CANNOT)}</div>
    </section>
    <section class="stack-sm" aria-labelledby="ag-pay"><h2 id="ag-pay" class="h2">When it asks to pay</h2>${table(["If", "Then"], OUTCOMES)}</section>
    <section class="stack-sm" aria-labelledby="ag-tools"><h2 id="ag-tools" class="h2">Its tools</h2>
      ${table(["Tool", "What it does", "Changes anything?"], TOOLS, true)}
      <p class="small muted">Only guard_request_transfer moves money, and always within your rules.</p></section>
    <section class="stack-sm" aria-labelledby="ag-say"><h2 id="ag-say" class="h2">What to say to it</h2>${table(["You say", "It does"], EXAMPLES)}</section>
    <section class="card pad stack-xs" aria-labelledby="ag-rules"><h2 id="ag-rules" class="h3">How it behaves</h2>${list(AGENT_NOTES)}</section>
    <section class="card pad stack-xs" aria-labelledby="ag-stop"><h2 id="ag-stop" class="h3">If you do not trust your agent</h2>
      <ol class="list small">${SUSPECT.map(([what, where]) => html`<li><strong>${what}</strong> ${where}</li>`)}</ol></section>
    <section class="card pad stack-xs" aria-labelledby="ag-add"><h2 id="ag-add" class="h3">Connect an agent</h2>
      <p class="small muted">Choose Add an agent on your Budget. You get its key file, the command for Claude Code, and a first question to try.</p></section>`;
}
