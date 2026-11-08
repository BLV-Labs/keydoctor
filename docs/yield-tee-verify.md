# Yield advice: TEE verification

The yield agent's one model call (yield plan §2, ADR 0004) goes to a Private TEE model on NEAR AI Cloud. This page shows how to check that claim yourself, on a request that is byte for byte what the Worker sends.

## What the script proves

`scripts/yield-setup/verify-tee.sh` builds the request with `adviceRequest` (the same builder `apps/worker/src/yield/agent.ts` uses) on the synthetic testnet report in `packages/key-doctor/scripts/yield-sample.ts`. It sends that request once, then runs `verify_chat` from NEAR AI's own verifier ([nearai-cloud-verifier](https://github.com/nearai/nearai-cloud-verifier), pinned to a commit in the script) on that call:

| Check | Line the verifier prints |
|---|---|
| Our request bytes are the ones that were signed | `Request hash matches: True` |
| The response bytes we got are the ones that were signed | `Response hash matches: True` |
| The signature recovers to the TEE signing address | `Signature valid: True` |
| That address is bound in the model's Intel TDX report data | `Report data binds signing address: True` |
| The attestation is fresh (our random nonce) | `Report data embeds request nonce: True` |
| The NVIDIA GPU attestation carries the same nonce | `GPU payload nonce matches request_nonce: True` |
| The Intel TDX quote verifies | `Intel TDX quote verified: True` |

The script exits 0 only if every line above prints `True` and no check prints `False`.

## Run it

Needs `git`, `python3` 3.10+, `node` 22.18+, network access, and a NEAR AI Cloud key from [cloud.near.ai](https://cloud.near.ai). One run costs one small chat call.

```bash
NEAR_AI_API_KEY=... scripts/yield-setup/verify-tee.sh
```

Pass a model id to check another model on `YIELD_TEE_MODELS` (the script refuses any other id). It rewrites the block below and keeps the full verifier output in `data/raw/yield-tee-verify.log`, which is gitignored because it holds the raw model text. If the signature lookup says `Chat id not found or expired`, the call hit another TEE node; run the script again.

## Last run

<!-- run:start -->
Not run yet. The owner runs it with the project key; the result replaces this line.
<!-- run:end -->

## Limits

- This proves the request went to an attested TEE model and the answer is the one it signed. It says nothing about whether the answer is good: that is `validateAdvice`'s job, and code still owns every number.
- The Worker keeps the generation id of each model answer (shown in the Telegram message) but not the raw bytes, so a past production call can be looked up at `/v1/signature/{id}` but not re-hashed. The script makes its own call for that reason.
