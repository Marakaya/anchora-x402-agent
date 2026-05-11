#!/usr/bin/env node

import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

export const DEFAULT_WALLET_NAME = 'default';
export const DEFAULT_WALLET_DIR = '.anchora/agent-wallets';
export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
export const DEFAULT_RPC_PROXY_URL = 'https://anchora.markets/api/x402/solana-rpc';
export const DEFAULT_DOMAIN = 'anchora.markets';
export const DEFAULT_PAY_TO = 'DtWRumAEkL4AHfSwphuHf2RTmC2zJ9qP2wmGjtq4FxLP';
export const DEFAULT_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEFAULT_X402_NETWORK = 'solana-devnet';
export const DEFAULT_PER_REQUEST_ATOMIC = '300000';
export const DEFAULT_DAILY_ATOMIC = '1000000';
export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const PAYMENT_IDENTIFIER = 'payment-identifier';

const USDC_DECIMALS = 6;
const MAX_MEMO_BYTES = 256;
const WALLET_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const addressEncoder = getAddressEncoder();

class AgentWalletError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'AgentWalletError';
    this.details = details;
  }
}

export function parseArgv(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

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

export function usdcToAtomicString(value) {
  const raw = String(value).trim();
  const match = raw.match(/^(\d+)(?:\.(\d{1,6})?)?$/);
  if (!match) {
    throw new AgentWalletError(`Invalid USDC amount "${value}". Use a decimal with up to 6 places.`);
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  return String(whole * 10n ** BigInt(USDC_DECIMALS) + fraction);
}

export function atomicToUsdcString(value) {
  const amount = BigInt(value);
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = amount / divisor;
  const fraction = String(amount % divisor).padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function resolveWalletDir(rawDir = process.env.ANCHORA_AGENT_WALLET_DIR ?? DEFAULT_WALLET_DIR) {
  return resolve(rawDir);
}

export function walletPath(name = DEFAULT_WALLET_NAME, walletDir = resolveWalletDir()) {
  validateWalletName(name);
  return join(walletDir, `${name}.json`);
}

export async function createWalletRecord({
  name = DEFAULT_WALLET_NAME,
  domain = DEFAULT_DOMAIN,
  perRequestAtomic = DEFAULT_PER_REQUEST_ATOMIC,
  dailyAtomic = DEFAULT_DAILY_ATOMIC,
  payTo = DEFAULT_PAY_TO,
  usdcMint = DEFAULT_USDC_MINT,
  rpcUrl = DEFAULT_RPC_URL,
  network,
  simulateBeforeSign = true,
  now = new Date(),
} = {}) {
  validateWalletName(name);
  const signer = await generateKeyPairSigner(true);
  const secretKey = await exportSignerSecretKey(signer);
  const normalizedOrigin = normalizeDomainOrigin(domain);

  return {
    version: 1,
    name,
    address: signer.address.toString(),
    createdAt: now.toISOString(),
    secretKey: [...secretKey],
    policy: {
      network: inferX402Network({ explicitNetwork: network, rpcUrl, usdcMint }),
      rpcUrl,
      allowedOrigins: [normalizedOrigin],
      allowedPathPrefix: '/api/x402/v1/',
      allowedPayTo: payTo,
      allowedUsdcMint: usdcMint,
      perRequestCapAtomic: String(perRequestAtomic),
      dailyCapAtomic: String(dailyAtomic),
      simulateBeforeSign,
    },
    ledger: {
      date: todayKey(now),
      spentAtomic: '0',
      payments: [],
    },
  };
}

export function validateWalletRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') errors.push('wallet record must be an object');
  if (!WALLET_NAME_RE.test(String(record?.name ?? ''))) errors.push('wallet name is invalid');
  if (!isSecretKeyArray(record?.secretKey)) errors.push('secretKey must be a 64-byte array');
  if (!record?.policy || typeof record.policy !== 'object') errors.push('policy is missing');
  if (!normalizeX402Network(record?.policy?.network)) {
    errors.push('policy.network must be solana-devnet or solana');
  }
  if (!Array.isArray(record?.policy?.allowedOrigins) || record.policy.allowedOrigins.length === 0) {
    errors.push('policy.allowedOrigins must be a non-empty array');
  }
  for (const field of ['allowedPayTo', 'allowedUsdcMint', 'perRequestCapAtomic', 'dailyCapAtomic']) {
    if (!record?.policy?.[field]) errors.push(`policy.${field} is required`);
  }
  if (!/^\d+$/.test(String(record?.policy?.perRequestCapAtomic ?? ''))) {
    errors.push('policy.perRequestCapAtomic must be an integer string');
  }
  if (!/^\d+$/.test(String(record?.policy?.dailyCapAtomic ?? ''))) {
    errors.push('policy.dailyCapAtomic must be an integer string');
  }

  return { ok: errors.length === 0, errors };
}

export function loadWalletRecord(name = DEFAULT_WALLET_NAME, walletDir = resolveWalletDir()) {
  const path = walletPath(name, walletDir);
  if (!existsSync(path)) {
    throw new AgentWalletError(`Agent wallet "${name}" does not exist`, {
      create: `npm run x402:wallet -- create --wallet ${name}`,
    });
  }

  const record = JSON.parse(readFileSync(path, 'utf8'));
  const validation = validateWalletRecord(record);
  if (!validation.ok) {
    throw new AgentWalletError(`Agent wallet "${name}" is invalid`, validation.errors);
  }
  return record;
}

export function saveWalletRecord(record, walletDir = resolveWalletDir()) {
  const validation = validateWalletRecord(record);
  if (!validation.ok) {
    throw new AgentWalletError('Refusing to save invalid agent wallet', validation.errors);
  }

  ensureSecureDir(walletDir);
  const path = walletPath(record.name, walletDir);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  const tmpFd = openSync(tmpPath, 'r');
  try {
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
  const dirFd = openSync(walletDir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return path;
}

export function validateSignerRequest(request, walletRecord, now = new Date()) {
  const errors = [];
  const requirement = request?.paymentRequirements;
  const policy = walletRecord.policy;
  const paymentIdentifier = extractRequestedPaymentIdentifier(request);
  const amountRaw = String(requirement?.maxAmountRequired ?? '');
  let resourceUrl = null;

  if (request?.type !== 'x402.sign') errors.push('request.type must be x402.sign');
  if (Number(request?.x402Version ?? 1) !== 1) errors.push('x402Version must be 1');
  if (!requirement || typeof requirement !== 'object') errors.push('paymentRequirements is required');
  if (requirement?.scheme !== 'exact') errors.push('scheme must be exact');
  const requirementNetwork = normalizeX402Network(requirement?.network);
  const policyNetwork = effectivePolicyNetwork(policy);
  if (!requirementNetwork) errors.push('network must be a supported Solana x402 network');
  else if (requirementNetwork !== policyNetwork) errors.push(`network must be ${policyNetwork}`);
  if (requirement?.asset !== policy.allowedUsdcMint) {
    errors.push(`asset must be ${policy.allowedUsdcMint}`);
  }
  if (requirement?.payTo !== policy.allowedPayTo) {
    errors.push(`payTo must be ${policy.allowedPayTo}`);
  }
  if (!/^\d+$/.test(amountRaw)) errors.push('maxAmountRequired must be an integer string');

  try {
    resourceUrl = new URL(String(requirement?.resource ?? ''));
  } catch {
    errors.push('resource must be a valid URL');
  }

  if (resourceUrl) {
    if (!policy.allowedOrigins.includes(resourceUrl.origin)) {
      errors.push(`resource origin must be one of: ${policy.allowedOrigins.join(', ')}`);
    }
    if (!resourceUrl.pathname.startsWith(policy.allowedPathPrefix)) {
      errors.push(`resource path must start with ${policy.allowedPathPrefix}`);
    }
    if (resourceUrl.protocol !== 'https:') {
      errors.push('resource must use https');
    }
  }

  if (request?.context?.targetUrl && resourceUrl) {
    try {
      const targetUrl = new URL(String(request.context.targetUrl));
      if (targetUrl.href !== resourceUrl.href) {
        errors.push('context.targetUrl must exactly match paymentRequirements.resource');
      }
    } catch {
      errors.push('context.targetUrl must be a valid URL when provided');
    }
  }

  if (!paymentIdentifier) {
    errors.push('payment-identifier extension is required');
  } else if (!PAYMENT_ID_RE.test(paymentIdentifier)) {
    errors.push('payment-identifier id is invalid');
  }

  if (/^\d+$/.test(amountRaw)) {
    const amount = BigInt(amountRaw);
    const perRequest = BigInt(policy.perRequestCapAtomic);
    const daily = BigInt(policy.dailyCapAtomic);
    const spentToday = getSpentToday(walletRecord, now);
    if (amount <= 0n) errors.push('maxAmountRequired must be positive');
    if (amount > perRequest) {
      errors.push(`amount ${amount} exceeds per-request cap ${perRequest}`);
    }
    if (spentToday + amount > daily) {
      errors.push(`daily cap exceeded: ${spentToday + amount} > ${daily}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    paymentIdentifier,
    amountAtomic: amountRaw,
    resource: resourceUrl?.href ?? null,
  };
}

export async function signX402Request({
  walletRecord,
  request,
  now = new Date(),
  paymentBuilder = buildSolanaExactPaymentPayload,
}) {
  resetLedgerIfNeeded(walletRecord, now);
  const validation = validateSignerRequest(request, walletRecord, now);
  if (!validation.ok) {
    throw new AgentWalletError('Signer request rejected by agent-wallet policy', validation.errors);
  }

  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(walletRecord.secretKey), true);
  if (walletRecord.address !== signer.address.toString()) {
    throw new AgentWalletError('Agent wallet address does not match its stored signing key');
  }
  const requirement = {
    ...request.paymentRequirements,
    extra: {
      ...(request.paymentRequirements.extra ?? {}),
      feePayer: signer.address.toString(),
    },
  };
  const paymentPayload = await paymentBuilder({
    request,
    requirement,
    walletRecord,
    signer,
  });
  const enrichedPaymentPayload = {
    ...paymentPayload,
    extensions: mergePaymentExtensions(paymentPayload.extensions, request.extensions),
  };
  const xPayment = encodePaymentHeader(enrichedPaymentPayload);
  const xPaymentHash = crypto.createHash('sha256').update(xPayment).digest('hex');

  recordSpend(walletRecord, {
    amountAtomic: validation.amountAtomic,
    paymentIdentifier: validation.paymentIdentifier,
    resource: validation.resource,
    xPaymentHash,
    signedAt: now.toISOString(),
  });

  return {
    xPayment,
    payerAddress: signer.address.toString(),
    paymentIdentifier: validation.paymentIdentifier,
  };
}

export async function buildSolanaExactPaymentPayload({ request, requirement, walletRecord, signer }) {
  const policy = walletRecord.policy;
  const dataSource = createSolanaDataSource(policy.rpcUrl || DEFAULT_RPC_URL, request?.context?.solana ?? null);
  const mint = address(requirement.asset);
  const payTo = address(requirement.payTo);
  const signerAddress = address(signer.address);
  const { tokenProgramAddress, decimals } = await fetchMintInfo(dataSource, mint);
  const sourceAta = await deriveAssociatedTokenAddress({
    owner: signerAddress,
    mint,
    tokenProgramAddress,
  });
  const destinationAta = await deriveAssociatedTokenAddress({
    owner: payTo,
    mint,
    tokenProgramAddress,
  });

  await assertTokenAccountCanPay({
    dataSource,
    sourceAta,
    destinationAta,
    sourceOwner: signerAddress,
    amountAtomic: BigInt(requirement.maxAmountRequired),
  });

  const latestBlockhash = await dataSource.getLatestBlockhash();
  const transferIx = buildTransferCheckedInstruction({
    tokenProgramAddress,
    source: sourceAta,
    mint,
    destination: destinationAta,
    authority: signerAddress,
    amountAtomic: BigInt(requirement.maxAmountRequired),
    decimals,
  });
  const memoIx = buildMemoInstruction(buildMemo(requirement));

  let tx = createTransactionMessage({ version: 0 });
  tx = setTransactionMessageFeePayerSigner(signer, tx);
  tx = appendTransactionMessageInstructions([transferIx, memoIx], tx);
  tx = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx);

  const signedTransaction = await signTransactionMessageWithSigners(tx);
  const transaction = getBase64EncodedWireTransaction(signedTransaction);

  if (policy.simulateBeforeSign !== false) {
    await dataSource.simulateTransaction(transaction);
  }

  return {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      transaction,
    },
  };
}

export async function getWalletBalances(walletRecord) {
  const dataSource = createSolanaDataSource(walletRecord.policy.rpcUrl || DEFAULT_RPC_URL, null);
  const signerAddress = address(walletRecord.address);
  const sol = await dataSource.getBalance(signerAddress);
  const mint = address(walletRecord.policy.allowedUsdcMint);
  const { tokenProgramAddress } = await fetchMintInfo(dataSource, mint);
  const ata = await deriveAssociatedTokenAddress({
    owner: signerAddress,
    mint,
    tokenProgramAddress,
  });
  const tokenAccount = await fetchBase64Account(dataSource, ata, signerAddress);
  const usdcAtomic = tokenAccount ? String(readTokenAccountAmount(tokenAccount.data)) : '0';

  return {
    address: walletRecord.address,
    solLamports: String(sol.value ?? sol),
    sol: lamportsToSolString(sol.value ?? sol),
    usdcAtomic,
    usdc: atomicToUsdcString(usdcAtomic),
    usdcTokenAccount: ata.toString(),
  };
}

function buildTransferCheckedInstruction({
  tokenProgramAddress,
  source,
  mint,
  destination,
  authority,
  amountAtomic,
  decimals,
}) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountAtomic, 1);
  data.writeUInt8(decimals, 9);

  return {
    programAddress: tokenProgramAddress,
    accounts: [
      toAccountMeta(source, AccountRole.WRITABLE),
      toAccountMeta(mint, AccountRole.READONLY),
      toAccountMeta(destination, AccountRole.WRITABLE),
      toAccountMeta(authority, AccountRole.READONLY_SIGNER),
    ],
    data,
  };
}

function buildMemoInstruction(memo) {
  const data = new TextEncoder().encode(memo);
  if (data.byteLength > MAX_MEMO_BYTES) {
    throw new AgentWalletError(`x402 memo exceeds ${MAX_MEMO_BYTES} bytes`);
  }

  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts: [],
    data,
  };
}

function buildMemo(requirement) {
  const memo = requirement.extra?.memo;
  if (memo) return String(memo);
  return crypto.randomBytes(16).toString('hex');
}

async function fetchMintInfo(dataSource, mintAddress) {
  const account = await fetchBase64Account(dataSource, mintAddress);
  if (!account) {
    throw new AgentWalletError(`USDC mint account not found: ${mintAddress}`);
  }
  if (account.owner !== TOKEN_PROGRAM_ADDRESS && account.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new AgentWalletError(`Asset mint is not owned by SPL Token or Token-2022: ${account.owner}`);
  }
  if (account.data.length < 45) {
    throw new AgentWalletError('Mint account is too small to read decimals');
  }

  return {
    tokenProgramAddress: address(account.owner),
    decimals: account.data[44],
  };
}

async function assertTokenAccountCanPay({ dataSource, sourceAta, destinationAta, sourceOwner, amountAtomic }) {
  const [sourceAccount, destinationAccount] = await Promise.all([
    fetchBase64Account(dataSource, sourceAta, sourceOwner),
    fetchBase64Account(dataSource, destinationAta),
  ]);

  if (!sourceAccount) {
    throw new AgentWalletError(
      `Agent wallet has no USDC token account yet. Send USDC to the wallet address first. Expected ATA: ${sourceAta}`
    );
  }
  if (!destinationAccount) {
    throw new AgentWalletError(
      `Anchora recipient USDC token account is missing. Expected ATA: ${destinationAta}`
    );
  }

  const balance = readTokenAccountAmount(sourceAccount.data);
  if (balance < amountAtomic) {
    throw new AgentWalletError(
      `Insufficient USDC: wallet has ${atomicToUsdcString(balance)} USDC, payment needs ${atomicToUsdcString(amountAtomic)} USDC`
    );
  }
}

async function fetchBase64Account(dataSource, accountAddress, ownerAddress = null) {
  return dataSource.getAccountInfo(accountAddress, ownerAddress);
}

function readTokenAccountAmount(data) {
  if (data.length < 72) {
    throw new AgentWalletError('Token account is too small to read amount');
  }
  return data.readBigUInt64LE(64);
}

async function deriveAssociatedTokenAddress({ owner, mint, tokenProgramAddress }) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(tokenProgramAddress),
      addressEncoder.encode(mint),
    ],
  });
  return ata;
}

function createSolanaDataSource(rpcUrl, solanaContext) {
  if (solanaContext) return createContextSolanaDataSource(solanaContext);
  if (isAnchoraRpcProxyUrl(rpcUrl)) return createProxySolanaDataSource(rpcUrl);

  const rpc = createSolanaRpc(rpcUrl || DEFAULT_RPC_URL);
  return {
    kind: 'rpc',
    async getAccountInfo(accountAddress) {
      const response = await rpc
        .getAccountInfo(accountAddress, { encoding: 'base64', commitment: 'confirmed' })
        .send();
      return normalizeRpcAccount(response.value);
    },
    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return value;
    },
    async getBalance(accountAddress) {
      return rpc.getBalance(accountAddress, { commitment: 'confirmed' }).send();
    },
    async simulateTransaction(transaction) {
      return simulateSignedTransaction(rpc, transaction);
    },
  };
}

function createContextSolanaDataSource(solanaContext) {
  return {
    kind: 'context',
    async getAccountInfo(accountAddress) {
      const account = contextAccount(solanaContext, accountAddress);
      return account ? normalizeContextAccount(account) : null;
    },
    async getLatestBlockhash() {
      const latestBlockhash = solanaContext.latestBlockhash ?? solanaContext.blockhash;
      if (!latestBlockhash?.blockhash || latestBlockhash.lastValidBlockHeight === undefined) {
        throw new AgentWalletError('Offline Solana context is missing latestBlockhash');
      }
      return {
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
      };
    },
    async getBalance(accountAddress) {
      const balances = solanaContext.balances ?? {};
      const value = balances[String(accountAddress)]?.value ?? balances[String(accountAddress)] ?? 0;
      return { value: BigInt(value) };
    },
    async simulateTransaction() {
      return null;
    },
  };
}

function createProxySolanaDataSource(rpcProxyUrl) {
  return {
    kind: 'anchora-rpc-proxy',
    async getAccountInfo(accountAddress, ownerAddress = null) {
      const url = new URL(rpcProxyUrl);
      url.searchParams.set('method', 'account');
      url.searchParams.set('address', String(accountAddress));
      if (ownerAddress) url.searchParams.set('owner', String(ownerAddress));
      const body = await fetchProxyJson(url.href);
      return body.account ? normalizeContextAccount(body.account) : null;
    },
    async getLatestBlockhash() {
      const url = new URL(rpcProxyUrl);
      url.searchParams.set('method', 'latest-blockhash');
      const body = await fetchProxyJson(url.href);
      if (!body.latestBlockhash?.blockhash) {
        throw new AgentWalletError('Anchora Solana RPC proxy did not return a latest blockhash');
      }
      return {
        blockhash: body.latestBlockhash.blockhash,
        lastValidBlockHeight: BigInt(body.latestBlockhash.lastValidBlockHeight),
      };
    },
    async getBalance(accountAddress) {
      const url = new URL(rpcProxyUrl);
      url.searchParams.set('method', 'balance');
      url.searchParams.set('address', String(accountAddress));
      const body = await fetchProxyJson(url.href);
      return { value: BigInt(body.balance?.lamports ?? 0) };
    },
    async simulateTransaction() {
      return null;
    },
  };
}

async function fetchProxyJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AgentWalletError(`Anchora Solana RPC proxy returned HTTP ${response.status}`, body);
  }
  return body;
}

function normalizeRpcAccount(value) {
  if (!value) return null;
  const [encoded, encoding] = value.data;
  if (encoding !== 'base64') {
    throw new AgentWalletError(`Unexpected account encoding: ${encoding}`);
  }
  return {
    owner: value.owner.toString(),
    lamports: value.lamports,
    data: Buffer.from(encoded, 'base64'),
  };
}

function normalizeContextAccount(value) {
  const account = value?.account ?? value;
  if (!account) return null;
  const data = Array.isArray(account.data) ? account.data[0] : account.data;
  if (typeof account.owner !== 'string' || typeof data !== 'string') {
    throw new AgentWalletError('Offline Solana context account must include owner and base64 data');
  }
  return {
    owner: account.owner,
    lamports: account.lamports ?? 0,
    data: Buffer.from(data, 'base64'),
  };
}

function contextAccount(solanaContext, accountAddress) {
  const accounts = solanaContext.accounts ?? {};
  return accounts[String(accountAddress)] ?? null;
}

function isAnchoraRpcProxyUrl(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'anchora-proxy') return true;
  try {
    return new URL(raw).pathname === '/api/x402/solana-rpc';
  } catch {
    return false;
  }
}

async function simulateSignedTransaction(rpc, transaction) {
  const result = await rpc
    .simulateTransaction(transaction, {
      commitment: 'confirmed',
      encoding: 'base64',
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();

  if (result.value.err) {
    const error = JSON.stringify(result.value.err, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    const logs = Array.isArray(result.value.logs) ? result.value.logs.slice(-6) : [];
    throw new AgentWalletError('Signed x402 transaction simulation failed', { error, logs });
  }
}

export async function buildContextPlan(walletRecord, request, rpcProxyUrl = DEFAULT_RPC_PROXY_URL) {
  const validation = validateSignerRequest(request, walletRecord, new Date());
  if (!validation.ok) {
    throw new AgentWalletError('Cannot build context plan for a signer request outside wallet policy', validation.errors);
  }

  const requirement = request.paymentRequirements;
  const signerAddress = address(walletRecord.address);
  const mint = address(requirement.asset);
  const payTo = address(requirement.payTo);
  const sourceTokenAta = await deriveAssociatedTokenAddress({
    owner: signerAddress,
    mint,
    tokenProgramAddress: address(TOKEN_PROGRAM_ADDRESS),
  });
  const sourceToken2022Ata = await deriveAssociatedTokenAddress({
    owner: signerAddress,
    mint,
    tokenProgramAddress: address(TOKEN_2022_PROGRAM_ADDRESS),
  });
  const destinationTokenAta = await deriveAssociatedTokenAddress({
    owner: payTo,
    mint,
    tokenProgramAddress: address(TOKEN_PROGRAM_ADDRESS),
  });
  const destinationToken2022Ata = await deriveAssociatedTokenAddress({
    owner: payTo,
    mint,
    tokenProgramAddress: address(TOKEN_2022_PROGRAM_ADDRESS),
  });

  return {
    ok: true,
    walletAddress: walletRecord.address,
    rpcProxyUrl,
    fetchContextWithBridge: {
      key: 'solanaContext',
      url: proxyUrl(rpcProxyUrl, { method: 'signing-context', payer: walletRecord.address }),
      note: 'Preferred restricted-network path: fetch this one URL through the HTTP bridge immediately before offline-sign and save the response as solana-context.json.',
    },
    fetchWithBridge: [
      { key: `accounts.${requirement.asset}`, url: proxyUrl(rpcProxyUrl, { method: 'account', address: requirement.asset }) },
      {
        key: `accounts.${sourceTokenAta}`,
        url: proxyUrl(rpcProxyUrl, { method: 'account', address: sourceTokenAta, owner: walletRecord.address }),
      },
      {
        key: `accounts.${sourceToken2022Ata}`,
        url: proxyUrl(rpcProxyUrl, { method: 'account', address: sourceToken2022Ata, owner: walletRecord.address }),
      },
      {
        key: `accounts.${destinationTokenAta}`,
        url: proxyUrl(rpcProxyUrl, { method: 'account', address: destinationTokenAta }),
      },
      {
        key: `accounts.${destinationToken2022Ata}`,
        url: proxyUrl(rpcProxyUrl, { method: 'account', address: destinationToken2022Ata }),
      },
      { key: 'latestBlockhash', url: proxyUrl(rpcProxyUrl, { method: 'latest-blockhash' }) },
    ],
    contextTemplate: {
      latestBlockhash: 'paste latestBlockhash response object here',
      accounts: {
        [requirement.asset]: 'paste account response object here',
        [sourceTokenAta]: 'paste account response object here if non-null',
        [sourceToken2022Ata]: 'paste account response object here if non-null',
        [destinationTokenAta]: 'paste account response object here if non-null',
        [destinationToken2022Ata]: 'paste account response object here if non-null',
      },
    },
  };
}

function proxyUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

function recordSpend(walletRecord, entry) {
  const amount = BigInt(entry.amountAtomic);
  const spent = BigInt(walletRecord.ledger.spentAtomic);
  walletRecord.ledger.spentAtomic = String(spent + amount);
  walletRecord.ledger.payments.push(entry);
  walletRecord.ledger.payments = walletRecord.ledger.payments.slice(-100);
}

function resetLedgerIfNeeded(walletRecord, now) {
  const today = todayKey(now);
  if (walletRecord.ledger?.date === today) return;
  walletRecord.ledger = {
    date: today,
    spentAtomic: '0',
    payments: [],
  };
}

function getSpentToday(walletRecord, now) {
  return walletRecord.ledger?.date === todayKey(now)
    ? BigInt(walletRecord.ledger.spentAtomic ?? '0')
    : 0n;
}

function extractRequestedPaymentIdentifier(request) {
  return request?.extensions?.[PAYMENT_IDENTIFIER]?.info?.id ?? null;
}

function mergePaymentExtensions(payloadExtensions, requestExtensions) {
  if (!payloadExtensions && !requestExtensions) return undefined;
  return {
    ...(requestExtensions ?? {}),
    ...(payloadExtensions ?? {}),
  };
}

function encodePaymentHeader(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function normalizeDomainOrigin(value) {
  const raw = String(value ?? DEFAULT_DOMAIN).trim();
  const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
  if (url.protocol !== 'https:') {
    throw new AgentWalletError('Agent wallet domain must use https');
  }
  return url.origin;
}

function ensureSecureDir(walletDir) {
  mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  chmodSync(walletDir, 0o700);
  const stats = statSync(walletDir);
  if (!stats.isDirectory()) {
    throw new AgentWalletError(`Wallet path is not a directory: ${walletDir}`);
  }
}

function validateWalletName(name) {
  if (!WALLET_NAME_RE.test(String(name ?? ''))) {
    throw new AgentWalletError('Wallet name must be 1-64 letters, numbers, dots, underscores, or hyphens');
  }
}

function isSecretKeyArray(value) {
  return (
    Array.isArray(value) &&
    value.length === 64 &&
    value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
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

function inferX402Network({ explicitNetwork, rpcUrl, usdcMint }) {
  const explicit = normalizeX402Network(explicitNetwork);
  if (explicit) return explicit;
  const normalizedRpc = String(rpcUrl ?? '').toLowerCase();
  if (normalizedRpc.includes('devnet')) return 'solana-devnet';
  if (normalizedRpc.includes('mainnet')) return 'solana';
  if (usdcMint === DEFAULT_USDC_MINT) return 'solana-devnet';
  if (usdcMint === MAINNET_USDC_MINT) return 'solana';
  return DEFAULT_X402_NETWORK;
}

function effectivePolicyNetwork(policy) {
  const explicit = normalizeX402Network(policy?.network);
  if (
    explicit === 'solana' &&
    policy?.allowedUsdcMint === DEFAULT_USDC_MINT &&
    String(policy?.rpcUrl ?? '').toLowerCase().includes('devnet')
  ) {
    return 'solana-devnet';
  }
  return explicit;
}

async function exportSignerSecretKey(signer) {
  const [privateKeyPkcs8, publicKeyRaw] = await Promise.all([
    crypto.webcrypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey),
    crypto.webcrypto.subtle.exportKey('raw', signer.keyPair.publicKey),
  ]);
  const privateKeyBytes = new Uint8Array(privateKeyPkcs8).slice(16);
  const publicKeyBytes = new Uint8Array(publicKeyRaw);
  const secretKey = new Uint8Array(64);
  secretKey.set(privateKeyBytes, 0);
  secretKey.set(publicKeyBytes, 32);
  return secretKey;
}

function toAccountMeta(accountAddress, role) {
  return {
    address: typeof accountAddress === 'string' ? address(accountAddress) : accountAddress,
    role,
  };
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function lamportsToSolString(lamports) {
  const amount = BigInt(lamports);
  const whole = amount / 1_000_000_000n;
  const fraction = String(amount % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function formatWalletInfo(record) {
  return {
    name: record.name,
    address: record.address,
    createdAt: record.createdAt,
    policy: {
      network: record.policy.network,
      allowedOrigins: record.policy.allowedOrigins,
      allowedPathPrefix: record.policy.allowedPathPrefix,
      allowedPayTo: record.policy.allowedPayTo,
      allowedUsdcMint: record.policy.allowedUsdcMint,
      perRequestCap: `${atomicToUsdcString(record.policy.perRequestCapAtomic)} USDC`,
      dailyCap: `${atomicToUsdcString(record.policy.dailyCapAtomic)} USDC`,
      spentToday: `${atomicToUsdcString(record.ledger.spentAtomic)} USDC`,
      rpcUrl: record.policy.rpcUrl,
      simulateBeforeSign: record.policy.simulateBeforeSign !== false,
    },
  };
}

function printHelp() {
  console.log(`Anchora x402 agent wallet

Usage:
  npm run x402:wallet -- create --wallet default
  npm run x402:wallet -- info --wallet default
  npm run x402:wallet -- balance --wallet default
  npm run x402:wallet -- sign-x402 --wallet default

Create defaults:
  domain: anchora.markets
  per request cap: 0.30 USDC
  daily cap: 1.00 USDC
  recipient: ${DEFAULT_PAY_TO}
  network: ${DEFAULT_X402_NETWORK}

The sign-x402 command reads a signer request JSON from stdin and returns JSON on stdout.
It never prints the wallet secret key.`);
}

async function runCreate(args) {
  const name = String(args.wallet ?? args.name ?? DEFAULT_WALLET_NAME);
  const walletDir = resolveWalletDir(args['wallet-dir']);
  const path = walletPath(name, walletDir);
  if (existsSync(path) && args.force !== true) {
    throw new AgentWalletError(`Agent wallet "${name}" already exists. Use --force to replace it.`);
  }

  const record = await createWalletRecord({
    name,
    domain: String(args.domain ?? DEFAULT_DOMAIN),
    perRequestAtomic: args['per-request-atomic']
      ? String(args['per-request-atomic'])
      : usdcToAtomicString(args['per-request-usdc'] ?? '0.30'),
    dailyAtomic: args['daily-atomic']
      ? String(args['daily-atomic'])
      : usdcToAtomicString(args['daily-usdc'] ?? '1'),
    rpcUrl: String(args['rpc-url'] ?? process.env.X402_SOLANA_RPC_URL ?? DEFAULT_RPC_URL),
    payTo: String(args['pay-to'] ?? process.env.X402_SOLANA_PAY_TO ?? DEFAULT_PAY_TO),
    usdcMint: String(args['usdc-mint'] ?? process.env.X402_SOLANA_USDC_MINT ?? DEFAULT_USDC_MINT),
    network: args.network ?? process.env.ANCHORA_X402_NETWORK ?? process.env.X402_SOLANA_NETWORK,
    simulateBeforeSign: args['no-simulate'] !== true,
  });
  saveWalletRecord(record, walletDir);

  return {
    ok: true,
    created: true,
    wallet: formatWalletInfo(record),
    funding: {
      sendTo: record.address,
      recommendedUsdc: '1 USDC',
      recommendedSol: '0.01 SOL',
      usdcMint: record.policy.allowedUsdcMint,
      note: 'Fund this public address from your own wallet. The secret stays in the local ignored .anchora directory.',
    },
  };
}

async function runInfo(args) {
  const record = loadWalletRecord(String(args.wallet ?? DEFAULT_WALLET_NAME), resolveWalletDir(args['wallet-dir']));
  return {
    ok: true,
    wallet: formatWalletInfo(record),
  };
}

async function runBalance(args) {
  const record = loadWalletRecord(String(args.wallet ?? DEFAULT_WALLET_NAME), resolveWalletDir(args['wallet-dir']));
  return {
    ok: true,
    balances: await getWalletBalances(record),
  };
}

async function runSignX402(args) {
  const walletDir = resolveWalletDir(args['wallet-dir']);
  const record = loadWalletRecord(String(args.wallet ?? DEFAULT_WALLET_NAME), walletDir);
  const request = JSON.parse(await readStdin());
  if (args['no-simulate'] === true) record.policy.simulateBeforeSign = false;
  const response = await signX402Request({ walletRecord: record, request });
  saveWalletRecord(record, walletDir);
  return response;
}

async function runContextPlan(args) {
  const walletDir = resolveWalletDir(args['wallet-dir']);
  const record = loadWalletRecord(String(args.wallet ?? DEFAULT_WALLET_NAME), walletDir);
  const request = JSON.parse(await readStdin());
  return buildContextPlan(
    record,
    request,
    String(args['rpc-proxy-url'] ?? process.env.ANCHORA_X402_RPC_PROXY_URL ?? DEFAULT_RPC_PROXY_URL)
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === 'help' || process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  let result;
  if (command === 'create') result = await runCreate(args);
  else if (command === 'info') result = await runInfo(args);
  else if (command === 'balance') result = await runBalance(args);
  else if (command === 'sign-x402') result = await runSignX402(args);
  else if (command === 'context-plan') result = await runContextPlan(args);
  else throw new AgentWalletError(`Unknown command "${command}"`);

  console.log(JSON.stringify(result, null, 2));
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath && import.meta.url === entryPath) {
  try {
    await main();
  } catch (error) {
    const body = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof AgentWalletError ? error.details : undefined,
    };
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
  }
}
