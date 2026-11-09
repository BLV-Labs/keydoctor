# Yield cross-chain feasibility

Date checked: 2026-11-04. Research only. No funds moved, nothing signed, no transaction sent.

Question: can a Sputnik DAO on NEAR farm a stablecoin on another chain (Aave v3, Compound v3, Morpho, Curve) when every move is a council vote and the agent never signs or executes?

Evidence tags: **V** verified (on-chain read, API response or source code read), **I** inferred (from docs or code, not run), **U** unknown.

Example DAO in this doc: `kdoncall.sputnik-v2.testnet`. No mainnet DAO or account name appears here.

## 1. Verdict

| Route | Verdict | Votes per round trip (steady state) | Main blocker |
|---|---|---|---|
| Aave v3 on Base, via Chain Signatures | Conditional go | 3 (+2 once: gas funding, USDC approval) | A DAO calling `sign` end to end was never run (U). Needs an off-chain relayer. Council signs a hash it cannot read |
| Compound v3 (USDC Comet) on Base, via Chain Signatures | Conditional go | 3 (+2 once) | Same as Aave |
| Morpho ERC-4626 vault on Base, direct | Conditional go | 3 (+2 once) | Same as Aave |
| Curve single-sided stable pool | No-go | 4 | Base stable pools hold about 0.25 M USD. Min-out slippage is fixed at sign time. Pool holds bridged coins that can depeg |

"Conditional go" means the mechanics exist in source and docs but one testnet spike (section 7) must pass first.

Roadmap line for `docs/stories/epics/yield/plan.md` §6 and Y15: cross-chain execution stays Roadmap; the next step is the Base Sepolia spike in section 7, then a decision on the Chain Signatures route (needs a relayer, 3 votes).

## 2. Chain Signatures from a DAO

| Question | Answer | Tag |
|---|---|---|
| Can a Sputnik `FunctionCall` proposal call `sign`? | Yes. `ActionCall{method_name, args, deposit, gas}` runs as a promise from the DAO account. Predecessor seen by the signer is the DAO. Contract accounts are named as supported ("NEAR accounts, including smart contracts") | V source, docs |
| Contract | Mainnet `v1.signer` v3.17.0, testnet `v1.signer-prod.testnet` v3.18.0 | V (`view`, tags) |
| Deposit | 1 yoctoNEAR (`sign` is payable). Taken from the DAO balance | V source at both tags |
| Gas | At least 15 Tgas attached to `sign` (config: sign 15, callback 7, `fail_on_timeout` 2). Attach more; I would use 30 Tgas | V config, I for 30 |
| Yield and resume | `sign` yields. An MPC node calls `respond`, the promise resolves with the signature. Timeout is 200 blocks (about 200 s) | V (`yield_timeout_length_in_blocks: 200` from mainnet protocol config; source) |
| Where the signature ends up | As the return value of the `v1.signer` receipt. Sputnik's `on_proposal_callback` only checks success or failure and ignores the value. Nothing stores it. A relayer must read it from the execution outcome of the vote transaction (or an indexer) and broadcast | V source, I for the live outcome shape |
| Retention risk | RPC nodes drop old receipts after about 5 epochs (epoch is 43,200 blocks, about 12 h) so the relayer must read within about 2 days | V epoch length, I for GC |
| Timeout or MPC failure | `fail_on_timeout` fails the promise. Sputnik sets the proposal `Failed`. `Finalize` can run it again while the proposal period is open | V source |
| Derived EVM address | keccak256 of the uncompressed secp256k1 key from `derived_public_key(path, predecessor, domain_id=0)`, last 20 bytes | V source, view works |
| Example addresses | `kdoncall.sputnik-v2.testnet`, path `base-1`: `0x95036b8bad870706a0618e51d3a2bf7d94ac135d`. Path `aave`: `0x5d4435788cdcfd1d1ab34bc1ab83c027be1b7e92`. These come from the testnet signer; mainnet has a different root key | V (view calls) |
| Stability | Same (DAO, path, domain) gives the same address as long as the MPC root key does not change. Resharing keeps the key. A new domain or a key rotation would change it | I |
| Council visibility | The payload is an opaque 32-byte hash. A voter sees bytes, not "supply 100 USDC to Aave". The proposal `description` must carry the unsigned tx fields and the hash, and the dashboard must recompute the hash from fields. Whoever can `AddProposal` can write a description that disagrees with the hash | V source, I for the mitigation |
| Who broadcasts | An off-chain relayer. It holds no key and can only send an already signed tx, but it is an extra component. The owner allowed it on 2026-11-04 (plan Y16). Who runs it is still open | Decided |

## 3. Staleness and gas

Facts about an EIP-1559 tx signed at proposal time and approved days later:

| Field | Effect over a multi-day vote | Workaround |
|---|---|---|
| Chain id | Fixed, no effect | None needed |
| Nonce | The real problem. Txs from one address must land in order. A rejected or expired proposal leaves a gap and blocks every later signed tx. Two open proposals must use n and n+1 and be approved in order | One open EVM-signing proposal at a time. After a gap, a new proposal must sign a replacement tx for the missing nonce |
| Max fee per gas | Base fee read 5,000,000 wei (0.005 gwei) now and 100,000 blocks (about 2.3 days) ago, and 8,965,440 wei on a later read the same day. A generous cap costs nothing: the sender pays base fee plus tip, not the cap | Set the cap far above the base fee. Balance must cover `gasLimit x maxFee` at inclusion |
| Gas limit | A tx that would run out of gas fails after the vote | Pad the estimate |
| Min-out slippage | Fixed at hash time. Matters for Curve, not for Aave, Compound, Morpho deposits (1:1 asset deposits) | Avoid swaps |
| Pool state | Aave supply cap or a pause can change between hash and inclusion. Reserve now: active, not frozen, not paused, cap 230 M USDC against about 192 M aUSDC outstanding | Check at execution time; revert wastes the vote |

All measurements are V (Base RPC, `eth_getBlockByNumber`, `getReserveData`).

Who pays EVM gas: the derived address, in ETH on Base. How that ETH gets there is U.
- One tx at about 250,000 gas and 0.006 gwei costs about 1.5e-6 ETH plus the L1 data fee. L1 data fee not measured (U). 0.002 ETH should cover many txs (I).

## 4. Money in and out

- How USDC moves from the DAO on NEAR to the derived address on Base and back is U: no bridge is chosen.
- Out: Aave `withdraw(asset, amount, to)`, Comet `withdrawTo(to, asset, amount)` and ERC-4626 `redeem(shares, receiver, owner)` all take a receiver, so the exit can pay a bridge address in 1 signature, not 2 (I).

## 5. Per protocol

Chain: **Base** (chain id 8453). Reasons: base fee under 0.01 gwei (V), native Circle USDC, all four protocols have deployments.

All three lend or vault routes need the same extra steps from the derived EOA: `approve(spender, amount)` on Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), once if the approval is unlimited. Unlimited approval to the protocol contract is a trade-off, not a recommendation.

Round trip counts steady state (approval already done, gas funded): in-bridge 1, deposit 1, withdraw to the bridge deposit address 1.

### Aave v3 (Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`, proxy)

- Deposit: `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`. Withdraw: `withdraw(address asset, uint256 amount, address to)`. Selectors present in the implementation `0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb` (V).
- `supplyWithPermit(...)` also exists (V). Base USDC implementation `0x2ce6311ddae708829bc0784c967b7d77d19fd779` has `permit`, `transferWithAuthorization` (V). Permit removes the approve tx and nonce, but the permit digest still needs its own `sign` call, so votes do not drop (I). Whether two `sign` actions in one proposal both resolve is U.
- Reserve USDC: active, not frozen, not paused. `liquidityRate` 5.31 % (APR, V read now). aUSDC `0x4e65fe4dba92790696d040ac24aa414708f5c0ab`.
- Access: no allowlist function seen in the Pool; I did not run a supply from a contract-controlled key (U for sanctions-style front-end limits, which apply to UIs, not the contract).
- Votes: 3 steady, 5 first time.

### Compound v3 (USDC Comet `0xb125E6687d4313864e53df431d5425969c15Eb2F`, proxy)

- Deposit: `supply(address asset, uint256 amount)`. Withdraw: `withdraw(address asset, uint256 amount)` or `withdrawTo(address to, address asset, uint256 amount)`. `supply`, `supplyTo`, `withdraw`, `withdrawTo` selectors present in implementation `0xc1455ae6df6cd808ed677f048e434e22892682a7` (V). `allowBySig` selector not found by my check (U, not needed).
- Comet name "Compound USDC", base token Base USDC, supply and withdraw not paused (V). Supply rate 3.22 % APR from `getSupplyRate(getUtilization())` (V read now).
- Withdraw of the base asset can fail when utilisation is high and cash is short (I). Utilisation 88 to 90 % across two reads on 2026-11-04 (V).
- Votes: 3 steady, 5 first time.

### Morpho (ERC-4626 vaults)

- Deposit: `deposit(uint256 assets, address receiver)`. Withdraw: `redeem(uint256 shares, address receiver, address owner)` or `withdraw(uint256 assets, address receiver, address owner)`. Present in both vaults checked (V).
- Vaults: Gauntlet USDC Prime `0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61` (`totalAssets` about 401.9 M USDC, V), Spark USDC Vault `0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a` (about 495.2 M USDC, V). Both have `asset()` = Base USDC (V). `maxDeposit` for an arbitrary address is large, so no allowlist for deposits (V).
- Share price rises over time (Gauntlet `previewRedeem(1e18)` = 1.1184 USDC, V). Yield is not a fixed rate (I).
- Direct route: 3 votes steady, 5 first time.

### Curve

- Single-sided: `add_liquidity([amount,0,0,0], min_mint)` then `remove_liquidity_one_coin(token_amount, i, min_received)`. Older pools send the output to `msg.sender`, so the exit needs one more transfer: 4 votes steady (I).
- Base: biggest USDC stable pool is "4pool" `0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f` with USDC, USDbC, axlUSDC and crvUSD. Balances read now: USDC 57,404, USDbC 59,142, axlUSDC 58,961, crvUSD 78,800 (units of each coin). TVL about 0.25 M USD (V, Curve API and `balances()`).
- Depeg risk: USDbC and axlUSDC are bridged tokens. A single-sided deposit of USDC is exposed to them and to crvUSD. Min-out is fixed at signing, so a multi-day vote can make the tx revert (I).
- Ethereum has deep pools (DAI/USDC/USDT about 161 M, RLUSD/USDC about 39 M, V) but gas is higher (not measured) and the pools mix stable coins that can depeg.
- Verdict: no-go for v1.

## 6. Alternatives without an EVM address

- **Rhea cross-chain SDK (`@rhea-finance/cross-chain-sdk`):** read the source. It lets a user on EVM, Solana or Bitcoin lend into Rhea on NEAR through a multi-chain account created with a wallet message signature (`prepare_sign_message_evm`). That is the opposite direction (other chain into NEAR) and needs a wallet signature. It does not give a DAO yield on another chain. NEAR is listed as a supported chain in the README; contract-account support is U. V source read.
- **NEAR-side vault that already bridges:** none found. NEAR-side stablecoin yield today is Rhea Lend and Burrow on NEAR (already in the plan, Y2). No repo in the Rhea org (`gh repo list`) holds a vault that bridges to Aave, Compound, Morpho or Curve.

## 7. Open questions and the smallest testnet spike

No mainnet funds are needed. A testnet MPC signature is a normal secp256k1 signature, so it is valid on Base Sepolia (chain id 84532).

Base Sepolia contracts exist (V, `eth_call`): Aave Pool `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` (answers `ADDRESSES_PROVIDER`), Compound USDC Comet `0x571621Ce60Cebb0c1D442B5afb38B1663C6Bf017` (name "Compound USDC", base token `0x036cbd53842c5426634e7929541ec2318f3dcf7e`, Circle test USDC).

Spike (owner signs the NEAR side; Claude builds the unsigned txs and proposals):
1. Pick a testnet DAO (for example `kdoncall.sputnik-v2.testnet`). Read `derived_public_key` for path `aave` and compute the Base Sepolia address.
2. Fund that address with Base Sepolia ETH (faucet) and Circle test USDC (faucet).
3. Build an unsigned EIP-1559 `approve` tx (nonce n) with a generous `maxFeePerGas`. Put fields and hash in the proposal description. Proposal: `FunctionCall` to `v1.signer-prod.testnet`, method `sign`, args `{request:{path:"aave",payload_v2:{Ecdsa:<hash hex>},domain_id:0}}` (field names from `SignRequestArgs`, V; the `request` wrapper and hex format to confirm in the spike), deposit `1`, gas 30 Tgas.
4. Vote it through. Read the signature from the execution outcome of the `v1.signer-prod.testnet` receipt. Assemble the signed tx and broadcast it to Base Sepolia. Pass condition: the tx is mined and `allowance` is set.
5. Repeat for `supply` (nonce n+1) on the Comet. Then `withdrawTo` a second address. Pass condition: USDC arrives.
6. Record in a spike note: tx hashes, proposal ids, gas used by the vote, the shape of the outcome that holds the signature.

Open questions:

| # | Question | How to close |
|---|---|---|
| 1 | Does the DAO-called `sign` return the signature in the receipt outcome as the source says? | Spike step 4 |
| 2 | Is default wallet gas on `VoteApprove` enough for `sign` (15 Tgas) plus the 10 Tgas callback? | Spike step 4 |
| 3 | Do two `sign` actions in one proposal both resolve? (would cut votes) | Extra spike proposal |
| 4 | L1 data fee per Base tx | One Base Sepolia tx |
| 5 | Who runs the relayer? (Allowed by plan Y16) | Owner |
| 6 | Retention of the `sign` outcome on public RPC | Spike, read again after 2 days |

## 8. Sources

Checked 2026-11-04.

- Sputnik DAO v2 source: `sputnikdao2/src/proposals.rs`, `policy.rs`, `types.rs` (github.com/near-daos/sputnik-dao-contract). V read.
- NEAR MPC contract source at tags 3.17.0 and 3.18.0: `crates/contract/src/api/sign.rs`, `common.rs`, `keys.rs`, `near-mpc-contract-interface/src/deposits.rs`, `types/config.rs`, `near-mpc-crypto-types/src/kdf.rs` (github.com/Near-One/mpc). V read.
- Chain Signatures docs: https://docs.near.org/chain-abstraction/chain-signatures
- Yield and resume docs (200 block timeout): https://docs.near.org/smart-contracts/anatomy/yield-resume
- NEAR mainnet RPC `EXPERIMENTAL_protocol_config` (`yield_timeout_length_in_blocks`, epoch length), views on `v1.signer` and `v1.signer-prod.testnet`.
- Base RPC https://mainnet.base.org and https://sepolia.base.org (`eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getBlockByNumber`)
- Curve API https://api.curve.finance/v1/getPools/all/base and `/ethereum`
- Rhea: https://github.com/rhea-finance/cross-chain-sdk, `crosschain-sdk`, `lending-near-intents-solver-golang`
- Repo context: `docs/stories/epics/yield/plan.md`, `docs/decisions/0004-llm-in-yield-agent.md`, `apps/dashboard/src/guard-proposals.ts`
