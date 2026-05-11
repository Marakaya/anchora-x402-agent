import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PAY_TO,
  DEFAULT_USDC_MINT,
  atomicToUsdcString,
  buildContextPlan,
  createWalletRecord,
  signX402Request,
  usdcToAtomicString,
  validateSignerRequest,
  validateWalletRecord,
} from '../../scripts/x402-agent-wallet.mjs';

const RESOURCE =
  'https://anchora.markets/api/x402/v1/assets/9knTbbayAKkB2iMmiLWTTq8dDcptHfqR42Wr8Rb2VmUd/proof-package?policy=collateral_screening';

function wallet(overrides = {}) {
  return {
    version: 1,
    name: 'test',
    address: '11111111111111111111111111111111',
    createdAt: '2026-04-30T00:00:00.000Z',
    secretKey: Array.from({ length: 64 }, (_, index) => index),
    policy: {
      network: 'solana-devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      allowedOrigins: ['https://anchora.markets'],
      allowedPathPrefix: '/api/x402/v1/',
      allowedPayTo: DEFAULT_PAY_TO,
      allowedUsdcMint: DEFAULT_USDC_MINT,
      perRequestCapAtomic: '100000',
      dailyCapAtomic: '1000000',
      simulateBeforeSign: true,
    },
    ledger: {
      date: '2026-04-30',
      spentAtomic: '0',
      payments: [],
    },
    ...overrides,
  };
}

function signerRequest(overrides = {}) {
  return {
    type: 'x402.sign',
    x402Version: 1,
    paymentRequirements: {
      scheme: 'exact',
      network: 'solana-devnet',
      maxAmountRequired: '50000',
      resource: RESOURCE,
      payTo: DEFAULT_PAY_TO,
      asset: DEFAULT_USDC_MINT,
      extra: { name: 'USDC', version: '2' },
      ...overrides.paymentRequirements,
    },
    extensions: {
      'payment-identifier': {
        info: {
          required: false,
          id: 'anchora_20260430_00112233445566778899aabb',
        },
      },
      ...overrides.extensions,
    },
    context: {
      targetUrl: RESOURCE,
      ...overrides.context,
    },
    ...overrides.root,
  };
}

function decodePaymentHeader(xPayment) {
  return JSON.parse(Buffer.from(xPayment, 'base64').toString('utf8'));
}

test('USDC amount helpers preserve atomic precision', () => {
  assert.equal(usdcToAtomicString('0.10'), '100000');
  assert.equal(usdcToAtomicString('1'), '1000000');
  assert.equal(usdcToAtomicString('0.000001'), '1');
  assert.equal(atomicToUsdcString('100000'), '0.1');
  assert.throws(() => usdcToAtomicString('0.0000001'), /Invalid USDC amount/);
});

test('wallet record validation catches malformed secret storage', () => {
  assert.deepEqual(validateWalletRecord(wallet()), { ok: true, errors: [] });

  const invalid = validateWalletRecord(wallet({ secretKey: [1, 2, 3] }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /secretKey/);
});

test('signer request policy accepts the canonical Anchora x402 quote', () => {
  const validation = validateSignerRequest(
    signerRequest(),
    wallet(),
    new Date('2026-04-30T12:00:00.000Z')
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.paymentIdentifier, 'anchora_20260430_00112233445566778899aabb');
  assert.equal(validation.amountAtomic, '50000');
});

test('signer request policy rejects domain, recipient, mint, and amount drift', () => {
  const validation = validateSignerRequest(
    signerRequest({
      paymentRequirements: {
        resource: 'https://evil.example/api/x402/v1/assets/a/proof-package',
        payTo: 'Attacker1111111111111111111111111111111111',
        asset: 'FakeUsdc111111111111111111111111111111111',
        maxAmountRequired: '100001',
      },
      context: {
        targetUrl: 'https://evil.example/api/x402/v1/assets/a/proof-package',
      },
    }),
    wallet(),
    new Date('2026-04-30T12:00:00.000Z')
  );

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /resource origin/);
  assert.match(validation.errors.join('\n'), /payTo/);
  assert.match(validation.errors.join('\n'), /asset/);
  assert.match(validation.errors.join('\n'), /per-request cap/);
});

test('signer request policy enforces daily cap', () => {
  const validation = validateSignerRequest(
    signerRequest({ paymentRequirements: { maxAmountRequired: '50000' } }),
    wallet({
      ledger: {
        date: '2026-04-30',
        spentAtomic: '980000',
        payments: [],
      },
    }),
    new Date('2026-04-30T12:00:00.000Z')
  );

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /daily cap exceeded/);
});

test('signX402Request returns base64 x402 payload and records local spend', async () => {
  const record = await createWalletRecord({
    name: 'test',
    now: new Date('2026-04-30T00:00:00.000Z'),
  });
  const result = await signX402Request({
    walletRecord: record,
    request: signerRequest(),
    now: new Date('2026-04-30T12:00:00.000Z'),
    paymentBuilder: async ({ requirement }) => ({
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { transaction: 'signed-solana-transaction' },
    }),
  });
  const decoded = decodePaymentHeader(result.xPayment);

  assert.equal(result.payerAddress.length > 0, true);
  assert.equal(result.paymentIdentifier, 'anchora_20260430_00112233445566778899aabb');
  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.scheme, 'exact');
  assert.equal(decoded.payload.transaction, 'signed-solana-transaction');
  assert.equal(
    decoded.extensions['payment-identifier'].info.id,
    'anchora_20260430_00112233445566778899aabb'
  );
  assert.equal(record.ledger.spentAtomic, '50000');
  assert.equal(record.ledger.payments.length, 1);
});

test('buildContextPlan returns bridge-fetchable Solana RPC context URLs', async () => {
  const record = await createWalletRecord({
    name: 'test',
    now: new Date('2026-04-30T00:00:00.000Z'),
  });
  const plan = await buildContextPlan(record, signerRequest(), 'https://anchora.markets/api/x402/solana-rpc');

  assert.equal(plan.ok, true);
  assert.equal(plan.walletAddress, record.address);
  assert.equal(plan.fetchWithBridge.some(item => item.key === 'latestBlockhash'), true);
  assert.equal(
    plan.fetchWithBridge.some(item => item.url.includes('method=account') && item.url.includes(DEFAULT_USDC_MINT)),
    true
  );
  assert.equal(Object.keys(plan.contextTemplate.accounts).includes(DEFAULT_USDC_MINT), true);
});
