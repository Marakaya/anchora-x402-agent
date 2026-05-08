# Anchora x402 Agent Helper

Standalone helper for AI agents that need to buy Anchora RWA trust data through x402 on Solana USDC.

This repository is intentionally public and minimal. It contains only the agent payment helper, local bounded-wallet signer, installable skill instructions, public defaults, and tests. It does not contain Anchora app source code, judge passwords, API keys, seed phrases, private keypairs, or production secrets.

## What This Does

- Reads the free Anchora x402 catalog.
- Requests a paid quote from Anchora.
- Validates the quote against a local policy.
- Creates a dedicated low-balance Solana agent wallet.
- Signs a Solana USDC payment only when the quote matches policy.
- Retries the same Anchora URL with `X-PAYMENT`.
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

Validate the quote without payment:

```bash
npm run x402:agent -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default
```

Execute payment after the user has authorized the local policy:

```bash
npm run x402:agent -- \
  --asset-address 2eZLs5ZK1X7nvi835xbDxhGtUCvssV5s8WDUJF28gKvX \
  --agent-wallet default \
  --execute-payment \
  --print-body
```

The local wallet refuses wrong domain, wrong route prefix, wrong Solana x402 network, wrong USDC mint, wrong recipient, over-cap amount, over daily cap, and missing `payment-identifier`.

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
