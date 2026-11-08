#!/usr/bin/env bash
# YD0 yield spike (docs/stories/epics/yield/plan.md, YD0). Proves that a Sputnik v2 DAO can supply a stablecoin
# to Rhea Lend on testnet and get it back, through normal FunctionCall proposals the council votes on.
# Answers the open YD0 facts: exact args and `msg`, storage cost, gas, and whether Withdraw needs an oracle call.
# Results go to docs/yield-spike-2026-11-09.md.
#
# Developer tool, not part of the product: it signs with YOUR testnet keys through near-cli-rs (`near`).
# Testnet only, test tokens only (`usdc.fakes.testnet` lets anyone `mint`). Run one step at a time:
#
#   scripts/yield-setup/spike.sh check             # read only: Rhea Lend asset config, storage costs, DAO state
#   scripts/yield-setup/spike.sh dao               # member creates <prefix>.sputnik-v2.testnet, council = member only
#   scripts/yield-setup/spike.sh fund              # member registers the DAO on the token and mints test USDC to it
#   scripts/yield-setup/spike.sh propose-register  # proposal 1: DAO pays Rhea Lend storage_deposit (0.1 NEAR)
#   scripts/yield-setup/spike.sh propose-supply    # proposal 2: DAO ft_transfer_call the token into Rhea Lend
#   scripts/yield-setup/spike.sh propose-withdraw  # proposal 3: DAO calls Rhea Lend execute([Withdraw]) for all of it
#   scripts/yield-setup/spike.sh approve [id]      # every voter in KD_YIELD_VOTERS approves (default: last proposal)
#   scripts/yield-setup/spike.sh status            # last proposal, DAO token balance, DAO position on Rhea Lend
#
# Order: check, dao, fund, then for each proposal: propose-*, approve, status.
# Done when: after propose-withdraw + approve, the DAO's token balance is back to at least what it supplied,
# and Rhea Lend shows no supplied balance for the DAO. Record every tx hash in the results doc.
#
# Env:
#   KD_YIELD_MEMBER   existing testnet account that creates the DAO, pays fees and proposes (required)
#   KD_YIELD_PREFIX   unique DAO name, e.g. kdy$(date +%s) (required unless KD_YIELD_DAO is set)
#   KD_YIELD_DAO      use an existing DAO instead (skips `dao`); the member must be able to add FunctionCall proposals
#   KD_YIELD_VOTERS   comma list of council accounts that approve (default: the member)
#   KD_YIELD_SIGN     near-cli-rs signing mode (default sign-with-keychain; sign-with-legacy-keychain for ~/.near-credentials)
#   KD_YIELD_AMOUNT   token amount in raw units (default 10000000 = 10 USDC, 6 decimals); fund mints 2x this
#   KD_YIELD_DRY=1    print each signing command instead of sending it (the read-only parts still run)
# The member needs about 7 NEAR for `dao` (6 go into the DAO for storage, the 0.1 NEAR Rhea deposit and the bond).
#
# Needs: near (near-cli-rs), node >= 22, jq.
set -euo pipefail

RPC="${RPC_URL_TESTNET:-https://rpc.testnet.near.org}"
FACTORY="sputnik-v2.testnet"
LEND="contract.1638481328.burrow.testnet" # Rhea Lend (Burrow) on testnet
TOKEN="usdc.fakes.testnet"                # test token, 6 decimals, open mint
MEMBER="${KD_YIELD_MEMBER:?set KD_YIELD_MEMBER to an existing testnet account you hold the key for}"
if [[ -n "${KD_YIELD_DAO:-}" ]]; then
  DAO="$KD_YIELD_DAO"
else
  PREFIX="${KD_YIELD_PREFIX:?set KD_YIELD_PREFIX to a unique lowercase name, e.g. kdy$(date +%s), or set KD_YIELD_DAO}"
  [[ "$PREFIX" =~ ^[a-z0-9]{3,20}$ ]] || { echo "KD_YIELD_PREFIX must be 3-20 lowercase letters or digits" >&2; exit 2; }
  DAO="${PREFIX}.${FACTORY}"
fi
[[ "$DAO" == *.testnet ]] || { echo "testnet only: $DAO does not end in .testnet" >&2; exit 2; }
IFS=',' read -r -a VOTERS <<<"${KD_YIELD_VOTERS:-$MEMBER}"
SIGN="${KD_YIELD_SIGN:-sign-with-keychain}"
AMOUNT="${KD_YIELD_AMOUNT:-10000000}"
[[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]] || { echo "KD_YIELD_AMOUNT must be a positive integer in raw units" >&2; exit 2; }
NET=(network-config testnet)
ONE_YOCTO="1"
LEND_STORAGE="100000000000000000000000" # Rhea Lend storage_balance_bounds.min, checked 2026-11-08 (0.1 NEAR)

call() { # call <signer> <contract> <method> <json> <deposit> [gas]
  local cmd=(near contract call-function as-transaction "$2" "$3" json-args "$4"
    prepaid-gas "${6:-100.0 Tgas}" attached-deposit "$5" sign-as "$1" "${NET[@]}" "$SIGN" send)
  if [[ "${KD_YIELD_DRY:-}" == 1 ]]; then printf 'DRY:'; printf ' %q' "${cmd[@]}"; echo; else "${cmd[@]}"; fi
}

view() { # view <contract> <method> <json> -> JSON result on stdout
  node -e '
    const [rpc, account, method, args] = process.argv.slice(1);
    fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: account, method_name: method,
                args_base64: Buffer.from(args).toString("base64") } }) })
      .then((r) => r.json())
      .then((b) => { if (!b.result || b.result.error) { console.error(JSON.stringify(b.error ?? b.result)); process.exit(1); }
                     console.log(Buffer.from(b.result.result).toString() || "null"); });
  ' "$RPC" "$1" "$2" "$3"
}

b64() { node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' "$1"; }

last_id() { echo $(( $(view "$DAO" get_last_proposal_id '{}') - 1 )); }

# propose <description> <receiver> <method> <args json> <deposit yocto> <gas>: one FunctionCall proposal.
# Gas is a string of gas units. The vote that executes it must carry more than this (approve sends 300 Tgas).
propose() {
  local bond proposal
  bond=$(view "$DAO" get_policy '{}' | jq -r .proposal_bond)
  proposal=$(jq -nc --arg d "$1" --arg r "$2" --arg m "$3" --arg a "$(b64 "$4")" --arg dep "$5" --arg g "$6" \
    '{ proposal: { description: $d, kind: { FunctionCall: { receiver_id: $r,
       actions: [{ method_name: $m, args: $a, deposit: $dep, gas: $g }] } } } }')
  echo "args: $4"
  call "$MEMBER" "$DAO" add_proposal "$proposal" "$bond yoctoNEAR"
  [[ "${KD_YIELD_DRY:-}" == 1 ]] || echo "Proposal id: $(last_id). Next: approve"
}

position() { # DAO position on Rhea Lend, or null when the DAO is not registered there
  view "$LEND" get_account "{\"account_id\":\"$DAO\"}" | jq -c --arg t "$TOKEN" 'if . == null then null else
    { supplied: [.supplied[]? | select(.token_id == $t) | { balance, shares, apr }],
      collateral: [.collateral[]? | select(.token_id == $t) | { balance, shares }] } end'
}

case "${1:-}" in
  check)
    echo "DAO $DAO  member $MEMBER  voters ${VOTERS[*]}  amount $AMOUNT"
    view "$LEND" get_asset "{\"token_id\":\"$TOKEN\"}" | jq -c '{ supply_apr, extra_decimals: .config.extra_decimals,
      can_deposit: .config.can_deposit, can_withdraw: .config.can_withdraw }'
    echo "Rhea Lend storage_balance_bounds: $(view "$LEND" storage_balance_bounds '{}')"
    echo "Token storage_balance_bounds:     $(view "$TOKEN" storage_balance_bounds '{}')"
    if view "$DAO" get_policy '{}' >/dev/null 2>&1; then
      echo "DAO bond: $(view "$DAO" get_policy '{}' | jq -r .proposal_bond)  token balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$DAO\"}")"
      echo "DAO on Rhea Lend: $(position)"
    else
      echo "DAO $DAO does not exist yet. Next: dao"
    fi
    ;;
  dao)
    [[ -z "${KD_YIELD_DAO:-}" ]] || { echo "KD_YIELD_DAO is set: using the existing DAO, nothing to create."; exit 0; }
    args=$(node -e 'const [n, m] = process.argv.slice(1);
      console.log(Buffer.from(JSON.stringify({ config: { name: n, purpose: "Key Doctor yield spike", metadata: "" }, policy: [m] })).toString("base64"))' \
      "$PREFIX" "$MEMBER")
    call "$MEMBER" "$FACTORY" create "{\"name\":\"$PREFIX\",\"args\":\"$args\"}" '6 NEAR' '150.0 Tgas'
    ;;
  fund)
    # Test token only: anyone can register an account and mint. The DAO itself is not involved.
    call "$MEMBER" "$TOKEN" storage_deposit "{\"account_id\":\"$DAO\",\"registration_only\":true}" '0.00125 NEAR' '30.0 Tgas'
    call "$MEMBER" "$TOKEN" mint "{\"account_id\":\"$DAO\",\"amount\":\"$((AMOUNT * 2))\"}" '0 NEAR' '30.0 Tgas'
    [[ "${KD_YIELD_DRY:-}" == 1 ]] || echo "DAO token balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$DAO\"}")"
    ;;
  propose-register)
    propose "[KD-YIELD] register the DAO on Rhea Lend" "$LEND" storage_deposit \
      '{}' "$LEND_STORAGE" "30000000000000"
    ;;
  propose-supply)
    # msg "" supplies without collateral, so Withdraw needs no oracle prices (checked by this spike).
    propose "[KD-YIELD] supply $AMOUNT $TOKEN to Rhea Lend" "$TOKEN" ft_transfer_call \
      "{\"receiver_id\":\"$LEND\",\"amount\":\"$AMOUNT\",\"msg\":\"\"}" "$ONE_YOCTO" "150000000000000"
    ;;
  propose-withdraw)
    # No max_amount: withdraw the whole supplied balance, interest included.
    propose "[KD-YIELD] withdraw all $TOKEN from Rhea Lend" "$LEND" execute \
      "{\"actions\":[{\"Withdraw\":{\"token_id\":\"$TOKEN\"}}]}" "$ONE_YOCTO" "150000000000000"
    ;;
  approve)
    id="${2:-$(last_id)}"
    kind=$(view "$DAO" get_proposal "{\"id\":$id}" | jq -c .kind)
    for voter in "${VOTERS[@]}"; do
      status=$(view "$DAO" get_proposal "{\"id\":$id}" | jq -r .status)
      [[ "$status" == "InProgress" ]] || { echo "proposal $id is $status, no more votes needed"; break; }
      call "$voter" "$DAO" act_proposal "{\"id\":$id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '0 NEAR' '300.0 Tgas'
    done
    [[ "${KD_YIELD_DRY:-}" == 1 ]] || view "$DAO" get_proposal "{\"id\":$id}" | jq -c '{ id, status }'
    ;;
  status)
    id=$(last_id)
    view "$DAO" get_proposal "{\"id\":$id}" | jq -c '{ id, description, status }'
    echo "DAO token balance: $(view "$TOKEN" ft_balance_of "{\"account_id\":\"$DAO\"}")"
    echo "DAO on Rhea Lend:  $(position)"
    ;;
  *)
    sed -n '2,32p' "$0"
    exit 2
    ;;
esac
