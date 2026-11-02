#!/usr/bin/env bash
# GĐ18 Guard testnet setup (docs/usecase.md UC9, UC10; docs/final-idea.md §11.4, §11.5; docs/stories/epics/guard/plan.md).
# Builds the Agent Guard demo: a 3-member Sputnik DAO (2 votes), the Guard deployed and initialised, the
# `agent-guard` role, a funded Guard and DAO, the agent account with a function-call key that can only call the
# Guard, then locks the Guard (deletes its full-access keys) after an explicit y/N.
# Developer tool, not part of the product: it signs with YOUR testnet keys through near-cli-rs (`near`), stored
# in your local keychain. The demo council a, b, c are all yours, so their votes are signed here too. Testnet only.
#
#   scripts/guard-setup/setup.sh all        # every step below in order; safe to re-run, done steps are skipped
#   scripts/guard-setup/setup.sh accounts   # create missing accounts with the testnet faucet
#   scripts/guard-setup/setup.sh dao        # a creates <prefix>.sputnik-v2.testnet (council a, b, c; 2 of 3)
#   scripts/guard-setup/setup.sh guard      # build, deploy and init the Guard (agent, 3 receivers, guardian c)
#   scripts/guard-setup/setup.sh role       # ChangePolicy adding role agent-guard (prints the diff), a and b approve
#   scripts/guard-setup/setup.sh fund       # b and c top up the DAO; DAO Transfer proposal funds the Guard
#   scripts/guard-setup/setup.sh agent      # agent key file (mode 600) + function-call key on the agent account
#   scripts/guard-setup/setup.sh verify     # role, Guard config, balances, agent key, lock state
#   scripts/guard-setup/setup.sh lock       # verify, then delete the Guard's full-access keys (asks y/N)
#   scripts/guard-setup/setup.sh info       # accounts and the env lines for apps/guard-mcp (GĐ19)
#
# Demo policy: 5 NEAR per request, 10 NEAR per 24 h, 3 pending per agent, 1 NEAR reserve; the 3 invoice
# receivers of docs/usecase.md appendix G are whitelisted. The agent key's allowance is 1 NEAR (about 600 Auto
# requests at 200 Tgas, README "Agent Guard"). The private key goes to KD_GUARD_AGENT_KEY, never to stdout.
#
# Timing: a faucet account's first key counts as a "new full-access key" in Key Doctor for 48 hours, so council
# votes alert until then. Run `all` at least 48 hours before recording the demo.
#
# Existing accounts: set KD_GUARD_A, KD_GUARD_B, KD_GUARD_C, KD_GUARD_ACCOUNT, KD_GUARD_AGENT and
# KD_GUARD_RECEIVERS (3 comma-separated ids). Only top-level *.testnet names are created with the faucet; create
# sub-accounts (e.g. kd-guard.<you>.testnet) yourself first. Keys in ~/.near-credentials: KD_GUARD_SIGN=sign-with-legacy-keychain.
# KD_GUARD_FUNDER=<rich account> creates missing accounts with 10 NEAR each from that account instead of the faucet.
# Needs: near (near-cli-rs), cargo-near, node >= 22, jq.
# Env: KD_GUARD_PREFIX (unique, e.g. kdg$(date +%s)); optional KD_GUARD_AGENT_KEY (default
# ~/.config/key-doctor/<agent>.json), KD_GUARD_FUND (DAO -> Guard, NEAR, default 1, 0 skips), KD_DAO_TREASURY
# (NEAR the DAO keeps for the invoices after funding the Guard, default 8).
set -euo pipefail

PREFIX="${KD_GUARD_PREFIX:?set KD_GUARD_PREFIX to a unique lowercase name, e.g. kdg$(date +%s)}"
[[ "$PREFIX" =~ ^[a-z0-9]{3,20}$ ]] || { echo "KD_GUARD_PREFIX must be 3-20 lowercase letters or digits" >&2; exit 2; }
FACTORY="sputnik-v2.testnet"
DAO="${PREFIX}.${FACTORY}"
A="${KD_GUARD_A:-${PREFIX}-a.testnet}"
B="${KD_GUARD_B:-${PREFIX}-b.testnet}"
C="${KD_GUARD_C:-${PREFIX}-c.testnet}"
GUARD="${KD_GUARD_ACCOUNT:-${PREFIX}-guard.testnet}"
AGENT="${KD_GUARD_AGENT:-${PREFIX}-agent1.testnet}"
IFS=, read -r -a RECEIVERS <<<"${KD_GUARD_RECEIVERS:-${PREFIX}-vendor.testnet,${PREFIX}-contrib.testnet,${PREFIX}-api.testnet}"
[[ ${#RECEIVERS[@]} -eq 3 ]] || { echo "KD_GUARD_RECEIVERS must list 3 accounts" >&2; exit 2; }
LABELS=("Vendor A" "Contributor B" "API service C")
KEY_FILE="${KD_GUARD_AGENT_KEY:-$HOME/.config/key-doctor/${AGENT}.json}"
FUND="${KD_GUARD_FUND:-1}"
TREASURY="${KD_DAO_TREASURY:-8}"
SIGN="${KD_GUARD_SIGN:-sign-with-keychain}"
FUNDER="${KD_GUARD_FUNDER:-}"
# New faucet accounts keep their keys where SIGN looks for them.
if [[ "$SIGN" == sign-with-legacy-keychain ]]; then SAVE=save-to-legacy-keychain; else SAVE=save-to-keychain; fi
NET=(network-config testnet)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/contracts/guard"
[[ "$KEY_FILE" == /* ]] || KEY_FILE="$PWD/$KEY_FILE"
[[ "$KEY_FILE" != "$ROOT"/* ]] || { echo "KD_GUARD_AGENT_KEY must be outside the repo: it holds a private key." >&2; exit 2; }
NJS=(node "$ROOT/scripts/guard-setup/near.mjs")
ROLE_DESC="[kd-guard-setup] Add role agent-guard for $GUARD"
FUND_DESC="[kd-guard-setup] Fund the Guard $GUARD"
METHODS='["request_transfer","sync_request"]'

call() { # call <signer> <contract> <method> <json> <deposit> [gas]
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-150.0 Tgas}" attached-deposit "$5" sign-as "$1" "${NET[@]}" "$SIGN" send
}
view() { "${NJS[@]}" view "$@"; }
acct() { "${NJS[@]}" account "$1" | jq -r ".$2"; }
y() { "${NJS[@]}" yocto "$1"; }
fmt() { "${NJS[@]}" fmt "$1"; }
ge() { "${NJS[@]}" ge "$1" "$2"; }
say() { printf '\n== %s\n' "$*"; }

# The role from §11.4: the Guard alone adds and approves transfers; quorum 0 and weight 1 mean its one vote
# passes a transfer. Nothing else: no policy, call, member or upgrade permissions.
role() {
  jq -n --arg g "$GUARD" '{ name: "agent-guard", kind: { Group: [$g] },
    permissions: ["transfer:AddProposal", "transfer:VoteApprove"],
    vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } } }'
}

is_guard() { # the full Guard (kd_guard 1.x), not the GĐ15 spike (0.1.0-spike)
  view "$GUARD" kd_guard_info '{}' 2>/dev/null | jq -e '.standard == "kd_guard" and (.version | startswith("1."))' >/dev/null
}

# Sputnik keeps permissions and Group members in hash sets, so compare them sorted.
HAS_ROLE='def norm: .kind.Group |= sort | .permissions |= sort; [.roles[] | select(.name == "agent-guard") | norm] == [$r | norm]'

find_proposal() { # find_proposal <description> -> "<id> <status>" of the newest match among the last 50, or nothing
  local last from
  last=$(view "$DAO" get_last_proposal_id '{}')
  from=$(( last > 50 ? last - 50 : 0 ))
  view "$DAO" get_proposals "{\"from_index\":$from,\"limit\":50}" \
    | jq -r --arg d "$1" '[.[] | select(.description == $d)] | last | select(.) | "\(.id) \(.status)"'
}

approve() { # approve <id>: a and b vote for it, skipping votes already cast; prints the final status
  local p
  for voter in "$A" "$B"; do
    p=$(view "$DAO" get_proposal "{\"id\":$1}")
    [[ $(jq -r .status <<<"$p") == InProgress ]] || break
    jq -e --arg v "$voter" '.votes | has($v)' <<<"$p" >/dev/null && continue
    call "$voter" "$DAO" act_proposal "$(jq -c --argjson id "$1" '{ id: $id, action: "VoteApprove", proposal: .kind }' <<<"$p")" '0 NEAR'
  done
  view "$DAO" get_proposal "{\"id\":$1}" | jq -r .status
}

propose_and_pass() { # propose_and_pass <description> <kind json>: resumes the open proposal or creates one, then approves it
  local id="" status="" bond
  read -r id status <<<"$(find_proposal "$1")" || true
  if [[ "$status" == InProgress ]]; then
    echo "Resuming proposal $id."
  else
    bond=$(view "$DAO" get_policy '{}' | jq -r .proposal_bond)
    call "$A" "$DAO" add_proposal "$(jq -nc --arg d "$1" --argjson k "$2" '{ proposal: { description: $d, kind: $k } }')" "$bond yoctoNEAR"
    id=$(( $(view "$DAO" get_last_proposal_id '{}') - 1 ))
    echo "Created proposal $id."
  fi
  status=$(approve "$id")
  [[ "$status" == Approved ]] || { echo "Proposal $id is $status, expected Approved." >&2; exit 1; }
  echo "Proposal $id Approved."
}

step_accounts() {
  say "accounts"
  for acc in "$A" "$B" "$C" "$GUARD" "$AGENT" "${RECEIVERS[@]}"; do
    if [[ $(acct "$acc" exists) == true ]]; then
      echo "$acc exists."
    elif [[ -n "$FUNDER" ]]; then
      near account create-account fund-myself "$acc" '10 NEAR' autogenerate-new-keypair "$SAVE" sign-as "$FUNDER" "${NET[@]}" "$SIGN" send
    elif [[ "$acc" =~ ^[a-z0-9_-]+\.testnet$ ]]; then
      near account create-account sponsor-by-faucet-service "$acc" autogenerate-new-keypair "$SAVE" "${NET[@]}" create
    else
      echo "$acc does not exist and is not a top-level .testnet name: create and fund it yourself." >&2; exit 1
    fi
  done
}

step_dao() {
  say "dao"
  if [[ $(acct "$DAO" exists) == true ]]; then echo "$DAO exists."; return; fi
  local args
  args=$(jq -nc --arg n "$PREFIX" --arg a "$A" --arg b "$B" --arg c "$C" \
    '{ config: { name: $n, purpose: "Key Doctor Agent Guard demo", metadata: "" }, policy: [$a, $b, $c] }' | base64 | tr -d '\n')
  call "$A" "$FACTORY" create "{\"name\":\"$PREFIX\",\"args\":\"$args\"}" '6 NEAR'
  echo "DAO: $DAO  proposal_bond: $(fmt "$(view "$DAO" get_policy '{}' | jq -r .proposal_bond)")"
}

step_guard() {
  say "guard"
  if [[ $(acct "$GUARD" code) == true ]]; then
    is_guard || { echo "$GUARD already runs other code (or the GĐ15 spike). Pick a new KD_GUARD_PREFIX or KD_GUARD_ACCOUNT." >&2; exit 1; }
    [[ $(view "$GUARD" get_config '{}' | jq -r .dao_id) == "$DAO" ]] \
      || { echo "$GUARD is a Guard for another DAO." >&2; exit 1; }
    echo "$GUARD already runs the Guard for $DAO."; return
  fi
  (cd "$CRATE" && cargo near build non-reproducible-wasm --no-abi)
  local path="$CRATE/target/near/kd_guard.wasm" init
  echo "wasm: $path ($(wc -c <"$path" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$path" | cut -d' ' -f1))"
  init=$(jq -nc --arg dao "$DAO" --arg agent "$AGENT" --arg c "$C" \
    --arg r0 "${RECEIVERS[0]}" --arg r1 "${RECEIVERS[1]}" --arg r2 "${RECEIVERS[2]}" \
    --arg l0 "${LABELS[0]}" --arg l1 "${LABELS[1]}" --arg l2 "${LABELS[2]}" \
    --arg tx "$(y 5)" --arg day "$(y 10)" --arg reserve "$(y 1)" '{ dao_id: $dao,
      policy: { max_per_tx: $tx, max_per_day: $day, max_pending_per_agent: 3, min_reserve: $reserve },
      agents: [{ account_id: $agent, label: "Claude Code agent" }],
      whitelist: [{ account_id: $r0, label: $l0, max_per_tx: null }, { account_id: $r1, label: $l1, max_per_tx: null },
                  { account_id: $r2, label: $l2, max_per_tx: null }],
      guardians: [$c] }')
  near contract deploy "$GUARD" use-file "$path" with-init-call new json-args "$init" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "$SIGN" send
  view "$GUARD" get_config '{}' | jq .
}

step_role() {
  say "role"
  local current policy
  current=$(view "$DAO" get_policy '{}')
  if jq -e --argjson r "$(role)" "$HAS_ROLE" <<<"$current" >/dev/null; then
    echo "Role agent-guard is in the DAO policy."; return
  fi
  # Factory DAOs reject ChangePolicyAddOrUpdateRole (G-Q1), so this is ChangePolicy with the whole current
  # policy: read right before proposing. If the council passes another policy change first, re-run this step.
  policy=$(jq --argjson r "$(role)" '.roles = ([.roles[] | select(.name != "agent-guard")] + [$r])' <<<"$current")
  echo "Policy change for the council to check (- current, + proposed):"
  diff -u <(jq -S . <<<"$current") <(jq -S . <<<"$policy") | tail -n +3 || true
  propose_and_pass "$ROLE_DESC" "$(jq -c '{ ChangePolicy: { policy: . } }' <<<"$policy")"
}

step_fund() {
  say "fund"
  local fund need short half v id="" status=""
  fund=$(y "$FUND")
  read -r id status <<<"$(find_proposal "$FUND_DESC")" || true
  if [[ "$status" == Approved ]]; then echo "Guard funding proposal $id already Approved."; fund=0; fi
  need=$("${NJS[@]}" add "$fund" "$(y "$TREASURY")")
  if ! ge "$(acct "$DAO" spendable)" "$need"; then
    short=$("${NJS[@]}" sub "$need" "$(acct "$DAO" spendable)")
    half=$(node -p "((BigInt('$short') + 1n) / 2n + 10n ** 21n).toString()") # + 0.001 NEAR for rounding
    echo "DAO is $(fmt "$short") short of $(fmt "$need"): b and c send $(fmt "$half") each."
    for v in "$B" "$C"; do
      ge "$(acct "$v" spendable)" "$("${NJS[@]}" add "$half" "$(y 0.5)")" \
        || { echo "$v cannot spare $(fmt "$half"). Send $(fmt "$short") to $DAO yourself, then re-run." >&2; exit 1; }
      near tokens "$v" send-near "$DAO" "$half yoctoNEAR" "${NET[@]}" "$SIGN" send
    done
  fi
  echo "DAO spendable: $(fmt "$(acct "$DAO" spendable)")"
  [[ "$fund" != 0 ]] || return 0
  propose_and_pass "$FUND_DESC" "$(jq -nc --arg g "$GUARD" --arg a "$fund" \
    '{ Transfer: { token_id: "", receiver_id: $g, amount: $a, msg: null } }')"
  echo "Guard spendable: $(fmt "$(acct "$GUARD" spendable)")"
}

step_agent() {
  say "agent"
  local pk onchain
  if [[ -f "$KEY_FILE" ]]; then
    [[ $(jq -r .account_id "$KEY_FILE") == "$AGENT" ]] || { echo "$KEY_FILE belongs to another account." >&2; exit 1; }
    pk=$(jq -r .public_key "$KEY_FILE")
    echo "Key file: $KEY_FILE"
  else
    pk=$("${NJS[@]}" keygen "$KEY_FILE" "$AGENT")
    echo "New agent key written to $KEY_FILE (mode 600). Public key: $pk"
  fi
  onchain=$("${NJS[@]}" keys "$AGENT" | jq -c --arg pk "$pk" '.[] | select(.public_key == $pk) | .access_key.permission')
  if [[ -n "$onchain" ]]; then
    echo "$AGENT already has this key: $onchain"; return
  fi
  near account add-key "$AGENT" grant-function-call-access --allowance '1 NEAR' --contract-account-id "$GUARD" \
    --function-names 'request_transfer, sync_request' use-manually-provided-public-key "$pk" "${NET[@]}" "$SIGN" send
}

step_verify() {
  say "verify"
  local fails=0 policy cfg bal bond reserve pk perm fa invoices
  ok() { echo "  ok    $*"; }
  bad() { echo "  FAIL  $*"; fails=$((fails + 1)); }

  policy=$(view "$DAO" get_policy '{}')
  if jq -e --argjson r "$(role)" "$HAS_ROLE" <<<"$policy" >/dev/null; then
    ok "role agent-guard: Group [$GUARD], transfer:AddProposal + transfer:VoteApprove, transfer threshold 1"
  else
    bad "role agent-guard missing or different from §11.4 (run: setup.sh role)"
  fi
  # A second role naming the Guard would give it more than transfers.
  if jq -e --arg g "$GUARD" '[.roles[] | select(.name != "agent-guard" and ((.kind.Group? // []) | index($g)))] | length == 0' <<<"$policy" >/dev/null; then
    ok "no other role names the Guard"
  else
    bad "another role names $GUARD: its permissions go beyond transfer"
  fi

  if is_guard; then
    cfg=$(view "$GUARD" get_config '{}')
    [[ $(jq -r .dao_id <<<"$cfg") == "$DAO" ]] && ok "Guard serves $DAO" || bad "Guard dao_id is $(jq -r .dao_id <<<"$cfg")"
    [[ $(jq -r .paused <<<"$cfg") == false ]] && ok "Guard not paused" || bad "Guard is paused"
    view "$GUARD" get_agents '{}' | jq -e --arg a "$AGENT" 'any(.[]; .account_id == $a and .enabled)' >/dev/null \
      && ok "agent $AGENT registered and enabled" \
      || bad "agent $AGENT not registered (needs a DAO FunctionCall proposal: add_agent)"
    [[ $(view "$GUARD" get_whitelist '{}' | jq --argjson r "$(printf '%s\n' "${RECEIVERS[@]}" | jq -R . | jq -s .)" \
      '[.[].account_id] as $w | all($r[]; . as $x | $w | index($x))') == true ]] \
      && ok "whitelist has ${RECEIVERS[*]}" || bad "whitelist misses a demo receiver"
    bal=$(acct "$GUARD" spendable)
    bond=$(view "$DAO" get_policy '{}' | jq -r .proposal_bond)
    reserve=$(view "$GUARD" get_policy '{}' | jq -r .min_reserve)
    ge "$bal" "$("${NJS[@]}" add "$bond" "$reserve")" \
      && ok "Guard spendable $(fmt "$bal") covers the bond $(fmt "$bond") + reserve $(fmt "$reserve")" \
      || bad "Guard spendable $(fmt "$bal") is below the bond + reserve: run setup.sh fund"
  else
    bad "$GUARD does not run the Guard 1.x (run: setup.sh guard)"
  fi

  invoices=$(y 6.5)
  ge "$(acct "$DAO" spendable)" "$invoices" \
    && ok "DAO spendable $(fmt "$(acct "$DAO" spendable)") covers the 3 demo invoices (6.5 NEAR)" \
    || bad "DAO spendable $(fmt "$(acct "$DAO" spendable)") is below 6.5 NEAR: run setup.sh fund"

  if [[ -f "$KEY_FILE" ]]; then
    pk=$(jq -r .public_key "$KEY_FILE")
    perm=$("${NJS[@]}" keys "$AGENT" | jq -c --arg pk "$pk" '.[] | select(.public_key == $pk) | .access_key.permission')
    if jq -e --arg g "$GUARD" --argjson m "$METHODS" '.FunctionCall.receiver_id == $g and (.FunctionCall.method_names | sort) == ($m | sort)' <<<"${perm:-null}" >/dev/null 2>&1; then
      ok "agent key: function-call on $GUARD, request_transfer + sync_request, allowance $(fmt "$(jq -r '.FunctionCall.allowance // 0' <<<"$perm")")"
    else
      bad "agent key in $KEY_FILE is not a function-call key for $GUARD with exactly request_transfer, sync_request: ${perm:-not on chain}"
    fi
  else
    bad "no agent key file at $KEY_FILE (run: setup.sh agent)"
  fi

  fa=$("${NJS[@]}" keys "$GUARD" | jq '[.[] | select(.access_key.permission == "FullAccess")] | length')
  [[ "$fa" == 0 ]] && echo "  lock  Guard is locked (no full-access key)" \
    || echo "  lock  Guard is NOT locked: $fa full-access key(s); Key Doctor flags GUARD_NOT_LOCKED. Run: setup.sh lock"

  [[ $fails == 0 ]] || { echo "$fails check(s) failed." >&2; return 1; }
  echo "All checks passed."
}

step_lock() {
  step_verify || { echo "Not locking: fix the failed checks first." >&2; exit 1; }
  say "lock"
  local keys answer
  keys=$("${NJS[@]}" keys "$GUARD" | jq -r '[.[] | select(.access_key.permission == "FullAccess") | .public_key] | join(", ")')
  if [[ -z "$keys" ]]; then echo "Guard already locked."; return; fi
  echo "This deletes every full-access key of $GUARD: $keys"
  echo "After that nobody can redeploy, upgrade or move funds from the Guard account except through its own"
  echo "methods (the DAO keeps set_policy, pause/unpause and withdraw_excess). It cannot be undone."
  read -r -p "Lock $GUARD now? [y/N] " answer </dev/tty || answer=""
  if [[ "$answer" != y && "$answer" != Y ]]; then
    echo "Not locked. Key Doctor will flag GUARD_NOT_LOCKED until you run: setup.sh lock"; return
  fi
  near account delete-keys "$GUARD" public-keys "$keys" "${NET[@]}" "$SIGN" send
  [[ $("${NJS[@]}" keys "$GUARD" | jq '[.[] | select(.access_key.permission == "FullAccess")] | length') == 0 ]] \
    || { echo "Full-access keys still present on $GUARD." >&2; exit 1; }
  echo "Guard locked."
}

step_info() {
  say "info"
  echo "dao=$DAO council=$A,$B,$C (2 of 3) guardian=$C"
  echo "guard=$GUARD agent=$AGENT receivers=${RECEIVERS[*]}"
  echo "Env for apps/guard-mcp (GĐ19):"
  echo "  GUARD_CONTRACT_ID=$GUARD"
  echo "  AGENT_ACCOUNT_ID=$AGENT"
  echo "  AGENT_KEY_PATH=$KEY_FILE"
  echo "  NEAR_NETWORK=testnet"
}

case "${1:-}" in
  all) step_accounts; step_dao; step_guard; step_role; step_fund; step_agent; step_lock; step_info ;;
  accounts|dao|guard|role|fund|agent|verify|lock|info) "step_$1" ;;
  *) sed -n '2,33p' "$0"; exit 2 ;;
esac
