#!/usr/bin/env bash
# GĐ31 S2: put Guard 1.3.0 into the testnet factory (docs/stories/epics/guard/gd31-dca-plan.md, Change 1.8).
# Builds the Guard and the factory wasm, redeploys the factory code on the factory account (its state is unchanged,
# so no init call), then calls `set_guard_code` with the Guard wasm and compares the factory's code hash with the
# local one. New Budgets then start on the new Guard; existing Budgets upgrade with `code_source` = the factory.
# Developer tool, not part of the product: it signs with the factory's own full-access key through near-cli-rs
# (`near`), kept in your local keychain. Testnet only. A DRY RUN unless --send is passed: it builds, prints the
# hashes and what it would do, and sends nothing.
#
#   scripts/guard-setup/factory-update.sh [factory-account]          # dry run; default keydoctor-guards-v2.testnet
#   scripts/guard-setup/factory-update.sh [factory-account] --send   # deploy, set the code, verify
#
# Env: KD_GUARD_SIGN (default sign-with-keychain; sign-with-legacy-keychain for ~/.near-credentials),
# KD_GUARD_FUNDER (rich account that tops up the factory when the bigger code needs more storage; without it the
# script stops and tells you the amount). Needs: near (near-cli-rs), cargo-near, node >= 22, jq.
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
GUARD_WASM="$ROOT/contracts/guard/target/near/kd_guard.wasm"
FACTORY_WASM="$ROOT/contracts/guard-factory/target/near/kd_guard_factory.wasm"

view() { "${NJS[@]}" view "$@"; }
acct() { "${NJS[@]}" account "$1" | jq -r ".$2"; }
y() { "${NJS[@]}" yocto "$1"; }
fmt() { "${NJS[@]}" fmt "$1"; }
ge() { "${NJS[@]}" ge "$1" "$2"; }
say() { printf '\n== %s\n' "$*"; }
size() { wc -c <"$1" | tr -d ' '; }
# The factory shows the hash in base58; shasum gives hex.
b58() { node -e 'const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+process.argv[1]),s="";while(n>0n){s=A[Number(n%58n)]+s;n/=58n}process.stdout.write("1".repeat((process.argv[1].match(/^(00)*/)[0].length)/2)+s)' "$1"; }

say "build"
(cd "$ROOT/contracts/guard" && cargo near build non-reproducible-wasm --no-abi)
(cd "$ROOT/contracts/guard-factory" && cargo near build non-reproducible-wasm --no-abi)
HEX=$(shasum -a 256 "$GUARD_WASM" | cut -d' ' -f1)
HASH=$(b58 "$HEX")
echo "guard wasm   $(size "$GUARD_WASM") bytes, sha256 $HEX, base58 $HASH"
echo "factory wasm $(size "$FACTORY_WASM") bytes"

say "factory $FACTORY"
[[ $(acct "$FACTORY" code) == true ]] || { echo "$FACTORY has no code: use setup.sh factory for a first deploy." >&2; exit 1; }
meta=$(view "$FACTORY" kd_factory_metadata '{}')
echo "now: guard code hash $(jq -r .guard_code_hash <<<"$meta"), $(jq -r .guards <<<"$meta") Guard(s) registered"
if [[ $(jq -r .guard_code_hash <<<"$meta") == "$HASH" ]]; then
  echo "The factory already holds this Guard code. Nothing to do."; exit 0
fi

# Estimate: the Guard code delta plus 0.5 NEAR for the factory wasm, which only changes a little.
old=$(jq -r .guard_code_storage <<<"$meta")
new=$(node -p "(BigInt($(size "$GUARD_WASM")) * 10n ** 19n).toString()")
extra=$(node -p "(BigInt('$new') > BigInt('$old') ? BigInt('$new') - BigInt('$old') : 0n).toString()")
need=$("${NJS[@]}" add "$extra" "$(y 0.5)")
spendable=$(acct "$FACTORY" spendable)
echo "spendable $(fmt "$spendable"); the bigger code needs about $(fmt "$need") more"
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
  echo "Would deploy $FACTORY_WASM on $FACTORY, then call set_guard_code with the Guard wasm (borsh, $(size "$GUARD_WASM") bytes),"
  echo "both signed by $FACTORY, and expect get_code_hash = $HASH. Re-run with --send to do it."
  exit 0
fi

say "deploy factory code"
near contract deploy "$FACTORY" use-file "$FACTORY_WASM" without-init-call "${NET[@]}" "$SIGN" send

say "set_guard_code"
# `set_guard_code` takes borsh Vec<u8>: u32 little-endian length, then the bytes.
near contract call-function as-transaction "$FACTORY" set_guard_code base64-args \
  "$(node -e 'const c=require("fs").readFileSync(process.argv[1]);const n=Buffer.alloc(4);n.writeUInt32LE(c.length);process.stdout.write(Buffer.concat([n,c]).toString("base64"))' "$GUARD_WASM")" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as "$FACTORY" "${NET[@]}" "$SIGN" send

say "verify"
got=$(view "$FACTORY" get_code_hash '{}' | jq -r .)
if [[ "$got" == "$HASH" ]]; then
  echo "ok: the factory holds Guard code $HASH"
else
  echo "MISMATCH: factory says $got, local build is $HASH" >&2; exit 1
fi
echo "Record the hash in docs/stories/backlog.md and the README. Existing Budgets upgrade with code_source = $FACTORY."
