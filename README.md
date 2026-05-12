# Anchora x402 Agent Helper

Standalone helper for AI agents that need to buy Anchora RWA trust data through x402 on Solana USDC.

This repository is intentionally public and minimal. It contains only the agent payment helper, local bounded-wallet signer, installable skill instructions, public defaults, and tests. It does not contain Anchora app source code, judge passwords, API keys, seed phrases, private keypairs, or production secrets.

Use this repository as the canonical command workspace for agent-side x402 testing. Agents and judges do not need access to the private Anchora app repository.

## Wallet Public Key Only Fast Path

If the current task is only to create or show an Anchora x402 wallet public key, do not read beyond this section. Do not run catalog/quote, do not inspect any Anchora project repo, and do not run both wallet reuse and wallet creation.

Use exactly one wallet command:

- If the user did not explicitly ask for a fresh isolated wallet, reuse/create `default`:

```bash
cd "$HOME/.codex/anchora-x402-agent" 2>/dev/null \
  && node -p "require('./package.json').version" \
  && (test -d node_modules/@solana/kit || npm ci) \
  && npm --silent run x402:wallet:ensure
```

If this fails because `$HOME/.codex/anchora-x402-agent` is missing, continue to **Quick Start** below, install the helper once into that stable path, then rerun only this command.

- If the user explicitly asks for a fresh/new/isolated wallet, skip `ensure` and create one fresh wallet directly:

```bash
cd "$HOME/.codex/anchora-x402-agent" \
  && npm --silent run x402:wallet -- create --wallet "fresh-$(date +%Y%m%d%H%M%S)" --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

If this fails because `$HOME/.codex/anchora-x402-agent` is missing, continue to **Quick Start** below, install the helper once into that stable path, then rerun only this command.

An existing `default` wallet with `spentToday: 0.3 USDC` and `dailyCap: 1 USDC` still has enough capacity for another `0.30 USDC` proof-package call; do not create a second wallet unless the user requested it. Return only the public funding address and no secret fields.

## Version Guard

Before executing payments, use helper version `0.4.5` or newer:

```bash
node -p "require('./package.json').version"
```

If an existing local workspace already reports `0.4.5` or newer, do not `git pull`, clone, or run `npm ci` just to create a wallet. Refresh only when the version is too old, the helper command fails, or the user explicitly asks for the newest helper.

Older copies may fetch the protected route directly, try to redeem before settlement in bridges that intercept HTTP `402`, fall back to manual REPL signing in read-only sandboxes, or spend time inspecting the private Anchora repo for a payment-only task. The current flow uses `/api/x402/v1/quote` first, includes a bridge-safe facilitator-settle path, supports filesystem-free in-memory signing, and has a strict fast path for agent payments.

## What This Does

- Reads the free Anchora x402 catalog.
- Requests a bridge-safe `200 JSON` quote from Anchora.
- Validates the quote against a local policy.
- Creates a dedicated low-balance Solana agent wallet.
- Signs a Solana USDC payment only when the quote matches policy.
- Retries the same Anchora URL with `X-PAYMENT` in transparent HTTP clients.
- Emits a `facilitatorSettle` request for bridges that intercept HTTP `402`.
- Supports `create-in-memory` and `sign-x402-stdin` when no wallet directory is writable.
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

The live catalog is the source of truth for route pricing and settlement policy. The payment command reads it internally. Use the standalone catalog command only for explicit audit/debug mode:

```bash
npm run catalog
```

## Payment-Only Fast Path

For a normal agent task such as "pay for the proof package" or "fetch this asset through x402", do not inspect the private Anchora app repo, Graphify files, migrations, source code, or unrelated docs. This helper repo plus the live `/catalog`, `/quote`, and signing-context endpoint are the supported interface.

If this helper repo is already available locally, use it directly. Preferred reusable workspace for Codex-like agents:

```text
$HOME/.codex/anchora-x402-agent
```

Do not clone once into a temporary directory and then clone again into a stable directory. Pick the stable workspace first. If it already reports version `0.4.5` or newer, continue without pulling or reinstalling.

Fastest wallet setup path:

```bash
cd "$HOME/.codex/anchora-x402-agent"
node -p "require('./package.json').version"
test -d node_modules/@solana/kit || npm ci
npm run x402:wallet:ensure
```

Do not check `node_modules/.bin/tsx`; this helper does not depend on `tsx`. Do not use timestamped wallet names for the normal flow. `x402:wallet:ensure` creates or reuses `default` and prints the public funding address.

Fastest happy path after the wallet exists, is funded, and the user has authorized the local policy:

```bash
npm run x402:proof -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --execute-payment \
  --print-body \
  --json
```

The proof command performs catalog discovery, quote validation, payment signing, settlement, and redeem in one run. Do not split it into separate catalog and dry-run commands unless the user asked for an audit log, the wallet policy has not been authorized, or the command fails.

Allowed discovery before payment only when setting up the helper, debugging, or producing an explicit audit log:

- `node -p "require('./package.json').version"`
- `npm run catalog`
- `GET /quote`
- wallet balance or signing-context checks

After the user has funded the wallet and already authorized the local policy, do not run a separate catalog command or dry-run quote validation. Execute the single proof command; it performs catalog and quote validation internally before signing.

Only inspect helper source or project code after two consecutive failures from the same helper command or an undocumented response shape from Anchora. If filesystem writes fail, switch directly to `create-in-memory`; do not try `.anchora`, `mktemp`, and manual Node REPL signing in sequence.

Expected hostile-environment path:

1. Create an in-memory wallet.
2. Ask the user to fund the printed public key.
3. Fetch `/catalog`, `/quote`, and signing context through the bridge.
4. Sign with `--bridge-sign-stdin` or `ANCHORA_X402_BRIDGE_SIGN_INPUT_B64`.
5. POST `facilitatorSettle.body`, check payment status, then redeem the target URL.

Bridge-safe quote endpoint:

```bash
curl -fsS 'https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX&policy=collateral_screening'
```

## Quick Start

```bash
mkdir -p "$HOME/.codex"
if [ ! -d "$HOME/.codex/anchora-x402-agent/.git" ]; then
  git clone --depth 1 https://github.com/Marakaya/anchora-x402-agent "$HOME/.codex/anchora-x402-agent"
fi
cd "$HOME/.codex/anchora-x402-agent"
node -p "require('./package.json').version"
test -d node_modules/@solana/kit || npm ci
npm run x402:wallet:ensure
```

This is the normal first step for an agent wallet: it creates or reuses the local `default` wallet and prints the public funding address. Do not run `npm run catalog` just to create the wallet.

If you are already inside a prepared helper workspace, the wallet command is simply:

```bash
npm run x402:wallet:ensure
```

It creates `default` when missing and reuses it when the existing wallet already matches the Anchora policy. It prints the public funding address without exposing the secret. Do not wrap it in custom shell code, do not use a variable named `status` in zsh, and do not generate timestamped wallet names unless you explicitly need a fresh isolated wallet.

No Git available:

```bash
tmp_dir="$(mktemp -d)"
curl -fsSL https://codeload.github.com/Marakaya/anchora-x402-agent/tar.gz/refs/heads/main \
  | tar -xz --strip-components=1 -C "$tmp_dir"
cd "$tmp_dir"
test -d node_modules/@solana/kit || npm ci
npm run x402:wallet:ensure
```

## Fast pay.sh Smoke

If your environment supports `@solana/pay`, this command exercises the pay.sh x402 path against the live devnet proof-package route:

```bash
npx -y @solana/pay --verbose curl https://anchora.markets/api/x402/v1/assets/2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX/proof-package
```

## Bounded Agent Wallet Flow

Create a dedicated wallet:

```bash
npm run x402:wallet:ensure
```

If the current workspace is read-only, create the wallet in a writable temp directory and reuse that directory on later wallet commands:

```bash
wallet_dir="$(mktemp -d)"
npm run x402:wallet -- create --wallet default --wallet-dir "$wallet_dir" --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

If no filesystem location is writable, use the in-memory path instead of manual Node REPL signing:

```bash
npm run x402:wallet -- create-in-memory --domain anchora.markets --per-request-usdc 0.30 --daily-usdc 1
```

This prints an ephemeral `walletRecord` that contains a generated low-balance secret key. Keep it inside the agent runtime only, never show it to the user, and use it only for the authorized Anchora policy. After funding the printed public key, sign without filesystem state by passing that record and the saved `signerRequest`:

```bash
npm run x402:wallet -- sign-x402-stdin < inline-wallet-sign-request.json
```

`inline-wallet-sign-request.json` shape:

```json
{
  "walletRecord": { "...": "walletRecord from create-in-memory" },
  "signerRequest": { "...": "signerRequest from offline-context-plan" }
}
```

For bridge/no-direct-network proof-package payment, prefer the runner's combined bridge signing entrypoint instead of `offline-context-plan`, `/dev/fd`, heredocs, `node -e`, or Node REPL:

```bash
printf '%s' "$BRIDGE_SIGN_INPUT_JSON" \
  | npm run x402:agent -- --bridge-sign-stdin --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX --payment-identifier <same_payment_identifier> --json
```

If stdin, heredocs, or temporary files are unavailable, base64-encode the same JSON and use:

```bash
ANCHORA_X402_BRIDGE_SIGN_INPUT_B64="$BRIDGE_SIGN_INPUT_B64" \
  npm run x402:agent -- --bridge-sign-env --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX --payment-identifier <same_payment_identifier> --json
```

`BRIDGE_SIGN_INPUT_JSON` shape:

```json
{
  "walletRecord": { "...": "walletRecord from create-in-memory" },
  "quoteBody": { "...": "200 JSON body from /api/x402/v1/quote" },
  "solanaContext": { "...": "JSON body from /api/x402/solana-rpc?method=signing-context&payer=<public_key>" },
  "paymentIdentifier": "anchora_YYYYMMDD_..."
}
```

The command returns the `X-PAYMENT` header, `facilitatorSettle.body`, `paymentStatus.url`, and updated secret-bearing `walletRecord` in one result. Keep the updated walletRecord inside the agent runtime only.

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
npm run x402:proof -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --execute-payment \
  --print-body \
  --json
```

Equivalent fallback if your helper copy does not have the `x402:proof` script:

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

Use this only for explicit audit/review mode or when the user has not authorized the bounded policy. Do not run it before the single-call payment command in the funded happy path.

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
4. Fetch signing context once through the bridge, immediately before signing:

```text
GET https://anchora.markets/api/x402/solana-rpc?method=signing-context&payer=<agent_wallet_public_key>
```

5. Run the combined bridge signer with `{ walletRecord, quoteBody, solanaContext, paymentIdentifier }` through `--bridge-sign-stdin` or `ANCHORA_X402_BRIDGE_SIGN_INPUT_B64`. Do not use `/dev/fd`, heredocs, temporary files, `node -e`, or Node REPL unless this helper command itself fails twice.

Legacy file-based fallback if the combined signer is unavailable:

```bash
npm run x402:agent -- \
  --offline-context-plan \
  --quote-file quote.json \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default
```

6. Save `signerRequest` from the output as `signer-request.json`, then run:

```bash
npm run x402:wallet -- context-plan --wallet default < signer-request.json
```

7. Prefer `fetchContextWithBridge.url` from the wallet context-plan output. Fetch that one URL through the bridge immediately before signing and save the response as `solana-context.json`.

If the one-call URL is unavailable, fetch every `fetchWithBridge[].url` instead and fetch `latestBlockhash` last, immediately before signing.

8. Sign locally:

```bash
npm run x402:agent -- \
  --offline-sign \
  --quote-file quote.json \
  --solana-context-file solana-context.json \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --payment-identifier <same_payment_identifier>
```

9. If the bridge is transparent to `402`, retry the exact target URL through the bridge with the returned `X-PAYMENT` header. Forward the helper-produced header verbatim; do not parse, edit, or rebuild it.
10. If the bridge intercepts `402`, POST the returned `facilitatorSettle.body` to `facilitatorSettle.url`, then check `paymentStatus.url` until `status: "settled"`, then GET the target URL with the same `X-PAYMENT` header to redeem the response.

Do not pay through the bridge wallet. The bridge should never receive the local wallet secret.

Do not run a separate facilitator pre-verify in restricted bridge mode. It can make the blockhash expire before the paid retry. Retry only if Anchora returns a structured `blockhash_expired` error with `retryable: true` and no `checkTransaction`. If Anchora returns `settlement_pending` with `checkTransaction`, do not re-sign or repay; check the status first:

```bash
npm run x402:agent -- --check-payment <payment_identifier>
```

Facilitator-settle technical failures intentionally return structured `409` responses for retryable, pending, or failed settlement states so x402-aware bridges expose the body instead of treating it as a new payment challenge.

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

Show me only the generated public key so I can fund it with devnet SOL and devnet USDC. After I confirm funding, run the single proof command; it validates catalog and quote internally before signing. Return the proof-package summary with the settlement transaction.

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
