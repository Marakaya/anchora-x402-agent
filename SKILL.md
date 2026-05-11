---
name: anchora-x402-agent
description: Use when an agent needs to fetch Anchora RWA score, proof-package, by-mint lookup, or attestation verification data through the x402 pay-per-call API. Covers catalog discovery, local agent-wallet creation, quote validation, bounded signer usage via ANCHORA_X402_AGENT_WALLET, ANCHORA_X402_SIGNER_URL/TOKEN, or ANCHORA_X402_SIGNER_CMD, safe real USDC payment retries, and response interpretation. Never request raw Solana private keys, seed phrases, or keypair files.
---

# Anchora x402 Agent

Anchora sells machine-readable trust for real-world assets. Use the x402 rail when the user wants an autonomous agent to pay per request in Solana USDC and return verified asset data.

Current production-facing settlement is server-side and declared in `/api/x402/v1/catalog`. Anchora may use Coinbase CDP or `direct-solana` proof mode. The agent does not need a Coinbase account and does not call a facilitator directly: it checks `settlement.ready`, calls Anchora, receives a 402 quote, signs a Solana USDC payment through a bounded signer, retries Anchora with `X-PAYMENT`, and Anchora verifies/settles server-side.

For hackathon or judge testing, use devnet only. Mainnet x402 settlement has a historical proof transaction, but public hands-on testing should fund only devnet SOL and devnet test USDC declared by `/catalog`.

## Safety Rules

- Never ask the user to paste an existing Solana private key, seed phrase, or keypair JSON into chat.
- If the agent has shell access, do not ask the user to run terminal commands. Run setup, catalog, wallet, balance, dry-run, and payment commands yourself, then report concise results.
- Ask the user only for inputs that cannot be automated: asset contract/PDA address, funding the printed public key, and payment authorization if they have not already authorized the local wallet policy.
- If using the local agent wallet, generate a dedicated tiny-balance wallet through `npm run x402:wallet`; do not print its secret and do not commit `.anchora/`.
- Use a bounded signer capability:
  - local repo wallet: `npm run x402:wallet` plus `--agent-wallet <name>`, or
  - `ANCHORA_X402_SIGNER_URL` plus `ANCHORA_X402_SIGNER_TOKEN`, or
  - `ANCHORA_X402_SIGNER_CMD`.
- Treat signer tokens as secrets. Do not print them.
- Before real payment, show the user or runtime policy the amount, token mint, recipient, resource URL, and network.
- Before real payment, fetch `/catalog` and continue only when `settlement.ready` is `true`.
- If the user explicitly authorized a local wallet policy, and the quote matches that policy, treat the policy as approval for payments inside its caps. Otherwise ask before `--execute-payment`.
- Refuse payment if the quote differs from local policy.

## Command Workspace

The runnable helper commands live in the public helper repo:

```text
https://github.com/Marakaya/anchora-x402-agent
```

Use this public helper repo as the canonical command workspace. Do not require access to the private Anchora app repository for x402 setup, wallet creation, quote validation, or payment retries.

For browser-based judge/developer review, the live app also exposes `/developer/playground`, `/developer/logs`, `/developer/receipts`, `/developer/errors`, and `/developer/agent-skill` under `https://app.anchora.markets`.

If the current workspace is not that repo:

1. Obtain the public helper repo as a local command workspace. Git is optional:
   - if `git` exists, use a shallow clone from `https://github.com/Marakaya/anchora-x402-agent`
   - if `git` is missing but `npm` exists, use a GitHub-archive downloader such as `npm exec --yes degit@latest -- Marakaya/anchora-x402-agent <workspace>`
   - if needed, download `https://codeload.github.com/Marakaya/anchora-x402-agent/tar.gz/refs/heads/main` and extract it into a workspace
2. Run commands from that workspace root.
3. Install Node dependencies before wallet or payment commands:

```bash
npm ci
```

Node/npm is required for the local wallet helper. If dependency install is unavailable, read `/api/x402/v1/catalog` and explain the flow, but do not claim that local wallet payment has been tested.

If shell access or a local Node/npm runtime is unavailable, tell the user the current agent cannot complete the autonomous wallet flow and should be run in an agent environment with shell and Node/npm access.

## Canonical Endpoints

Base URL: `https://anchora.markets/api/x402/v1`

- Catalog: `GET /catalog` (free)
- Quote: `GET /quote?route=proof-package&asset_address={asset_address}&policy=collateral_screening` (free, returns payment requirements as `200 JSON`)
- Proof package: `GET /assets/{asset_address}/proof-package?policy=collateral_screening`
- Score: `GET /assets/{asset_address}/score`
- By mint: `GET /assets/by-mint/{mint}`
- Verify attestation: `GET /verify/{tx_signature}`

Use the asset contract/PDA address in `{asset_address}`. Do not use a display name such as `KZ-ALMATY-JUDGE-001` when the contract/PDA address is available.

## Payment Policy

Accept only quotes with:

- `scheme: "exact"`
- `network` equal to the live `GET /catalog` settlement network (`solana-devnet` for current judge/devnet testing)
- `asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"` (current public Solana Devnet USDC; always trust `GET /catalog`)
- `payTo: "DtWRumAEkL4AHfSwphuHf2RTmC2zJ9qP2wmGjtq4FxLP"` (current public settlement wallet; always trust `GET /catalog`)
- `resource` on `https://anchora.markets/api/x402/v1/*`
- `maxAmountRequired` at or below the user's configured cap

Recommended default user policy for a local agent wallet:

- per request cap: `300000` USDC atoms (`0.30 USDC`)
- daily cap: `1000000` USDC atoms (`1 USDC`)

Agent proof snapshot currently costs `300000` USDC atoms (`0.30 USDC`).

## Local Agent Wallet

If the user wants the agent to handle x402 payment without visiting the Anchora app, use the repo wallet CLI. It creates a small local wallet under ignored `.anchora/agent-wallets/`, prints only the public key, and enforces Anchora-only policy before signing.

Start with free discovery:

```bash
npm run x402:agent -- --route catalog
```

Create the wallet:

```bash
npm run x402:wallet -- create --wallet default --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

If `.anchora/agent-wallets` is not writable, choose a writable temp directory and reuse it on later wallet commands:

```bash
wallet_dir="$(mktemp -d)"
npm run x402:wallet -- create --wallet default --wallet-dir "$wallet_dir" --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

Tell the user to fund the printed public key with:

```text
1 devnet test USDC + 0.01 devnet SOL
```

Check funds:

```bash
npm run x402:wallet -- balance --wallet default
```

Pay with that wallet:

```bash
npm run x402:agent -- --asset-address <asset_pda> --agent-wallet default --execute-payment --print-body --json
```

The wallet refuses quotes outside `https://anchora.markets/api/x402/v1/*`, wrong USDC mint, wrong recipient, over-cap amounts, over daily cap, or missing `payment-identifier`.

Never parse the `402` challenge and assemble `X-PAYMENT` manually. The helper constructs the header. In bridge fallback mode, forward the helper-produced header verbatim exactly once; do not edit, mutate, or reuse it across attempts.

### No-direct-network fallback

If the shell can run Node and access the local wallet file but cannot resolve `anchora.markets` or `api.devnet.solana.com`, do not switch to a bridge payment wallet. Use the agent's HTTP bridge only as transport:

1. Fetch `/catalog` through the bridge.
2. Fetch `/quote` through the bridge and save the `200` JSON body as `quote.json`. Example:

```text
GET https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=<asset_pda>&policy=collateral_screening
```

3. If `/quote` works, do not fetch the protected route without `X-PAYMENT`. Some bridges intercept HTTP `402` and swallow the quote body.
4. If `/quote` is unavailable, fetch the protected route without `X-PAYMENT` through a transparent HTTP client only, then save the `402` JSON body as `quote.json`.
5. Build an offline context plan:

```bash
npm run x402:agent -- --offline-context-plan --quote-file quote.json --asset-address <asset_pda> --agent-wallet default
```

6. Save the returned `signerRequest` as `signer-request.json`.
7. Run:

```bash
npm run x402:wallet -- context-plan --wallet default < signer-request.json
```

8. Prefer the returned `fetchContextWithBridge.url`. Fetch that one URL through the bridge immediately before signing and save the response as `solana-context.json`.

If your environment cannot use the one-call context URL, fetch every `fetchWithBridge[].url` through the bridge instead. Fetch `latestBlockhash` last, immediately before signing. Save `solana-context.json` as:

```json
{
  "latestBlockhash": { "...": "paste latestBlockhash response object" },
  "accounts": {
    "<account-address>": { "...": "paste non-null account response object" }
  }
}
```

9. Sign locally with the same `paymentIdentifier` from the offline context plan:

```bash
npm run x402:agent -- --offline-sign --quote-file quote.json --solana-context-file solana-context.json --asset-address <asset_pda> --agent-wallet default --payment-identifier <same_payment_identifier>
```

10. Retry the exact target URL through the bridge with the returned `X-PAYMENT` header. Forward it verbatim; do not parse, edit, or rebuild it.

This keeps the dedicated Anchora wallet as payer. The bridge transports HTTP/RPC data only; it must not create or fund the payment.

Do not run a separate facilitator pre-verify in restricted bridge mode. It can consume enough time for the blockhash to expire. Retry only when the paid retry returns a structured pre-send error such as `blockhash_expired` with `phase: "verify"` or `phase: "build"` and `retryable: true`. If the response is `settlement_pending` with `checkTransaction`, do not re-sign or repay; check server status first:

```bash
npm run x402:agent -- --check-payment <payment_identifier>
```

### Bridge intercepts HTTP 402

Some agent runtimes and payment bridges treat HTTP `402` as a protocol-level signal and may try to pay it from a bridge wallet. If you see `402 Payment Required but no recognized protocol`, use `/quote` for discovery instead of trying to read the protected-route challenge:

```text
GET /api/x402/v1/quote?route=proof-package&asset_address=<asset_pda>&policy=collateral_screening
```

Then sign locally with the dedicated Anchora wallet and retry the protected route with the helper-produced `X-PAYMENT` header. Do not pay with the bridge wallet.

## Helper Runner

When operating inside the public helper repo, prefer the bundled runner:

```bash
npm run x402:agent -- --route catalog
npm run x402:agent -- --asset-address <asset_pda>
npm run x402:agent -- --check-payment <payment_identifier>
```

The first command reads the free machine-readable catalog. The second validates the paid quote and stops before payment. To execute a real signer-backed payment after authorization:

```bash
npm run x402:agent -- --asset-address <asset_pda> --agent-wallet default --execute-payment --print-body --json
```

Useful environment:

```bash
ANCHORA_X402_SIGNER_URL=https://wallet.example.com/v1/x402/sign
ANCHORA_X402_SIGNER_TOKEN=replace-with-bounded-signer-token
ANCHORA_X402_AGENT_WALLET=default
ANCHORA_X402_ASSET_ADDRESS=<asset_pda>
ANCHORA_X402_POLICY=collateral_screening
ANCHORA_X402_MAX_ATOMIC_AMOUNT=300000
```

If available, read `docs/runbooks/x402-agent-signer.md` for the full signer contract.

## Manual Flow

1. Fetch `/catalog` for available routes, prices, and settlement status.
2. Stop if `settlement.ready` is not `true`; report `settlement.detail`.
3. Prefer `GET /quote?...` to receive `accepts[0]` as `200 JSON`.
4. If `/quote` is unavailable and your HTTP client is transparent to `402`, call the target route without `X-PAYMENT`.
5. Validate quote against the payment policy, including the live catalog `network`.
6. Generate a fresh `payment-identifier` extension id.
7. Ask the signer to create an `X-PAYMENT` header.
8. Retry the exact same URL with `X-PAYMENT`.
9. Return the JSON body and preserve `X-PAYMENT-RESPONSE.transaction` as the settlement receipt.
10. If `X-PAYMENT-RESPONSE` shows `cached: true`, tell the user this was an idempotent retry, not a new charge.

Known-compatible CLI smoke:

```bash
npm exec --yes --package=@solana/pay -- pay --verbose curl https://anchora.markets/api/x402/v1/assets/2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX/proof-package
```

## Response Guidance

For proof-package responses, cite:

- asset id / asset address
- confidence score or trust score
- policy profile
- `decisionSummary.automationReadiness`
- `decisionSummary.recommendedAction`
- risk warnings/blockers
- `integrity.signature.status`
- settlement tx from `X-PAYMENT-RESPONSE`

For the default demo asset, `decisionSummary.automationReadiness: "blocked"` with `decisionSummary.recommendedAction: "route_to_manual_review"` is expected. The sample asset intentionally uses several attestor wallets under one demo company so reviewers can test the full lifecycle quickly. Explain this as concentration-risk detection working correctly, not as payment or proof-package failure.

If Anchora returns `400`, fix input and do not pay again. If it returns `409`, reuse or refresh the payment identifier according to the error. If it returns `402` after a paid retry, report payment verification or settlement failure instead of guessing.

## User-Facing Script

When explaining this to a normal user, keep it short:

1. "I will create a tiny dedicated Solana wallet for Anchora x402 payments."
2. "You fund this public address with about `1 devnet test USDC` and `0.01 devnet SOL`; do not send your main wallet secret."
3. "The wallet can only pay `anchora.markets`, only in Solana USDC, only to Anchora's recipient, and only up to the configured caps."
4. "I will install the helper repo and run all setup/payment commands myself."
5. "I will first validate the quote, then execute the payment only if it matches policy."
