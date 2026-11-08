# My Agents and Yield agent (mockups)

Static mockups for two new dashboard screens. They link the real `apps/dashboard/public/styles.css` and
`docs/design/dashboard/tokens.css`, so they look like the live dashboard. `mockup.css` holds only the classes these
screens add (prefix `mk-`); `mockup.js` only toggles the theme and opens the drawers. All data is sample testnet data.

Open them from the repo root (`python3 -m http.server 8791`, launch config `design-mockups`):

- http://localhost:8791/docs/design/agents/MyAgents.html
- http://localhost:8791/docs/design/agents/Yield.html

| Screen | Proposed route | What it is for |
|---|---|---|
| My Agents | `?page=my-agents` | Every Payment agent (Agent Budget) and Yield agent the connected wallet can manage, across its DAOs, with what needs the user now. |
| Yield agent | `?page=yield&dao=<dao>` | Yield plan V1 (YD4): idle stablecoins, Rhea Lend rates, the suggestion (AI-assisted order), supply and withdraw proposals, the current position. |

`?page=agents` is already taken: it is a legacy link to Agent Budget "Add agent" (`apps/dashboard/src/route.ts`). Do
not reuse it. Nav becomes Key Check · My Agents · Agent Budget.

## Where each element would come from

| Element | Source |
|---|---|
| DAOs of the wallet | Guard factory `list_guards` plus each DAO's `get_policy`, keeping DAOs where the wallet is in a council role. |
| Payment agents | Guard `get_agents` per DAO; status from `get_window` and `list_requests` (pending = "waits for you"). |
| "Key not saved" | Same check Agent Budget uses today for an agent whose key file was never downloaded. |
| Yield agent rows | `scanYield` (`kd.yield.v1`) per DAO; "Farming" when Rhea Lend reports a supplied balance for the DAO. |
| Idle, available, open transfers | `holdings[]`: `balance`, `open_transfers`, `available`. |
| Rates table | `opportunities[]` (candidates) and `rejected[]` (Filtered out). Reject reasons are the `messages` text, verbatim. |
| Suggestion | `suggestions[]` ordered by `kd.yield_advice.v1`. `by: "rules"` shows the "Rule order" state. |
| Banners and notes | `yield/messages.ts` English text, verbatim. |
| Supply / withdraw | New `apps/dashboard/src/yield-proposals.ts` builds `add_proposal` (FunctionCall) for the wallet to sign. |

## Rules the mockups keep

- Key Doctor never moves funds: each supply and withdraw is a proposal the council votes on. Receiver, method and
  token come from code, never from the model.
- AI text carries the "AI-assisted" label and the model name; every number in it is checked against the chain read.
- Status is never color alone: each pill has an icon or a word.
- Testnet names only.

## Open items before building

1. **No index of "agents I created".** Nothing on chain records who created an agent. The plan above lists agents the
   wallet can manage (council member), which is wider. Owner decision needed.
2. **Yield watches are per Telegram chat**, not per wallet (D1). My Agents can show a Yield agent per DAO from a scan,
   but "Telegram push: On" needs a link between wallet and chat (`kd.watch_link.v1`) or must be dropped.
3. **YD0 is unproven.** The exact supply (`ft_transfer_call` with Rhea's msg) and withdraw (`execute` with `Withdraw`)
   arguments, and the one-time `storage_deposit`, still need a live testnet run before the drawers can be built.
4. **Position read.** "Supplied on Rhea Lend" needs a `get_account` read for the DAO that `scanYield` does not do yet.
