#!/usr/bin/env bash
# Issue #81: make new Guards use the Guard code as a NEP-591 global contract instead of each holding a copy.
# Redeploys the factory code on the factory account (its state is unchanged, so no init call), then calls
# `publish_guard_code_global`, which publishes the Guard code the factory already stores, by hash. After that a new
# Guard locks about 0.007 NEAR of storage instead of about 3.6 NEAR, and the dashboard's cost lines follow
# `kd_factory_metadata.guard_code_storage` on their own. Guards made before keep their own copy.
# The publish BURNS 10x the storage price of the Guard code (about 36 NEAR for 355 KB) from the factory account.
# It is not refunded, and it must be paid again after each `set_guard_code`.
# Developer tool, not part of the product: it signs with the factory's own full-access key through near-cli-rs
# (`near`), kept in your local keychain. Testnet only. A DRY RUN unless --send is passed.
#
#   scripts/guard-setup/factory-global.sh [factory-account]          # dry run; default keydoctor-guards-v2.testnet
#   scripts/guard-setup/factory-global.sh [factory-account] --send   # deploy, publish, verify
#
# Env: KD_GUARD_SIGN (default sign-with-keychain; sign-with-legacy-keychain for ~/.near-credentials),
# KD_GUARD_FUNDER (rich account that tops up the factory for the burn; without it the script stops and tells you the
# amount). Needs: near (near-cli-rs), cargo-near, node >= 22, jq.
set -euo pipefail

FACTORY="keydoctor-guards-v2.testnet"
SEND=false
for arg in "$@"; do
  case "$arg" in
    --send) SEND=true ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) FACTORY="$arg" ;;
  esac
done
[[ "$FACTORY" == *.testnet ]] || { echo "Testnet only: $FACTORY is not a .testnet account." >&2; exit 2; }

SIGN="${KD_GUARD_SIGN:-sign-with-keychain}"
FUNDER="${KD_GUARD_FUNDER:-}"
NET=(network-config testnet)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NJS=(node "$ROOT/scripts/guard-setup/near.mjs")
FACTORY_WASM="$ROOT/contracts/guard-factory/target/near/kd_guard_factory.wasm"

view() { "${NJS[@]}" view "$@"; }
acct() { "${NJS[@]}" account "$1" | jq -r ".$2"; }
y() { "${NJS[@]}" yocto "$1"; }
fmt() { "${NJS[@]}" fmt "$1"; }
ge() { "${NJS[@]}" ge "$1" "$2"; }
say() { printf '\n== %s\n' "$*"; }

say "build"
(cd "$ROOT/contracts/guard-factory" && cargo near build non-reproducible-wasm --no-abi)
echo "factory wasm $(wc -c <"$FACTORY_WASM" | tr -d ' ') bytes"

say "factory $FACTORY"
[[ $(acct "$FACTORY" code) == true ]] || { echo "$FACTORY has no code: use setup.sh factory for a first deploy." >&2; exit 1; }
meta=$(view "$FACTORY" kd_factory_metadata '{}')
HASH=$(jq -r .guard_code_hash <<<"$meta")
echo "now: guard code hash $HASH, $(jq -r .guards <<<"$meta") Guard(s) registered, global $(jq -r '.guard_code_global // "unknown (old factory code)"' <<<"$meta")"
if [[ $(jq -r '.guard_code_global // false' <<<"$meta") == true ]]; then
  echo "New Guards already use the global Guard code. Nothing to do."; exit 0
fi

# The burn is 10x the Guard code's storage price; 1 NEAR more for gas and the factory wasm, which changes a little.
copy=$(jq -r .guard_code_storage <<<"$meta")
burn=$(node -p "(BigInt('$copy') * 10n).toString()")
need=$("${NJS[@]}" add "$burn" "$(y 1)")
spendable=$(acct "$FACTORY" spendable)
echo "spendable $(fmt "$spendable"); the publish burns about $(fmt "$burn"), so it needs about $(fmt "$need")"
if ! ge "$spendable" "$need"; then
  short=$("${NJS[@]}" sub "$need" "$spendable")
  if [[ "$SEND" != true ]]; then
    echo "Would top up $FACTORY with $(fmt "$short") first (set KD_GUARD_FUNDER for --send)."
  else
    [[ -n "$FUNDER" ]] || { echo "Top up $FACTORY with $(fmt "$short") yourself, or set KD_GUARD_FUNDER, then re-run." >&2; exit 1; }
    near tokens "$FUNDER" send-near "$FACTORY" "$short yoctoNEAR" "${NET[@]}" "$SIGN" send
  fi
fi

if [[ "$SEND" != true ]]; then
  say "dry run"
  echo "Would deploy $FACTORY_WASM on $FACTORY without init, then call publish_guard_code_global (300 Tgas),"
  echo "both signed by $FACTORY, and expect guard_code_global = true for hash $HASH. Re-run with --send to do it."
  exit 0
fi

say "deploy factory code"
near contract deploy "$FACTORY" use-file "$FACTORY_WASM" without-init-call "${NET[@]}" "$SIGN" send

say "publish_guard_code_global"
near contract call-function as-transaction "$FACTORY" publish_guard_code_global json-args '{}' \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as "$FACTORY" "${NET[@]}" "$SIGN" send

say "verify"
meta=$(view "$FACTORY" kd_factory_metadata '{}')
if [[ $(jq -r .guard_code_global <<<"$meta") == true && $(jq -r .guard_code_hash <<<"$meta") == "$HASH" ]]; then
  echo "ok: new Guards use global code $HASH; each locks $(fmt "$(jq -r .guard_code_storage <<<"$meta")") for it"
else
  echo "NOT GLOBAL: $meta" >&2; exit 1
fi
echo "Record the tx hashes in docs/stories/backlog.md (C12) and the README."
