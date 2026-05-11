# Anchora x402 Agent Helper

Standalone helper for AI agents that need to buy Anchora RWA trust data through x402 on Solana USDC.

This repository is intentionally public and minimal. It contains only the agent payment helper, local bounded-wallet signer, installable skill instructions, public defaults, and tests. It does not contain Anchora app source code, judge passwords, API keys, seed phrases, private keypairs, or production secrets.

Use this repository as the canonical command workspace for agent-side x402 testing. Agents and judges do not need access to the private Anchora app repository.

## Version Guard

Before executing payments, refresh this helper workspace or skill from the public repo and use version `0.4.0` or newer:

```bash
git pull --ff-only
npm ci
node -p "require('./package.json').version"
```

Older copies may fetch the protected route directly or try to redeem before settlement in bridges that intercept HTTP `402`. The current flow uses `/api/x402/v1/quote` first and includes a bridge-safe facilitator-settle path.

## What This Does

- Reads the free Anchora x402 catalog.
- Requests a bridge-safe `200 JSON` quote from Anchora.
- Validates the quote against a local policy.
- Creates a dedicated low-balance Solana agent wallet.
- Signs a Solana USDC payment only when the quote matches policy.
- Retries the same Anchora URL with `X-PAYMENT` in transparent HTTP clients.
- Emits a `facilitatorSettle` request for bridges that intercept HTTP `402`.
- Returns the proof-package response and settlement transaction.

Current public judge/testing contour:

| Field | Value |
|---|---|
| Site | `https://anchora.markets` |
| Network | `solana-devnet` |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| x402 recipient | `DtWRumAEkL4AHfSwphuHf2RTmC2zJ9qP2wmGjtq4FxLP` |
| Demo asset PDA | `2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX` |
| Proof snapshot price | `0.30 test USDC` |

Always prefer the live catalog as source of truth:

```bash
npm run catalog
```

Bridge-safe quote endpoint:

```bash
curl -fsS 'https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX&policy=collateral_screening'
```

## Quick Start

```bash
git clone https://github.com/Marakaya/anchora-x402-agent
cd anchora-x402-agent
npm ci
npm run catalog
```

No Git available:

```bash
tmp_dir="$(mktemp -d)"
curl -fsSL https://codeload.github.com/Marakaya/anchora-x402-agent/tar.gz/refs/heads/main \
  | tar -xz --strip-components=1 -C "$tmp_dir"
cd "$tmp_dir"
npm ci
npm run catalog
```

## Fast pay.sh Smoke

If your environment supports `@solana/pay`, this command exercises the pay.sh x402 path against the live devnet proof-package route:

```bash
npx -y @solana/pay --verbose curl https://anchora.markets/api/x402/v1/assets/2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX/proof-package
```

## Bounded Agent Wallet Flow

Create a dedicated wallet:

```bash
npm run x402:wallet -- create --wallet default --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

If the current workspace is read-only, create the wallet in a writable temp directory and reuse that directory on later wallet commands:

```bash
wallet_dir="$(mktemp -d)"
npm run x402:wallet -- create --wallet default --wallet-dir "$wallet_dir" --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

Show the printed public key to the user. The user should fund only that public key with:

```text
1 devnet test USDC + 0.01 devnet SOL
```

Devnet faucets:

- SOL: <https://faucet.solana.com/>
- USDC: <https://faucet.circle.com/>

Check balance:

```bash
npm run x402:wallet -- balance --wallet default
```

Preferred single-call payment command after the user has authorized the local policy:

```bash
npm run x402:agent -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --execute-payment \
  --print-body \
  --json
```

The helper validates the quote before signing. This single-call form avoids slow multi-step agent reasoning loops.

Validate the quote without payment:

```bash
npm run x402:agent -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default
```

The local wallet refuses wrong domain, wrong route prefix, wrong Solana x402 network, wrong USDC mint, wrong recipient, over-cap amount, over daily cap, and missing `payment-identifier`.

## No-direct-network fallback

Some agent sandboxes keep the wallet file in a local process that cannot resolve `anchora.markets` or `api.devnet.solana.com`, while the agent itself can still make HTTP requests through a bridge. In that case, keep the local Anchora wallet as payer and use the bridge only as transport.

1. Fetch `/catalog` through the bridge and confirm `settlement.ready: true`.
2. Fetch `/quote` through the bridge and save the `200` body as `quote.json`:

```text
GET https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX&policy=collateral_screening
```

If `/quote` works, do not fetch the protected route without `X-PAYMENT`. Some bridges intercept HTTP `402` and swallow the quote body.

3. If `/quote` is unavailable, fetch the target route without `X-PAYMENT` through a transparent HTTP client only, then save the `402` body as `quote.json`.
4. Build an offline plan:

```bash
npm run x402:agent -- \
  --offline-context-plan \
  --quote-file quote.json \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default
```

5. Save `signerRequest` from the output as `signer-request.json`, then run:

```bash
npm run x402:wallet -- context-plan --wallet default < signer-request.json
```

6. Prefer `fetchContextWithBridge.url` from the wallet context-plan output. Fetch that one URL through the bridge immediately before signing and save the response as `solana-context.json`.

If the one-call URL is unavailable, fetch every `fetchWithBridge[].url` instead and fetch `latestBlockhash` last, immediately before signing.

7. Sign locally:

```bash
npm run x402:agent -- \
  --offline-sign \
  --quote-file quote.json \
  --solana-context-file solana-context.json \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --payment-identifier <same_payment_identifier>
```

8. If the bridge is transparent to `402`, retry the exact target URL through the bridge with the returned `X-PAYMENT` header. Forward the helper-produced header verbatim; do not parse, edit, or rebuild it.
9. If the bridge intercepts `402`, POST the returned `facilitatorSettle.body` to `facilitatorSettle.url`, then check `paymentStatus.url` until `status: "settled"`, then GET the target URL with the same `X-PAYMENT` header to redeem the response.

Do not pay through the bridge wallet. The bridge should never receive the local wallet secret.

Do not run a separate facilitator pre-verify in restricted bridge mode. It can make the blockhash expire before the paid retry. Retry only if Anchora returns a structured pre-send error such as `blockhash_expired` with `phase: "verify"` or `phase: "build"` and `retryable: true`. If Anchora returns `settlement_pending` with `checkTransaction`, do not re-sign or repay; check the status first:

```bash
npm run x402:agent -- --check-payment <payment_identifier>
```

## Installable Skill

Use `SKILL.md` as the agent skill instruction. Copy or install it into the agent environment that supports local skills.

Suggested prompt:

```text
Read the Anchora x402 skill from this public repo:
https://github.com/Marakaya/anchora-x402-agent

I need to check this Anchora asset PDA:
2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX

Create a dedicated Anchora x402 agent wallet with:
- domain: anchora.markets only
- per request cap: 0.30 USDC
- daily cap: 1 USDC

Show me only the generated public key so I can fund it with devnet SOL and devnet USDC. After I confirm funding, read the catalog, validate the quote, execute payment only if it matches policy, and return the proof-package summary with the settlement transaction.

Do not ask for my seed phrase, raw private key, or existing keypair JSON.
```

## Safety Model

- No private keys are committed.
- Generated wallets are stored under ignored `.anchora/agent-wallets/`.
- The helper prints the generated public key and keeps the secret local.
- The signer validates the quote before creating `X-PAYMENT`.
- The wallet is intended for tiny balances and domain-scoped x402 payments only.

## Tests

```bash
npm run check
```

## License

MIT
