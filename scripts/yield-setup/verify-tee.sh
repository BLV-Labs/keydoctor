#!/usr/bin/env bash
# YD2 TEE proof (docs/stories/epics/yield/plan.md §2, ADR 0004). Sends ONE yield-advice request, byte for byte the
# body the Worker sends (adviceRequest on the synthetic testnet report in packages/key-doctor/scripts/yield-sample.ts),
# then runs NEAR AI's own verifier (github.com/nearai/nearai-cloud-verifier, pinned below) on that exact call:
#   - SHA-256 of our request and response bytes match the signed text,
#   - the ECDSA signature recovers to the signing address,
#   - that address is bound in the model's Intel TDX report data, the TDX quote verifies, and the NVIDIA GPU
#     attestation (NRAS) carries our fresh nonce.
# Writes the result into docs/yield-tee-verify.md (between the run markers) and the full log to
# data/raw/yield-tee-verify.log (gitignored: it holds the raw model text and the attested compose manifest).
#
# Needs: git, python3 (3.10+), node (>=22.18), network. Costs one small chat call on the key's account.
# The key comes from the environment only; it is never printed, and every log line is scrubbed of it.
#
#   NEAR_AI_API_KEY=... scripts/yield-setup/verify-tee.sh [model]     # default: first model of YIELD_MODEL_CHAIN
#
# The model must be on YIELD_TEE_MODELS. KD_VERIFIER_DIR overrides where the verifier is cloned
# (default ~/.cache/key-doctor/nearai-cloud-verifier). Exit 0 only if every check passed.
set -euo pipefail

VERIFIER_URL="https://github.com/nearai/nearai-cloud-verifier.git"
VERIFIER_REF="94554726fd548676842b7ea603a8173a60c31341" # main on 2026-08-10, checked 2026-11-08
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${KD_VERIFIER_DIR:-$HOME/.cache/key-doctor/nearai-cloud-verifier}"
DOC="$ROOT/docs/yield-tee-verify.md"
LOG="$ROOT/data/raw/yield-tee-verify.log"

die() { echo "verify-tee: $*" >&2; exit 1; }
[ -n "${NEAR_AI_API_KEY:-}" ] || die "export NEAR_AI_API_KEY first (the Worker secret is not readable locally)"
command -v python3 >/dev/null || die "python3 is required"
command -v node >/dev/null || die "node is required"

cd "$ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. The request body, from the library (refuses a model that is not on the TEE list).
node --input-type=module - "${1:-}" >"$WORK/request.json" <<'EOF'
const root = process.cwd();
const lib = await import(`${root}/packages/key-doctor/src/index.ts`);
const { YIELD_SAMPLE_REPORT } = await import(`${root}/packages/key-doctor/scripts/yield-sample.ts`);
const id = process.argv[2] || lib.YIELD_MODEL_CHAIN[0];
const model = lib.YIELD_TEE_MODELS.find((m) => m.id === id);
if (!model) { console.error(`verify-tee: ${id} is not on YIELD_TEE_MODELS`); process.exit(1); }
process.stdout.write(JSON.stringify(lib.adviceRequest(model, lib.adviceCandidates(YIELD_SAMPLE_REPORT))));
EOF
MODEL="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).model)' "$WORK/request.json")"
echo "verify-tee: model $MODEL"

# 2. The verifier, at the pinned commit, in its own venv.
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$VERIFIER_URL" "$DIR"
fi
git -C "$DIR" fetch --quiet origin
git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$VERIFIER_REF"
[ -x "$DIR/.venv/bin/python" ] || python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --quiet --disable-pip-version-check -r "$DIR/requirements.txt"

# 3. One call with our exact bytes, then the verifier's verify_chat on that call.
mkdir -p "$(dirname "$LOG")"
set +e
(cd "$DIR/py" && API_KEY="$NEAR_AI_API_KEY" "$DIR/.venv/bin/python" - "$WORK/request.json" "$MODEL" <<'EOF'
import asyncio, os, sys, requests
import chat_verifier  # reads API_KEY and BASE_URL at import
body = open(sys.argv[1], encoding="utf-8").read()
model = sys.argv[2]
r = requests.post(f"{chat_verifier.BASE_URL}/v1/chat/completions", data=body.encode("utf-8"), timeout=60,
                  headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['API_KEY']}"})
print("HTTP status:", r.status_code)
r.raise_for_status()
chat_id = r.json()["id"]
print("Chat id:", chat_id)
asyncio.run(chat_verifier.verify_chat(chat_id, body, r.text, "Key Doctor yield advice", model, False))
EOF
) 2>&1 | perl -pe 'BEGIN { $k = $ENV{NEAR_AI_API_KEY} } s/\Q$k\E/***/g' >"$LOG"
RUN_STATUS=${PIPESTATUS[0]}
set -e

# 4. Every check must print True, and nothing may print False.
REQUIRED=(
  "Request hash matches: True"
  "Response hash matches: True"
  "Signature valid: True"
  "Report data binds signing address: True"
  "Report data embeds request nonce: True"
  "GPU payload nonce matches request_nonce: True"
  "Intel TDX quote verified: True"
)
PASS=1
[ "$RUN_STATUS" -eq 0 ] || PASS=0
for line in "${REQUIRED[@]}"; do grep -qF "$line" "$LOG" || PASS=0; done
grep -qE ": False([^[:alnum:]]|$)" "$LOG" && PASS=0
VERDICT=$([ "$PASS" -eq 1 ] && echo "PASS" || echo "FAIL")

# 5. The doc block: the facts a judge needs to compare with a rerun, not the raw log.
pick() { grep -m1 -E "$1" "$LOG" | sed -E 's/^[[:space:]]+//' || true; }
{
  echo "<!-- run:start -->"
  echo "Last run: $(date -u +%Y-%m-%dT%H:%M:%SZ), model \`$MODEL\`, verifier \`${VERIFIER_REF:0:12}\`. Result: **$VERDICT**."
  echo
  echo '```text'
  for p in "^HTTP status:" "^Chat id:" "\"text\":" "\"signing_address\":" "\"signature_kind\":"; do pick "$p"; done
  for line in "${REQUIRED[@]}"; do pick "^[[:space:]]*${line%%:*}:"; done
  pick "^NVIDIA attestation verdict:"
  pick "^Intel TDX quote status:"
  echo '```'
  echo "<!-- run:end -->"
} >"$WORK/block.md"
python3 - "$DOC" "$WORK/block.md" <<'EOF'
import re, sys
doc, block = sys.argv[1], open(sys.argv[2], encoding="utf-8").read().strip()
s = open(doc, encoding="utf-8").read()
s, n = re.subn(r"<!-- run:start -->.*?<!-- run:end -->", lambda _: block, s, flags=re.S)
if n != 1: sys.exit("verify-tee: run markers not found in " + doc)
open(doc, "w", encoding="utf-8").write(s)
EOF

echo "verify-tee: $VERDICT (doc: docs/yield-tee-verify.md, full log: data/raw/yield-tee-verify.log)"
[ "$PASS" -eq 1 ]
