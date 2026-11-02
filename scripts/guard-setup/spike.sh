#!/usr/bin/env bash
# GĐ15 Guard spike (docs/final-idea.md §13.6, docs/stories/epics/guard/plan.md).
# Proves that a contract member of a Sputnik v2 DAO can create a transfer proposal and approve it itself,
# with the NEAR leaving the DAO in the same transaction. Answers G-Q1 (role JSON) and G-Q2 (gas).
# G-Q1 (sandbox, tests/spike.rs): factory DAOs reject `ChangePolicyAddOrUpdateRole`, so add-role uses ChangePolicy.
# Developer tool, not part of the product: it signs with YOUR testnet keys through near-cli-rs (`near`),
# stored in your local keychain. Testnet only. Run one step at a time:
#
#   scripts/guard-setup/spike.sh accounts      # create a, b, c and the guard account with the testnet faucet
#   scripts/guard-setup/spike.sh dao           # a creates <prefix>.sputnik-v2.testnet (council a, b, c; 2 of 3)
#   scripts/guard-setup/spike.sh deploy        # build the spike wasm and deploy it to the guard account
#   scripts/guard-setup/spike.sh add-role      # a proposes ChangePolicy: current policy plus role "agent-guard"
#   scripts/guard-setup/spike.sh approve-role  # a and b approve the role proposal
#   scripts/guard-setup/spike.sh transfer      # a (the agent) calls guard.request_transfer: 0.1 NEAR to c
#   scripts/guard-setup/spike.sh status        # last proposal status, DAO policy role, balances
#
# Existing accounts: set KD_SPIKE_A, KD_SPIKE_B, KD_SPIKE_C, KD_SPIKE_GUARD (and
# KD_SPIKE_SIGN=sign-with-legacy-keychain for keys in ~/.near-credentials). The guard account needs about
# 3 NEAR (about 1.3 NEAR wasm storage plus the 1 NEAR proposal bond), a about 8 NEAR (6 for the DAO).
#
# Needs: near (near-cli-rs), cargo-near (plain `cargo build` can emit wasm features the NEAR VM rejects), node >= 22, jq.
# Env: KD_SPIKE_PREFIX (unique, e.g. kdg$(date +%s)), optional KD_SPIKE_AMOUNT (yoctoNEAR, default 0.1 NEAR).
set -euo pipefail

PREFIX="${KD_SPIKE_PREFIX:?set KD_SPIKE_PREFIX to a unique lowercase name, e.g. kdg$(date +%s)}"
[[ "$PREFIX" =~ ^[a-z0-9]{3,20}$ ]] || { echo "KD_SPIKE_PREFIX must be 3-20 lowercase letters or digits" >&2; exit 2; }
RPC="${RPC_URL_TESTNET:-https://rpc.testnet.near.org}"
FACTORY="sputnik-v2.testnet"
A="${KD_SPIKE_A:-${PREFIX}-a.testnet}"
B="${KD_SPIKE_B:-${PREFIX}-b.testnet}"
C="${KD_SPIKE_C:-${PREFIX}-c.testnet}"
GUARD="${KD_SPIKE_GUARD:-${PREFIX}-guard.testnet}"
SIGN="${KD_SPIKE_SIGN:-sign-with-keychain}"
AMOUNT="${KD_SPIKE_AMOUNT:-100000000000000000000000}"
DAO="${PREFIX}.${FACTORY}"
NET=(network-config testnet)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/contracts/guard"

call() { # call <signer> <contract> <method> <json> <deposit> [gas]
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-150.0 Tgas}" attached-deposit "$5" sign-as "$1" "${NET[@]}" "$SIGN" send
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
                     console.log(Buffer.from(b.result.result).toString()); });
  ' "$RPC" "$1" "$2" "$3"
}

last_id() { echo $(( $(view "$DAO" get_last_proposal_id '{}') - 1 )); }

# The role under test (§11.3): the Guard alone can add and approve transfers; quorum 0 and threshold weight 1
# mean its one vote passes a transfer. Weight is a string, Ratio would be [a, b].
role() {
  jq -n --arg g "$GUARD" '{ name: "agent-guard", kind: { Group: [$g] },
    permissions: ["transfer:AddProposal", "transfer:VoteApprove"],
    vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" } } }'
}

wasm() { # build the spike and print the wasm path
  (cd "$CRATE" && cargo near build non-reproducible-wasm --no-abi >&2)
  echo "$CRATE/target/near/kd_guard.wasm"
}

case "${1:-}" in
  accounts)
    [[ -z "${KD_SPIKE_A:-}" ]] || { echo "KD_SPIKE_A is set: using your existing accounts, nothing to create."; exit 0; }
    for acc in "$A" "$B" "$C" "$GUARD"; do
      near account create-account sponsor-by-faucet-service "$acc" autogenerate-new-keypair save-to-keychain "${NET[@]}" create
    done
    ;;
  dao)
    args=$(node -e 'const [n, ...m] = process.argv.slice(1);
      console.log(Buffer.from(JSON.stringify({ config: { name: n, purpose: "Key Doctor Guard spike", metadata: "" }, policy: m })).toString("base64"))' \
      "$PREFIX" "$A" "$B" "$C")
    call "$A" "$FACTORY" create "{\"name\":\"$PREFIX\",\"args\":\"$args\"}" '6 NEAR'
    echo "DAO: $DAO  proposal_bond: $(view "$DAO" get_policy '{}' | jq -r .proposal_bond)"
    ;;
  deploy)
    bond=$(view "$DAO" get_policy '{}' | jq -r .proposal_bond)
    path=$(wasm)
    echo "wasm: $path ($(wc -c <"$path") bytes, sha256 $(shasum -a 256 "$path" | cut -d' ' -f1))"
    near contract deploy "$GUARD" use-file "$path" with-init-call new \
      json-args "{\"dao_id\":\"$DAO\",\"agent_id\":\"$A\",\"proposal_bond\":\"$bond\"}" \
      prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "$SIGN" send
    view "$GUARD" get_config '{}'
    ;;
  add-role)
    policy=$(view "$DAO" get_policy '{}' | jq --argjson r "$(role)" '.roles = ([.roles[] | select(.name != "agent-guard")] + [$r])')
    proposal=$(jq -n --argjson p "$policy" '{ proposal: { description: "Add the Key Doctor Guard role (GD15 spike)",
      kind: { ChangePolicy: { policy: $p } } } }')
    call "$A" "$DAO" add_proposal "$proposal" "$(jq -r .proposal_bond <<<"$policy") yoctoNEAR"
    echo "Role proposal id: $(last_id). Next: approve-role"
    ;;
  approve-role)
    id="${2:-$(last_id)}"
    kind=$(view "$DAO" get_proposal "{\"id\":$id}" | jq -c .kind)
    for voter in "$A" "$B"; do
      call "$voter" "$DAO" act_proposal "{\"id\":$id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '0 NEAR'
    done
    view "$DAO" get_proposal "{\"id\":$id}" | jq '{ id, status }'
    view "$DAO" get_policy '{}' | jq '.roles[] | select(.name == "agent-guard")'
    ;;
  transfer)
    # 300 Tgas: add_proposal 20 + on_added 120 (act_proposal 80 + on_voted 10 inside it) + the outer call.
    call "$A" "$GUARD" request_transfer "{\"receiver_id\":\"$C\",\"amount\":\"$AMOUNT\"}" '0 NEAR' '300.0 Tgas'
    id=$(last_id)
    view "$DAO" get_proposal "{\"id\":$id}" | jq '{ id, proposer, status, kind }'
    echo "Done when: status is \"Approved\" and $C received the NEAR in the same transaction (check the tx above on testnet.nearblocks.io)."
    ;;
  status)
    id=$(last_id)
    view "$DAO" get_proposal "{\"id\":$id}" | jq '{ id, proposer, status, kind }'
    view "$DAO" get_policy '{}' | jq '{ proposal_bond, agent_guard: (.roles[] | select(.name == "agent-guard")) }'
    for acc in "$DAO" "$GUARD" "$C"; do
      near account view-account-summary "$acc" "${NET[@]}" now 2>&1 | grep -i 'native balance' | sed "s|^|$acc |" || true
    done
    ;;
  info)
    echo "a=$A b=$B c=$C guard=$GUARD dao=$DAO amount=$AMOUNT"
    ;;
  *)
    sed -n '2,22p' "$0"
    exit 2
    ;;
esac
