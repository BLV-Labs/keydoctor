#!/usr/bin/env bash
# Key Doctor testnet demo (docs/usecase.md UC6 demo, docs/final-idea.md §14.2).
# Builds a 3-member Sputnik DAO whose transfers need 2 votes, then plays the attack step by step.
# Developer tool, not part of the product: it signs with YOUR testnet keys through near-cli-rs (`near`),
# stored in your local keychain. Testnet only. Run one step at a time:
#
#   scripts/demo-testnet/demo.sh accounts     # create members a, b, c with the testnet faucet
#   scripts/demo-testnet/demo.sh dao          # a creates <prefix>.sputnik-v2.testnet (council a, b, c)
#   (in Telegram: add the bot to a group and send /watch <dao>)
#   scripts/demo-testnet/demo.sh transfer     # b proposes "transfer 1 NEAR to c"
#   scripts/demo-testnet/demo.sh compromise   # a gets a new full-access key ("the attacker's")
#   scripts/demo-testnet/demo.sh vote         # a approves the transfer
#   scripts/demo-testnet/demo.sh run-check    # POST /run-check: the group gets the alert naming b and c
#   scripts/demo-testnet/demo.sh governance   # b proposes adding a new council member
#   scripts/demo-testnet/demo.sh run-check    # the group gets the governance alert
#
# Timing: a faucet account's own first key is a "new full-access key" for 48 hours, so every member's vote
# would alert. Run `accounts` at least 48 hours before the demo, or set NEW_KEY_WINDOW_HOURS=1 on the demo
# Worker and wait more than an hour after `accounts` before `compromise`.
#
# Needs: near (near-cli-rs), node >= 22, curl. Env: KD_DEMO_PREFIX (unique, e.g. kdd$(date +%s)),
# and for run-check: KD_WORKER_URL (https://<worker>.workers.dev) and RUN_CHECK_TOKEN.
set -euo pipefail

PREFIX="${KD_DEMO_PREFIX:?set KD_DEMO_PREFIX to a unique lowercase name, e.g. kdd$(date +%s)}"
[[ "$PREFIX" =~ ^[a-z0-9]{3,20}$ ]] || { echo "KD_DEMO_PREFIX must be 3-20 lowercase letters or digits" >&2; exit 2; }
RPC="${RPC_URL_TESTNET:-https://rpc.testnet.near.org}"
FACTORY="sputnik-v2.testnet"
A="${PREFIX}-a.testnet"
B="${PREFIX}-b.testnet"
C="${PREFIX}-c.testnet"
DAO="${PREFIX}.${FACTORY}"
NET=(network-config testnet)

call() { # call <signer> <contract> <method> <json> <deposit>
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas '150.0 Tgas' attached-deposit "$5" sign-as "$1" "${NET[@]}" sign-with-keychain send
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

case "${1:-}" in
  accounts)
    for acc in "$A" "$B" "$C"; do
      near account create-account sponsor-by-faucet-service "$acc" autogenerate-new-keypair save-to-keychain "${NET[@]}" create
    done
    ;;
  dao)
    args=$(node -e 'const [n, ...m] = process.argv.slice(1);
      console.log(Buffer.from(JSON.stringify({ config: { name: n, purpose: "Key Doctor demo", metadata: "" }, policy: m })).toString("base64"))' \
      "$PREFIX" "$A" "$B" "$C")
    call "$A" "$FACTORY" create "{\"name\":\"$PREFIX\",\"args\":\"$args\"}" '6 NEAR'
    echo "DAO: $DAO"
    echo "Next: add the bot to a Telegram group and send: /watch $DAO"
    ;;
  transfer)
    call "$B" "$DAO" add_proposal \
      "{\"proposal\":{\"description\":\"Pay the design contractor\",\"kind\":{\"Transfer\":{\"token_id\":\"\",\"receiver_id\":\"$C\",\"amount\":\"1000000000000000000000000\"}}}}" \
      '1 NEAR'
    echo "Transfer proposal id: $(last_id)"
    ;;
  compromise)
    near account add-key "$A" grant-full-access autogenerate-new-keypair save-to-keychain "${NET[@]}" sign-with-keychain send
    echo "$A now has a fresh full-access key."
    ;;
  vote)
    id="${2:-$(last_id)}"
    kind=$(view "$DAO" get_proposal "{\"id\":$id}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).kind)))')
    call "$A" "$DAO" act_proposal "{\"id\":$id,\"action\":\"VoteApprove\",\"proposal\":$kind}" '0 NEAR'
    echo "$A approved proposal $id. One more vote passes it."
    ;;
  governance)
    call "$B" "$DAO" add_proposal \
      "{\"proposal\":{\"description\":\"Add a council member\",\"kind\":{\"AddMemberToRole\":{\"member_id\":\"${PREFIX}-newcomer.testnet\",\"role\":\"council\"}}}}" \
      '1 NEAR'
    echo "Governance proposal id: $(last_id)"
    ;;
  run-check)
    : "${KD_WORKER_URL:?set KD_WORKER_URL}" "${RUN_CHECK_TOKEN:?set RUN_CHECK_TOKEN}"
    curl -sS -X POST "$KD_WORKER_URL/run-check" -H "authorization: Bearer $RUN_CHECK_TOKEN" \
      -H 'content-type: application/json' -d "{\"job\":\"proposals\",\"target\":\"$DAO\"}"
    echo
    ;;
  info)
    echo "a=$A b=$B c=$C dao=$DAO"
    ;;
  *)
    sed -n '2,20p' "$0"
    exit 2
    ;;
esac
