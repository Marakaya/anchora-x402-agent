#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signX402WithInlineWallet } from './x402-agent-wallet.mjs';

export const DEFAULT_SITE_URL = 'https://anchora.markets';
export const DEFAULT_PAY_TO = 'DtWRumAEkL4AHfSwphuHf2RTmC2zJ9qP2wmGjtq4FxLP';
export const DEFAULT_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEFAULT_X402_NETWORK = 'solana-devnet';
export const DEFAULT_MAX_ATOMIC_AMOUNT = '300000';
export const DEFAULT_POLICY = 'collateral_screening';
export const PAYMENT_IDENTIFIER = 'payment-identifier';

const ROUTES = new Set(['catalog', 'proof-package', 'investor-report', 'score', 'verify', 'by-mint']);
const LOCAL_SIGNER_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

class AgentRunnerError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'AgentRunnerError';
    this.details = details;
  }
}

export function parseArgv(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf('=');
    if (equalsIndex !== -1) {
      args[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[raw] = true;
      continue;
    }

    args[raw] = next;
    index += 1;
  }

  return args;
}

export function loadEnvFile(envPath, targetEnv = process.env) {
  if (!envPath || !existsSync(envPath)) return false;

  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (targetEnv[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    targetEnv[key] = value.replace(/\\n/g, '\n');
  }

  return true;
}

export function normalizeX402Network(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'solana-devnet') return 'solana-devnet';
  if (
    normalized === 'solana' ||
    normalized === 'solana-mainnet' ||
    normalized === 'solana-mainnet-beta'
  ) {
    return 'solana';
  }
  return null;
}

function inferExpectedNetwork({ explicitNetwork, usdcMint }) {
  const explicit = normalizeX402Network(explicitNetwork);
  if (explicit) return explicit;
  if (usdcMint === DEFAULT_USDC_MINT) return 'solana-devnet';
  if (usdcMint === MAINNET_USDC_MINT) return 'solana';
  return DEFAULT_X402_NETWORK;
}

export function buildConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgv(argv);
  const envFile = String(args['env-file'] ?? env.ANCHORA_X402_ENV_FILE ?? '.anchora/x402-signer.env');

  if (!args['no-env-file']) {
    loadEnvFile(resolve(envFile), env);
  }

  const route = String(args.route ?? env.ANCHORA_X402_ROUTE ?? 'proof-package');
  if (!ROUTES.has(route)) {
    throw new AgentRunnerError(`Unsupported route "${route}". Expected one of: ${[...ROUTES].join(', ')}`);
  }
  const defaultMaxAtomicAmount = route === 'investor-report' ? '1000000' : DEFAULT_MAX_ATOMIC_AMOUNT;

  const signerUrl = optionalString(args['signer-url'] ?? env.ANCHORA_X402_SIGNER_URL);
  const agentWallet = optionalString(args['agent-wallet'] ?? env.ANCHORA_X402_AGENT_WALLET);
  let signerCommand = optionalString(args['signer-cmd'] ?? env.ANCHORA_X402_SIGNER_CMD);
  if (agentWallet && !signerCommand && !signerUrl) {
    signerCommand = JSON.stringify([
      process.execPath,
      resolve('scripts/x402-agent-wallet.mjs'),
      'sign-x402',
      '--wallet',
      agentWallet,
    ]);
  }

  const expectedUsdcMint = String(
    args['usdc-mint'] ??
      env.ANCHORA_X402_USDC_MINT ??
      env.X402_SOLANA_USDC_MINT ??
      DEFAULT_USDC_MINT
  );

  return {
    route,
    siteUrl: normalizeSiteUrl(String(args['site-url'] ?? env.ANCHORA_X402_SITE_URL ?? DEFAULT_SITE_URL)),
    assetAddress: optionalString(args['asset-address'] ?? env.ANCHORA_X402_ASSET_ADDRESS),
    mint: optionalString(args.mint ?? env.ANCHORA_X402_MINT),
    txSignature: optionalString(args['tx-signature'] ?? env.ANCHORA_X402_TX_SIGNATURE),
    policy: String(args.policy ?? env.ANCHORA_X402_POLICY ?? DEFAULT_POLICY),
    expectedPayTo: String(args['pay-to'] ?? env.ANCHORA_X402_PAY_TO ?? env.X402_SOLANA_PAY_TO ?? DEFAULT_PAY_TO),
    expectedUsdcMint,
    expectedNetwork: inferExpectedNetwork({
      explicitNetwork: args.network ?? env.ANCHORA_X402_NETWORK ?? env.X402_SOLANA_NETWORK,
      usdcMint: expectedUsdcMint,
    }),
    maxAtomicAmount: String(
      args['max-atomic-amount'] ?? env.ANCHORA_X402_MAX_ATOMIC_AMOUNT ?? defaultMaxAtomicAmount
    ),
    signerUrl,
    signerToken: optionalString(args['signer-token'] ?? env.ANCHORA_X402_SIGNER_TOKEN),
    signerCommand,
    agentWallet,
    allowHttpSigner:
      args['allow-http-signer'] === true ||
      env.ANCHORA_X402_ALLOW_HTTP_SIGNER === 'true',
    executePayment:
      args['execute-payment'] === true ||
      env.ANCHORA_X402_EXECUTE_PAYMENT === 'true',
    printBody:
      args['print-body'] === true ||
      env.ANCHORA_X402_PRINT_BODY === 'true',
    offlineSign:
      args['offline-sign'] === true ||
      env.ANCHORA_X402_OFFLINE_SIGN === 'true',
    offlineContextPlan:
      args['offline-context-plan'] === true ||
      env.ANCHORA_X402_OFFLINE_CONTEXT_PLAN === 'true',
    bridgeSignStdin:
      args['bridge-sign-stdin'] === true ||
      args['bridge-sign-env'] === true ||
      env.ANCHORA_X402_BRIDGE_SIGN_STDIN === 'true',
    bridgeSignInputB64: optionalString(
      args['bridge-sign-input-b64'] ?? env.ANCHORA_X402_BRIDGE_SIGN_INPUT_B64
    ),
    checkPayment: optionalString(args['check-payment'] ?? env.ANCHORA_X402_CHECK_PAYMENT),
    quoteFile: optionalString(args['quote-file'] ?? env.ANCHORA_X402_QUOTE_FILE),
    solanaContextFile: optionalString(args['solana-context-file'] ?? env.ANCHORA_X402_SOLANA_CONTEXT_FILE),
    paymentIdentifier: optionalString(args['payment-identifier'] ?? env.ANCHORA_X402_PAYMENT_IDENTIFIER),
    timeoutMs: positiveInteger(args.timeout ?? env.ANCHORA_X402_TIMEOUT_MS, 30_000),
  };
}

export function buildTargetUrl(config) {
  const baseUrl = config.siteUrl.replace(/\/$/, '');

  if (config.route === 'catalog') {
    return `${baseUrl}/api/x402/v1/catalog`;
  }

  if (config.route === 'proof-package') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    const url = new URL(`${baseUrl}/api/x402/v1/assets/${encodeURIComponent(config.assetAddress)}/proof-package`);
    url.searchParams.set('policy', config.policy);
    return url.href;
  }

  if (config.route === 'investor-report') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    return `${baseUrl}/api/x402/v1/assets/${encodeURIComponent(config.assetAddress)}/investor-report`;
  }

  if (config.route === 'score') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    return `${baseUrl}/api/x402/v1/assets/${encodeURIComponent(config.assetAddress)}/score`;
  }

  if (config.route === 'verify') {
    requireField(config.txSignature, 'ANCHORA_X402_TX_SIGNATURE or --tx-signature');
    return `${baseUrl}/api/x402/v1/verify/${encodeURIComponent(config.txSignature)}`;
  }

  requireField(config.mint, 'ANCHORA_X402_MINT or --mint');
  return `${baseUrl}/api/x402/v1/assets/by-mint/${encodeURIComponent(config.mint)}`;
}

export function buildCatalogUrl(config) {
  return `${config.siteUrl.replace(/\/$/, '')}/api/x402/v1/catalog`;
}

export function buildFacilitatorSettleUrl(config) {
  return `${config.siteUrl.replace(/\/$/, '')}/api/x402/facilitator/settle`;
}

export function buildPaymentStatusUrl(config, paymentIdentifier) {
  return `${config.siteUrl.replace(/\/$/, '')}/api/x402/v1/payments/${encodeURIComponent(paymentIdentifier)}/status`;
}

export function buildQuoteUrl(config) {
  if (config.route === 'catalog') {
    throw new AgentRunnerError('Catalog route does not have a paid quote URL');
  }

  const url = new URL(`${config.siteUrl.replace(/\/$/, '')}/api/x402/v1/quote`);

  if (config.route === 'proof-package') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    url.searchParams.set('route', 'proof-package');
    url.searchParams.set('asset_address', config.assetAddress);
    url.searchParams.set('policy', config.policy);
    return url.href;
  }

  if (config.route === 'investor-report') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    url.searchParams.set('route', 'investor-report');
    url.searchParams.set('asset_address', config.assetAddress);
    return url.href;
  }

  if (config.route === 'score') {
    requireField(config.assetAddress, 'ANCHORA_X402_ASSET_ADDRESS or --asset-address');
    url.searchParams.set('route', 'score');
    url.searchParams.set('asset_address', config.assetAddress);
    return url.href;
  }

  if (config.route === 'verify') {
    requireField(config.txSignature, 'ANCHORA_X402_TX_SIGNATURE or --tx-signature');
    url.searchParams.set('route', 'verify');
    url.searchParams.set('tx_signature', config.txSignature);
    return url.href;
  }

  requireField(config.mint, 'ANCHORA_X402_MINT or --mint');
  url.searchParams.set('route', 'by-mint');
  url.searchParams.set('mint', config.mint);
  return url.href;
}

export function buildPaymentIdentifier(now = new Date(), randomBytes = crypto.randomBytes(12)) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `anchora_${date}_${Buffer.from(randomBytes).toString('hex')}`;
}

export function selectPaymentRequirement(quoteBody) {
  const accepts = Array.isArray(quoteBody?.accepts) ? quoteBody.accepts : [];
  const requirements = Array.isArray(quoteBody?.paymentRequirements)
    ? quoteBody.paymentRequirements
    : [];
  const candidates = [...accepts, ...requirements];
  return candidates.find(candidate => candidate?.scheme === 'exact' && normalizeX402Network(candidate?.network)) ?? null;
}

export function validatePaymentRequirement(requirement, options) {
  const errors = [];
  const expectedUrl = new URL(options.expectedUrl);
  let resourceUrl = null;

  if (!requirement || typeof requirement !== 'object') {
    return { ok: false, errors: ['payment requirement is missing or invalid'] };
  }

  const expectedNetwork = normalizeX402Network(options.expectedNetwork ?? DEFAULT_X402_NETWORK);
  const requirementNetwork = normalizeX402Network(requirement.network);

  if (requirement.scheme !== 'exact') errors.push('scheme must be exact');
  if (!requirementNetwork) errors.push('network must be a supported Solana x402 network');
  else if (requirementNetwork !== expectedNetwork) errors.push(`network must be ${expectedNetwork}`);
  if (requirement.asset !== options.expectedUsdcMint) {
    errors.push(`asset must be ${options.expectedUsdcMint}`);
  }
  if (requirement.payTo !== options.expectedPayTo) {
    errors.push(`payTo must be ${options.expectedPayTo}`);
  }

  try {
    resourceUrl = new URL(String(requirement.resource));
  } catch {
    errors.push('resource must be a valid URL');
  }

  if (resourceUrl) {
    if (resourceUrl.href !== expectedUrl.href) {
      errors.push(`resource must exactly match ${expectedUrl.href}`);
    }
    if (resourceUrl.host !== expectedUrl.host) {
      errors.push(`resource host must be ${expectedUrl.host}`);
    }
    if (!resourceUrl.pathname.startsWith('/api/x402/v1/')) {
      errors.push('resource path must be under /api/x402/v1/');
    }
    if (resourceUrl.protocol !== 'https:' && !LOCAL_SIGNER_HOSTS.has(resourceUrl.hostname)) {
      errors.push('resource must use https outside localhost');
    }
  }

  const amountRaw = String(requirement.maxAmountRequired ?? '');
  const maxRaw = String(options.maxAtomicAmount ?? '');
  if (!/^\d+$/.test(amountRaw)) {
    errors.push('maxAmountRequired must be an integer string');
  }
  if (!/^\d+$/.test(maxRaw)) {
    errors.push('maxAtomicAmount must be an integer string');
  }
  if (/^\d+$/.test(amountRaw) && /^\d+$/.test(maxRaw)) {
    const amount = BigInt(amountRaw);
    const max = BigInt(maxRaw);
    if (amount <= 0n) errors.push('maxAmountRequired must be positive');
    if (amount > max) errors.push(`maxAmountRequired ${amount} exceeds cap ${max}`);
  }

  return { ok: errors.length === 0, errors };
}

export function buildSignerRequest({ config, quoteBody, requirement, targetUrl, paymentIdentifier, solanaContext = null }) {
  return {
    type: 'x402.sign',
    x402Version: Number(quoteBody?.x402Version ?? 1),
    paymentRequirements: requirement,
    extensions: {
      [PAYMENT_IDENTIFIER]: {
        info: {
          required: false,
          id: paymentIdentifier,
        },
      },
    },
    context: {
      provider: 'anchora',
      siteUrl: config.siteUrl,
      targetUrl,
      route: config.route,
      assetAddress: config.assetAddress ?? null,
      mint: config.mint ?? null,
      txSignature: config.txSignature ?? null,
      policy: config.route === 'proof-package' ? config.policy : null,
      expected: {
        scheme: 'exact',
        network: config.expectedNetwork,
        asset: config.expectedUsdcMint,
        payTo: config.expectedPayTo,
        maxAtomicAmount: config.maxAtomicAmount,
      },
      ...(solanaContext ? { solana: solanaContext } : {}),
    },
  };
}

export function resolveSignerUrl(rawUrl, allowHttpSigner = false) {
  if (!rawUrl) throw new AgentRunnerError('ANCHORA_X402_SIGNER_URL or --signer-url is required');

  const url = new URL(rawUrl);
  if ((url.pathname === '' || url.pathname === '/') && !url.search) {
    url.pathname = '/v1/x402/sign';
  }

  const isLocalHttp = url.protocol === 'http:' && LOCAL_SIGNER_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp && !allowHttpSigner) {
    throw new AgentRunnerError('Signer URL must use https outside localhost');
  }

  return url.href;
}

export async function callHttpSigner({ signerUrl, signerToken, allowHttpSigner, payload, timeoutMs }) {
  if (!signerToken) {
    throw new AgentRunnerError('ANCHORA_X402_SIGNER_TOKEN or --signer-token is required for HTTP signer mode');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveSignerUrl(signerUrl, allowHttpSigner), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await readJsonOrText(response);
    if (!response.ok) {
      throw new AgentRunnerError(`Signer returned HTTP ${response.status}`, summarizeErrorBody(body));
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callCommandSigner({ signerCommand, payload, timeoutMs }) {
  if (!signerCommand) {
    throw new AgentRunnerError('ANCHORA_X402_SIGNER_CMD or --signer-cmd is required for command signer mode');
  }

  const [command, ...args] = parseCommand(signerCommand);
  if (!command) throw new AgentRunnerError('Signer command is empty');

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  child.stdin.end(`${JSON.stringify(payload)}\n`);

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('close', resolveExit);
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new AgentRunnerError(`Signer command failed with exit code ${exitCode}`, {
      signerError: summarizeSignerError(stderr || stdout),
    });
  }

  try {
    return JSON.parse(stdout);
  } catch {
    throw new AgentRunnerError('Signer command did not return JSON');
  }
}

export function normalizeSignerResponse(responseBody, expectedPaymentIdentifier) {
  const xPayment =
    responseBody?.xPayment ??
    responseBody?.paymentHeader ??
    responseBody?.payment ??
    null;

  if (typeof xPayment !== 'string' || !xPayment.trim()) {
    throw new AgentRunnerError('Signer response must include xPayment or paymentHeader');
  }

  const decoded = decodePaymentHeader(xPayment);
  if (!decoded.ok) {
    throw new AgentRunnerError('Signer returned an X-PAYMENT value that is not base64 JSON');
  }

  const payloadId = extractPaymentIdentifier(decoded.value);
  const responseId = responseBody?.paymentIdentifier;
  if (payloadId !== expectedPaymentIdentifier) {
    throw new AgentRunnerError('Signer response did not include the expected payment-identifier');
  }
  if (responseId !== undefined && responseId !== expectedPaymentIdentifier) {
    throw new AgentRunnerError('Signer response paymentIdentifier does not match the request');
  }

  return {
    xPayment,
    payerAddress: typeof responseBody?.payerAddress === 'string' ? responseBody.payerAddress : null,
  };
}

export function buildFacilitatorSettleRequest(xPayment, requirement) {
  const decoded = decodePaymentHeader(xPayment);
  if (!decoded.ok) {
    throw new AgentRunnerError('Cannot build facilitator settle request from invalid X-PAYMENT');
  }

  return {
    paymentPayload: decoded.value,
    paymentRequirements: requirement,
  };
}

export async function runAgentPayment(config) {
  if (config.checkPayment) {
    return runPaymentStatusCheck(config);
  }

  const targetUrl = buildTargetUrl(config);

  if (config.offlineSign || config.offlineContextPlan) {
    return runOfflineAgentPayment(config, targetUrl);
  }

  if (config.bridgeSignStdin || config.bridgeSignInputB64) {
    return runBridgeSignPayment(config, targetUrl);
  }

  if (config.route === 'catalog') {
    const { catalogBody, catalogResponse } = await fetchCatalog(config);

    return {
      ok: true,
      dryRun: false,
      paymentRequired: false,
      status: catalogResponse.status,
      targetUrl,
      route: config.route,
      body: config.printBody ? catalogBody : summarizeCatalog(catalogBody),
    };
  }

  const { catalogBody } = await fetchCatalog(config);
  assertSettlementReady(catalogBody);

  const { quoteBody, quoteSource } = await fetchQuote(config, targetUrl);

  const requirement = selectPaymentRequirement(quoteBody);
  if (!requirement) {
    throw new AgentRunnerError('No Solana exact payment requirement found in x402 quote');
  }

  const validation = validatePaymentRequirement(requirement, {
    expectedUrl: targetUrl,
    expectedPayTo: config.expectedPayTo,
    expectedUsdcMint: config.expectedUsdcMint,
    expectedNetwork: config.expectedNetwork,
    maxAtomicAmount: config.maxAtomicAmount,
  });
  if (!validation.ok) {
    throw new AgentRunnerError('Payment requirement failed local policy checks', validation.errors);
  }

  const paymentIdentifier = buildPaymentIdentifier();
  const quoteSummary = {
    targetUrl,
    route: config.route,
    quoteSource,
    policy: config.route === 'proof-package' ? config.policy : null,
    paymentIdentifier,
    requirement: {
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxAmountRequired: requirement.maxAmountRequired,
      resource: requirement.resource,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    },
  };

  if (!config.executePayment) {
    return {
      ok: true,
      dryRun: true,
      quoteValidated: true,
      paymentRequired: true,
      requiresExecutionGrant: true,
      message: 'Quote validated. Re-run with --execute-payment or ANCHORA_X402_EXECUTE_PAYMENT=true to ask the configured signer to pay.',
      ...quoteSummary,
    };
  }

  const retries = [];
  let lastResult = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const signerPayload = buildSignerRequest({
      config,
      quoteBody,
      requirement,
      targetUrl,
      paymentIdentifier,
    });

    const signerResponse = config.signerCommand
      ? await callCommandSigner({
          signerCommand: config.signerCommand,
          payload: signerPayload,
          timeoutMs: config.timeoutMs,
        })
      : await callHttpSigner({
          signerUrl: config.signerUrl,
          signerToken: config.signerToken,
          allowHttpSigner: config.allowHttpSigner,
          payload: signerPayload,
          timeoutMs: config.timeoutMs,
        });

    const { xPayment, payerAddress } = normalizeSignerResponse(signerResponse, paymentIdentifier);
    const paidResponse = await fetch(targetUrl, {
      headers: { 'X-PAYMENT': xPayment },
    });
    const paidBody = await readJsonOrText(paidResponse);
    const paymentResponseHeader = paidResponse.headers.get('x-payment-response');
    const paymentResponse = parsePaymentResponseHeader(paymentResponseHeader);

    lastResult = {
      ok: paidResponse.ok,
      dryRun: false,
      status: paidResponse.status,
      targetUrl,
      route: config.route,
      policy: config.route === 'proof-package' ? config.policy : null,
      payerAddress,
      paymentIdentifier,
      paymentResponse,
      retries,
      body: config.printBody ? paidBody : summarizeBody(paidBody),
    };

    if (paidResponse.ok) return lastResult;

    if (attempt === 0 && isSafePreSendRetry(paidBody)) {
      retries.push({
        reason: paidBody.error,
        phase: paidBody.phase,
        status: paidResponse.status,
      });
      continue;
    }

    return lastResult;
  }

  return lastResult;
}

async function fetchQuote(config, targetUrl) {
  const quoteUrl = buildQuoteUrl(config);
  const quoteResponse = await fetch(quoteUrl);
  const quoteBody = await readJsonOrText(quoteResponse);

  if (quoteResponse.ok) {
    return { quoteBody, quoteSource: 'quote-endpoint', quoteUrl };
  }

  if (quoteResponse.status !== 404 && quoteResponse.status !== 405) {
    throw new AgentRunnerError(`Quote endpoint returned HTTP ${quoteResponse.status}`, {
      quoteUrl,
      body: summarizeErrorBody(quoteBody),
    });
  }

  const challengeResponse = await fetch(targetUrl);
  const challengeBody = await readJsonOrText(challengeResponse);

  if (challengeResponse.status !== 402) {
    throw new AgentRunnerError(`Expected unpaid request to return 402, got ${challengeResponse.status}`, {
      targetUrl,
      body: summarizeBody(challengeBody),
    });
  }

  return { quoteBody: challengeBody, quoteSource: 'http-402', quoteUrl: targetUrl };
}

export async function runPaymentStatusCheck(config) {
  const paymentIdentifier = String(config.checkPayment);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(paymentIdentifier)) {
    throw new AgentRunnerError('Invalid payment identifier for --check-payment');
  }

  const url = buildPaymentStatusUrl(config, paymentIdentifier);
  const response = await fetch(url);
  const body = await readJsonOrText(response);
  return {
    ok: response.ok,
    dryRun: false,
    paymentRequired: false,
    status: response.status,
    targetUrl: url,
    paymentIdentifier,
    body,
  };
}

export async function runOfflineAgentPayment(config, targetUrl = buildTargetUrl(config)) {
  if (!config.quoteFile) {
    throw new AgentRunnerError('--quote-file is required for offline x402 signing');
  }
  if (config.route === 'catalog') {
    throw new AgentRunnerError('Offline signing is only for paid x402 routes, not catalog');
  }

  const quoteBody = readJsonFile(config.quoteFile);
  const requirement = selectPaymentRequirement(quoteBody);
  if (!requirement) {
    throw new AgentRunnerError('No Solana exact payment requirement found in offline quote');
  }

  const validation = validatePaymentRequirement(requirement, {
    expectedUrl: targetUrl,
    expectedPayTo: config.expectedPayTo,
    expectedUsdcMint: config.expectedUsdcMint,
    expectedNetwork: config.expectedNetwork,
    maxAtomicAmount: config.maxAtomicAmount,
  });
  if (!validation.ok) {
    throw new AgentRunnerError('Offline payment requirement failed local policy checks', validation.errors);
  }

  const paymentIdentifier = config.paymentIdentifier || buildPaymentIdentifier();
  const solanaContext = config.solanaContextFile ? readJsonFile(config.solanaContextFile) : null;
  const signerPayload = buildSignerRequest({
    config,
    quoteBody,
    requirement,
    targetUrl,
    paymentIdentifier,
    solanaContext,
  });

  if (config.offlineContextPlan) {
    return {
      ok: true,
      dryRun: true,
      offlineContextPlan: true,
      targetUrl,
      route: config.route,
      paymentIdentifier,
      signerRequest: signerPayload,
      contextPlanCommand: `npm run x402:wallet -- context-plan --wallet ${config.agentWallet ?? '<wallet>'} < signer-request.json`,
      offlineSignCommand: `npm run x402:agent -- --offline-sign --quote-file ${config.quoteFile} --solana-context-file solana-context.json --asset-address ${config.assetAddress ?? '<asset_pda>'} --agent-wallet ${config.agentWallet ?? '<wallet>'} --payment-identifier ${paymentIdentifier}`,
      next: [
        'Save signerRequest as signer-request.json.',
        'Run: npm run x402:wallet -- context-plan --wallet <wallet> < signer-request.json',
        'Prefer the returned fetchContextWithBridge.url; fetch it once through the HTTP bridge immediately before signing and save the response as solana-context.json.',
        'If using the fallback fetchWithBridge list, fetch latestBlockhash last.',
        'Run offline signing with --offline-sign --quote-file <quote.json> --solana-context-file <context.json>.',
        'If your HTTP bridge intercepts 402, POST the returned facilitatorSettle.body to facilitatorSettle.url before redeeming the target URL with X-PAYMENT.',
      ],
    };
  }

  const signerResponse = config.signerCommand
    ? await callCommandSigner({
        signerCommand: config.signerCommand,
        payload: signerPayload,
        timeoutMs: config.timeoutMs,
      })
    : await callHttpSigner({
        signerUrl: config.signerUrl,
        signerToken: config.signerToken,
        allowHttpSigner: config.allowHttpSigner,
        payload: signerPayload,
        timeoutMs: config.timeoutMs,
      });

  const { xPayment, payerAddress } = normalizeSignerResponse(signerResponse, paymentIdentifier);
  const facilitatorSettleBody = buildFacilitatorSettleRequest(xPayment, requirement);

  return {
    ok: true,
    dryRun: false,
    offlineSign: true,
    targetUrl,
    route: config.route,
    policy: config.route === 'proof-package' ? config.policy : null,
    payerAddress,
    paymentIdentifier,
    headers: { 'X-PAYMENT': xPayment },
    facilitatorSettle: {
      url: buildFacilitatorSettleUrl(config),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: facilitatorSettleBody,
    },
    paymentStatus: {
      url: buildPaymentStatusUrl(config, paymentIdentifier),
      method: 'GET',
    },
    next: [
      'Transparent HTTP client: retry targetUrl immediately with the X-PAYMENT header.',
      'Bridge that intercepts 402: POST facilitatorSettle.body to facilitatorSettle.url first, then GET paymentStatus.url until status is settled, then GET targetUrl with the same X-PAYMENT header to redeem the response.',
      'Retry signing only if Anchora reports blockhash_expired with phase build/verify and retryable true before send.',
    ],
  };
}

export async function runBridgeSignPayment(config, targetUrl = buildTargetUrl(config)) {
  if (config.route === 'catalog') {
    throw new AgentRunnerError('Bridge signing is only for paid x402 routes, not catalog');
  }

  const input = await readJsonInput({
    stdin: config.bridgeSignStdin,
    base64: config.bridgeSignInputB64,
    label: '--bridge-sign-stdin or ANCHORA_X402_BRIDGE_SIGN_INPUT_B64',
  });
  const walletRecord = input.walletRecord ?? input.wallet ?? input.agentWalletRecord;
  const quoteBody = input.quoteBody ?? input.quote;
  const solanaContext = input.solanaContext ?? input.context ?? null;
  const paymentIdentifier = input.paymentIdentifier || config.paymentIdentifier || buildPaymentIdentifier();

  if (!walletRecord || typeof walletRecord !== 'object') {
    throw new AgentRunnerError('Bridge sign input must include walletRecord');
  }
  if (!quoteBody || typeof quoteBody !== 'object') {
    throw new AgentRunnerError('Bridge sign input must include quoteBody');
  }
  if (!solanaContext || typeof solanaContext !== 'object') {
    throw new AgentRunnerError('Bridge sign input must include solanaContext from /api/x402/solana-rpc?method=signing-context');
  }

  const requirement = selectPaymentRequirement(quoteBody);
  if (!requirement) {
    throw new AgentRunnerError('No Solana exact payment requirement found in bridge quote');
  }

  const validation = validatePaymentRequirement(requirement, {
    expectedUrl: targetUrl,
    expectedPayTo: config.expectedPayTo,
    expectedUsdcMint: config.expectedUsdcMint,
    expectedNetwork: config.expectedNetwork,
    maxAtomicAmount: config.maxAtomicAmount,
  });
  if (!validation.ok) {
    throw new AgentRunnerError('Bridge payment requirement failed local policy checks', validation.errors);
  }

  const signerPayload = buildSignerRequest({
    config,
    quoteBody,
    requirement,
    targetUrl,
    paymentIdentifier,
    solanaContext,
  });
  const signerResponse = await signX402WithInlineWallet(
    { walletRecord, signerRequest: signerPayload },
    { noSimulate: input.noSimulate === true }
  );
  const { xPayment, payerAddress } = normalizeSignerResponse(signerResponse, paymentIdentifier);
  const facilitatorSettleBody = buildFacilitatorSettleRequest(xPayment, requirement);

  return {
    ok: true,
    dryRun: false,
    bridgeSign: true,
    targetUrl,
    route: config.route,
    policy: config.route === 'proof-package' ? config.policy : null,
    payerAddress,
    paymentIdentifier,
    headers: { 'X-PAYMENT': xPayment },
    facilitatorSettle: {
      url: buildFacilitatorSettleUrl(config),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: facilitatorSettleBody,
    },
    paymentStatus: {
      url: buildPaymentStatusUrl(config, paymentIdentifier),
      method: 'GET',
    },
    walletRecord: signerResponse.walletRecord,
    secretHandling: {
      warning:
        'walletRecord is still secret-bearing and now includes the updated spend ledger. Keep it inside the agent runtime; do not print it to the user.',
    },
    next: [
      'POST facilitatorSettle.body to facilitatorSettle.url.',
      'GET paymentStatus.url until status is settled.',
      'GET targetUrl with the same X-PAYMENT header to redeem the paid response.',
      'If Anchora returns blockhash_expired with retryable true before send, fetch fresh signing context and rerun bridge signing once with the same paymentIdentifier.',
    ],
  };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AgentRunnerError(`Could not read JSON file: ${path}`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readJsonInput({ stdin = false, base64 = null, label = 'JSON input' } = {}) {
  let raw = null;
  if (base64) {
    raw = Buffer.from(String(base64), 'base64').toString('utf8');
  } else if (stdin) {
    raw = await readStdin();
  }

  if (!raw || !raw.trim()) {
    throw new AgentRunnerError(`${label} is required`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AgentRunnerError(`Could not parse ${label} as JSON`, {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parsePaymentResponseHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function decodePaymentHeader(paymentHeader) {
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')),
    };
  } catch {
    return { ok: false };
  }
}

function extractPaymentIdentifier(paymentPayload) {
  return paymentPayload?.extensions?.[PAYMENT_IDENTIFIER]?.info?.id ?? null;
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  return {
    assetId: body.asset?.assetId ?? body.asset_id ?? body.assetId ?? null,
    score:
      body.score?.score ??
      body.score ??
      body.confidence_score ??
      body.currentScore ??
      null,
    underwritingPolicy: body.underwritingPolicy?.profile ?? null,
    automationReadiness: body.decisionSummary?.automationReadiness ?? null,
    recommendedAction: body.decisionSummary?.recommendedAction ?? null,
    signatureStatus: body.integrity?.signature?.status ?? null,
    error: body.error ?? null,
    phase: body.phase ?? null,
    retryable: body.retryable ?? null,
    detail: body.detail ?? null,
    checkTransaction: body.checkTransaction ?? null,
    keys: Object.keys(body).slice(0, 20),
  };
}

function isSafePreSendRetry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return (
    body.error === 'blockhash_expired' &&
    body.retryable === true &&
    (body.phase === 'build' || body.phase === 'verify') &&
    !body.checkTransaction
  );
}

function summarizeCatalog(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  return {
    name: body.name ?? null,
    x402Version: body.x402Version ?? null,
    baseUrl: body.baseUrl ?? null,
    settlement: body.settlement
      ? {
          scheme: body.settlement.scheme ?? null,
          network: body.settlement.network ?? null,
          asset: body.settlement.asset ?? null,
          payTo: body.settlement.payTo ?? null,
          mode: body.settlement.mode ?? null,
          ready: body.settlement.ready ?? null,
          detail: body.settlement.detail ?? null,
          facilitatorUrl: body.settlement.facilitatorUrl ?? null,
        }
      : null,
    idempotency: body.idempotency
      ? {
          extension: body.idempotency.extension ?? null,
          required: body.idempotency.required ?? null,
          ttlSeconds: body.idempotency.ttlSeconds ?? null,
        }
      : null,
    routes: Array.isArray(body.routes)
      ? body.routes.map(route => ({
          routeId: route.routeId ?? null,
          method: route.method ?? null,
          pathTemplate: route.pathTemplate ?? route.path ?? null,
          priceUsd: route.priceUsd ?? null,
          description: route.description ?? null,
        }))
      : [],
  };
}

async function fetchCatalog(config) {
  const catalogUrl = buildCatalogUrl(config);
  const catalogResponse = await fetch(catalogUrl);
  const catalogBody = await readJsonOrText(catalogResponse);
  if (!catalogResponse.ok) {
    throw new AgentRunnerError(`Catalog request returned HTTP ${catalogResponse.status}`, {
      targetUrl: catalogUrl,
      body: summarizeErrorBody(catalogBody),
    });
  }

  return { catalogUrl, catalogBody, catalogResponse };
}

function assertSettlementReady(catalogBody) {
  const settlement = catalogBody?.settlement;
  if (settlement?.ready !== true) {
    throw new AgentRunnerError('Anchora x402 settlement is not ready', {
      settlement: settlement
        ? {
            mode: settlement.mode ?? null,
            ready: settlement.ready ?? null,
            detail: settlement.detail ?? null,
            facilitatorUrl: settlement.facilitatorUrl ?? null,
          }
        : null,
    });
  }
}

function summarizeErrorBody(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 500);
  return summarizeBody(body);
}

function summarizeSignerError(output) {
  if (!output) return null;
  const trimmed = String(output).trim();
  if (!trimmed) return null;

  try {
    return sanitizeSignerError(JSON.parse(trimmed));
  } catch {
    return sanitizeSignerError(trimmed);
  }
}

function sanitizeSignerError(value, key = '', depth = 0) {
  if (depth > 5) return '[truncated]';
  if (/secret|private|seed|token|authorization|xpayment|paymentheader|transaction/i.test(key)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeSignerError(item, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 20).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeSignerError(entryValue, entryKey, depth + 1),
      ])
    );
  }
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

function parseCommand(command) {
  const trimmed = command.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some(part => typeof part !== 'string')) {
      throw new AgentRunnerError('JSON signer command must be an array of strings');
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

function normalizeSiteUrl(value) {
  const url = new URL(value);
  return url.origin;
}

function optionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function requireField(value, label) {
  if (!value) throw new AgentRunnerError(`${label} is required`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Anchora x402 agent runner

Usage:
  npm run x402:agent -- --route catalog
  npm run x402:agent -- --asset-address <asset_pda> [--policy collateral_screening]
  npm run x402:agent -- --route investor-report --asset-address <asset_pda>
  npm run x402:agent -- --asset-address <asset_pda> --execute-payment
  npm run x402:agent -- --check-payment <payment_identifier>
  npm run x402:agent -- --bridge-sign-stdin --asset-address <asset_pda> < bridge-sign-input.json

Environment:
  ANCHORA_X402_SIGNER_URL       HTTPS signer endpoint; /v1/x402/sign is appended for bare origins
  ANCHORA_X402_SIGNER_TOKEN     Bearer token for the signer endpoint
  ANCHORA_X402_SIGNER_CMD       Local signer command; receives JSON on stdin and returns JSON on stdout
  ANCHORA_X402_AGENT_WALLET     Local .anchora agent wallet name; uses scripts/x402-agent-wallet.mjs
  ANCHORA_X402_ASSET_ADDRESS    Asset contract/PDA address for score/proof-package/investor-report routes
  ANCHORA_X402_EXECUTE_PAYMENT  Set true to execute a real signer-backed payment
  ANCHORA_X402_OFFLINE_SIGN     Sign from a saved 402 quote/context without local network fetches
  ANCHORA_X402_OFFLINE_CONTEXT_PLAN
                                  Build a restricted-network signer request and bridge context plan
  ANCHORA_X402_BRIDGE_SIGN_STDIN  Sign bridge-fetched quote/context JSON from stdin
  ANCHORA_X402_BRIDGE_SIGN_INPUT_B64
                                  Base64 JSON input for bridge signing when stdin/heredocs are unavailable
  ANCHORA_X402_CHECK_PAYMENT     Read payment status by payment-identifier without x402
  ANCHORA_X402_QUOTE_FILE       Saved 402 JSON quote used by offline signing

By default the runner validates the 402 quote and stops before payment.
Use --route catalog for free discovery before choosing a paid route.
Paid-route quote discovery uses /api/x402/v1/quote first, then falls back to HTTP 402 if needed.`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  try {
    const config = buildConfig();
    const result = await runAgentPayment(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok && !result.dryRun) process.exitCode = 1;
  } catch (error) {
    const body = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof AgentRunnerError ? error.details : undefined,
    };
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath && import.meta.url === entryPath) {
  await main();
}
