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
| Morpho vault share through 1Click Earn (`gtUSDCp`) | Conditional go | 2 | Only 1 of 5 USDC receipt tokens quoted. Real deposit versus solver fill is U. No Intents testnet (Q-007) |
| Curve single-sided stable pool | No-go | 4 | Base stable pools hold about 0.25 M USD. Min-out slippage is fixed at sign time. Pool holds bridged coins that can depeg |

"Conditional go" means the mechanics exist in source and docs but one testnet spike (section 7) must pass first.

Roadmap line for `docs/stories/epics/yield/plan.md` §6 and Y15: cross-chain execution stays Roadmap; the next step is the Base Sepolia spike in section 7, then a decision between the Chain Signatures route (needs a relayer, 3 votes) and the Earn route (2 votes, one vault today).

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

Who pays EVM gas: the derived address, in ETH on Base. Fund it through 1Click.
- Dry quote NEAR USDC to Base ETH, recipient the derived address (lowercase): 5 USDC in gives 0.002237 ETH out (4.9977 USD), 20 USDC gives 0.008944 ETH. Fixed `withdrawFee` 560000000000 wei. About 24 s. V (dry quote, 201).
- One tx at about 250,000 gas and 0.006 gwei costs about 1.5e-6 ETH plus the L1 data fee. L1 data fee not measured (U). 0.002 ETH should cover many txs (I).

## 4. Money in and out (1Click)

What was checked: `POST /v0/quote` with `dry: true`, 2026-11-04. Five quotes were non-dry (deposit addresses created, nothing sent).

**Fees and speed, NEAR native USDC to Base USDC (V, dry):**

| Amount in | Amount out | Notes |
|---|---|---|
| 100 USDC | 99.9784 | 22 s, fee about 0.0024 USDC |
| 1,000 | 999.7956 | |
| 10,000 | 9,997.9777 | |

- Base to NEAR, 100 USDC in: 99.9845 out (V).
- Same trip to Arbitrum `withdrawFee` 5300 units, to Ethereum 300000 units = 0.30 USDC (V).

**The NEAR to Base 400 `Internal server error` (V, A/B tested):**
- Cause: `refundTo` (and the same for `recipient` on the NEAR side) was a NEAR named account that does not exist on mainnet, such as a testnet DAO name or a made-up `.near` name.
- Fix: use an existing account or a 64-hex implicit account. Same request then returns 201. Existence was the only variable that changed.
- Other 400s: `recipient is not valid` for mixed-case EVM addresses with a wrong EIP-55 checksum, and for `0x...dEaD`. All-lowercase addresses pass.
- Consequence for the product: the mainnet flow needs the mainnet DAO name to exist, which it does; testnet names cannot be used against 1Click (matches Q-007).

**Deposit address and deadline:**
- Minimum deadline is about 3 days (a 1 h request returned about 72 h). 7, 8 and 30 days were accepted (V). A 7-day proposal period fits if the quote is created with a deadline past vote end plus execution time.
- NEAR-side deposit addresses are implicit accounts that are not registered on the USDC token contract. The proposal needs `storage_deposit` (0.00125 NEAR) then `ft_transfer` as two actions to the token contract (I, from the FT storage standard).
- Several actions to the same receiver fit one proposal (V: `actions` is a list). So gas funding plus USDC in can be one proposal with four actions (I).

**Round trip legs:**
- In: DAO sends NEAR USDC to a NEAR deposit address. Quote recipient is the derived EVM address on Base. 1 vote.
- Out: the final EVM tx can send straight to a Base deposit address. Aave `withdraw(asset, amount, to)`, Comet `withdrawTo(to, asset, amount)` and ERC-4626 `redeem(shares, receiver, owner)` all take a receiver, so the exit is 1 signature, not 2. The deposit address and exact amount must be fixed when the proposal is created (I; behaviour of a deposit that differs from the quoted amount is U).

## 5. Per protocol

Chain: **Base** (chain id 8453). Reasons: base fee under 0.01 gwei (V), native Circle USDC, all four protocols have deployments, 1Click lists Base USDC and Base ETH (V `/tokens`).

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
- **Earn route (no EVM address):** see section 6.

### Curve

- Single-sided: `add_liquidity([amount,0,0,0], min_mint)` then `remove_liquidity_one_coin(token_amount, i, min_received)`. Older pools send the output to `msg.sender`, so the exit needs one more transfer: 4 votes steady (I).
- Base: biggest USDC stable pool is "4pool" `0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f` with USDC, USDbC, axlUSDC and crvUSD. Balances read now: USDC 57,404, USDbC 59,142, axlUSDC 58,961, crvUSD 78,800 (units of each coin). TVL about 0.25 M USD (V, Curve API and `balances()`).
- Depeg risk: USDbC and axlUSDC are bridged tokens. A single-sided deposit of USDC is exposed to them and to crvUSD. Min-out is fixed at signing, so a multi-day vote can make the tx revert (I).
- Ethereum has deep pools (DAI/USDC/USDT about 161 M, RLUSD/USDC about 39 M, V) but gas is higher (not measured) and the pools mix stable coins that can depeg.
- Verdict: no-go for v1.

## 6. Alternatives without an EVM address

- **1Click Earn (exists, V):** receipt tokens for vault shares move through the normal quote flow. Docs: "NEAR Intents does not run these yield protocols ... or guarantee principal."
  - Quotes on 2026-11-04, 100 USDC in, NEAR native USDC to receipt token, delivery to an Intents balance of an implicit account:

    | Token | Result |
    |---|---|
    | `gtUSDCp` (Base, wraps Gauntlet USDC Prime) | 201. Output worth 99.49 USD, `timeEstimate` 35 s |
    | `TLO` (Ethereum, 8 decimals, not identified) | 201. Output worth 99.74 USD, 20 s |
    | `sparkUSDC`, `mwUSDC`, `steakUSDC`, `laUSDC` | 400 `No liquidity available` |

  - Redeem quotes (about 100 USD of shares, shares held in Intents): `gtUSDCp` to NEAR USDC gives 99.59 USDC (25 s). To Intents gives 99.60. `TLO` gives 99.79 (10 s). All V (dry).
  - Round trip at 100 USDC for `gtUSDCp`: about 0.5 % lost on entry and about 0.45 % on exit, so about 0.95 % total (V, computed from the quotes). The fee split between 1Click and spread is U. Behaviour at other sizes is U.
  - Token mapping: the NEAR-branded `near-gtUSDCp`, `near-sparkUSDC`, `near-mwUSDC` wrap real Morpho vaults on Base (V: each wrapper points at a vault whose `asset()` is Base USDC). The 1Click price per token tracks the vault share price within about 0.2 % but the unit scale differs by 1e6, so the wrapper is not a plain 1:1 share (V). What the solver does on a deposit (real deposit or inventory fill) is U.
  - Votes: in = `storage_deposit` + `ft_transfer` to a NEAR deposit address (1 vote). Out = shares sit in the DAO's Intents balance, so the DAO calls `intents.near` `mt_transfer` (1 yocto) to the INTENTS deposit address of the redeem quote, or `mt_withdraw` to leave Intents (1 vote). `intents.near` exports `mt_transfer`, `mt_transfer_call`, `mt_withdraw`, `ft_withdraw` and asserts 1 yocto (V, wasm strings). Calling these from a DAO was not run (U). Total 2 votes, no EVM address, no gas token, no relayer, no staleness. Quotes expire like other 1Click quotes (deadline min about 3 days, V).
  - Limits: quotes were unauthenticated dry quotes. HACKATHON Q-006 notes a JWT and a 0.2 % fee tier; the effect on these numbers is U. No Intents testnet (Q-007), so this route cannot be tested end to end with test tokens.
  - Terms: the 1Click ToS excludes Restricted Persons and Jurisdictions and screens transactions (sections on sanctions and KYT). Whether a DAO account is screened differently is U.
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
| 4 | Does a 1Click deposit that differs from the quoted amount refund or fail? | Non-dry quote with test amount owner approves |
| 5 | Is a 1Click Earn deposit a real vault deposit? Why do 4 of 5 receipt tokens return no liquidity? | Ask 1Click, or one small real Earn deposit (owner decision on funds) |
| 6 | Can a DAO call `intents.near` `mt_transfer` and `mt_withdraw` as predecessor with 1 yocto? | Small mainnet test, owner decision |
| 7 | L1 data fee per Base tx | One Base Sepolia tx |
| 8 | Who runs the relayer? (Allowed by plan Y16) | Owner |
| 9 | Retention of the `sign` outcome on public RPC | Spike, read again after 2 days |

## 8. Sources

Checked 2026-11-04.

- Sputnik DAO v2 source: `sputnikdao2/src/proposals.rs`, `policy.rs`, `types.rs` (github.com/near-daos/sputnik-dao-contract). V read.
- NEAR MPC contract source at tags 3.17.0 and 3.18.0: `crates/contract/src/api/sign.rs`, `common.rs`, `keys.rs`, `near-mpc-contract-interface/src/deposits.rs`, `types/config.rs`, `near-mpc-crypto-types/src/kdf.rs` (github.com/Near-One/mpc). V read.
- Chain Signatures docs: https://docs.near.org/chain-abstraction/chain-signatures
- Yield and resume docs (200 block timeout): https://docs.near.org/smart-contracts/anatomy/yield-resume
- NEAR mainnet RPC `EXPERIMENTAL_protocol_config` (`yield_timeout_length_in_blocks`, epoch length), `view_code` of `intents.near`, views on `v1.signer` and `v1.signer-prod.testnet`.
- 1Click API: https://1click.chaindefuser.com/v0 (`/tokens`, `/quote`), OpenAPI and Earn doc at https://docs.near-intents.org/integration/distribution-channels/1click-api/ (Earn page), ToS https://docs.near-intents.org/security-compliance/terms-of-service
- Base RPC https://mainnet.base.org and https://sepolia.base.org (`eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getBlockByNumber`)
- Curve API https://api.curve.finance/v1/getPools/all/base and `/ethereum`
- Rhea: https://github.com/rhea-finance/cross-chain-sdk, `crosschain-sdk`, `lending-near-intents-solver-golang`
- Repo context: `docs/stories/epics/yield/plan.md`, `docs/decisions/0004-llm-in-yield-agent.md`, `apps/dashboard/src/guard-proposals.ts`, `HACKATHON.md` (Q-006, Q-007)
