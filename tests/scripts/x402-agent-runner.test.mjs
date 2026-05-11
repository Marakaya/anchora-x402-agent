import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_PAY_TO,
  DEFAULT_USDC_MINT,
  buildConfig,
  buildFacilitatorSettleRequest,
  buildPaymentIdentifier,
  buildQuoteUrl,
  buildSignerRequest,
  buildTargetUrl,
  callCommandSigner,
  normalizeSignerResponse,
  resolveSignerUrl,
  runAgentPayment,
  runOfflineAgentPayment,
  selectPaymentRequirement,
  validatePaymentRequirement,
} from '../../scripts/x402-agent-runner.mjs';

const ASSET_ADDRESS = '9knTbbayAKkB2iMmiLWTTq8dDcptHfqR42Wr8Rb2VmUd';

function baseConfig(overrides = {}) {
  const extraArgv = overrides.argv ?? [];
  return buildConfig(
    [
      '--no-env-file',
      '--asset-address',
      ASSET_ADDRESS,
      '--site-url',
      'https://anchora.markets',
      ...extraArgv,
    ],
    { ...overrides.env }
  );
}

function validRequirement(targetUrl, overrides = {}) {
  return {
    scheme: 'exact',
    network: 'solana-devnet',
    asset: DEFAULT_USDC_MINT,
    payTo: DEFAULT_PAY_TO,
    maxAmountRequired: '50000',
    resource: targetUrl,
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

function encodePayment(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

test('buildTargetUrl uses asset contract address and policy query for proof-package', () => {
  const config = baseConfig({ argv: ['--policy', 'insurance_review'] });

  assert.equal(
    buildTargetUrl(config),
    `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=insurance_review`
  );
});

test('buildQuoteUrl returns a 200-JSON quote endpoint URL for bridge-safe discovery', () => {
  const config = baseConfig({ argv: ['--policy', 'insurance_review'] });

  assert.equal(
    buildQuoteUrl(config),
    `https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=${ASSET_ADDRESS}&policy=insurance_review`
  );
});

test('buildTargetUrl supports the investor-report, score, verify, and by-mint routes', () => {
  assert.equal(
    buildTargetUrl(baseConfig({ argv: ['--route', 'catalog'] })),
    'https://anchora.markets/api/x402/v1/catalog'
  );
  assert.equal(
    buildTargetUrl(baseConfig({ argv: ['--route', 'score'] })),
    `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/score`
  );
  assert.equal(
    buildTargetUrl(baseConfig({ argv: ['--route', 'investor-report'] })),
    `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/investor-report`
  );
  assert.equal(
    buildTargetUrl(baseConfig({ argv: ['--route', 'verify', '--tx-signature', '5tx'] })),
    'https://anchora.markets/api/x402/v1/verify/5tx'
  );
  assert.equal(
    buildTargetUrl(baseConfig({ argv: ['--route', 'by-mint', '--mint', DEFAULT_USDC_MINT] })),
    `https://anchora.markets/api/x402/v1/assets/by-mint/${DEFAULT_USDC_MINT}`
  );
});

test('validatePaymentRequirement fails closed on recipient, mint, origin, resource, and amount drift', () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;

  assert.deepEqual(
    validatePaymentRequirement(validRequirement(targetUrl), {
      expectedUrl: targetUrl,
      expectedPayTo: DEFAULT_PAY_TO,
      expectedUsdcMint: DEFAULT_USDC_MINT,
      expectedNetwork: 'solana-devnet',
      maxAtomicAmount: '50000',
    }),
    { ok: true, errors: [] }
  );

  const invalid = validatePaymentRequirement(
    validRequirement('https://evil.example/api/x402/v1/assets/a/proof-package', {
      asset: 'fake-usdc',
      payTo: 'Attacker1111111111111111111111111111111111',
      maxAmountRequired: '50001',
    }),
    {
      expectedUrl: targetUrl,
      expectedPayTo: DEFAULT_PAY_TO,
      expectedUsdcMint: DEFAULT_USDC_MINT,
      expectedNetwork: 'solana-devnet',
      maxAtomicAmount: '50000',
    }
  );

  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /payTo/);
  assert.match(invalid.errors.join('\n'), /asset/);
  assert.match(invalid.errors.join('\n'), /resource/);
  assert.match(invalid.errors.join('\n'), /exceeds cap/);
});

test('selectPaymentRequirement prefers Solana exact requirements from accepts or paymentRequirements', () => {
  const requirement = validRequirement('https://anchora.markets/api/x402/v1/verify/tx');

  assert.equal(selectPaymentRequirement({ accepts: [{ scheme: 'other' }, requirement] }), requirement);
  assert.equal(selectPaymentRequirement({ paymentRequirements: [requirement] }), requirement);
  assert.equal(selectPaymentRequirement({ accepts: [{ scheme: 'exact', network: 'base' }] }), null);
});

test('buildSignerRequest sends signer only bounded payment context, not secrets', () => {
  const config = baseConfig();
  const targetUrl = buildTargetUrl(config);
  const requirement = validRequirement(targetUrl);
  const request = buildSignerRequest({
    config,
    quoteBody: { x402Version: 1 },
    requirement,
    targetUrl,
    paymentIdentifier: 'anchora_20260430_00112233445566778899aabb',
  });

  assert.equal(request.type, 'x402.sign');
  assert.equal(request.context.expected.payTo, DEFAULT_PAY_TO);
  assert.equal(request.extensions['payment-identifier'].info.id, 'anchora_20260430_00112233445566778899aabb');
  assert.equal(JSON.stringify(request).includes('SIGNER_TOKEN'), false);
});

test('buildConfig can route payment signing through a local agent wallet', () => {
  const config = baseConfig({ argv: ['--agent-wallet', 'default'] });
  const signerCommand = JSON.parse(config.signerCommand);

  assert.equal(signerCommand.at(-3), 'sign-x402');
  assert.equal(signerCommand.at(-2), '--wallet');
  assert.equal(signerCommand.at(-1), 'default');
});

test('buildConfig accepts devnet x402 mint from server env naming', () => {
  const devnetMint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const config = baseConfig({
    env: {
      X402_SOLANA_USDC_MINT: devnetMint,
      X402_SOLANA_PAY_TO: DEFAULT_PAY_TO,
    },
  });

  assert.equal(config.expectedUsdcMint, devnetMint);
  assert.equal(config.expectedPayTo, DEFAULT_PAY_TO);
});

test('normalizeSignerResponse requires matching payment-identifier inside X-PAYMENT', () => {
  const expectedId = 'anchora_20260430_00112233445566778899aabb';
  const xPayment = encodePayment({
    extensions: {
      'payment-identifier': {
        info: { required: false, id: expectedId },
      },
    },
    payload: { authorization: { from: 'payer' } },
  });

  assert.deepEqual(
    normalizeSignerResponse({ xPayment, paymentIdentifier: expectedId, payerAddress: 'payer' }, expectedId),
    { xPayment, payerAddress: 'payer' }
  );

  assert.throws(
    () => normalizeSignerResponse({ xPayment: encodePayment({ extensions: {} }) }, expectedId),
    /expected payment-identifier/
  );
});

test('buildFacilitatorSettleRequest decodes helper-produced X-PAYMENT without manual header rebuilding', () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const requirement = validRequirement(targetUrl);
  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    payload: { transaction: 'signed-solana-transaction' },
    extensions: {
      'payment-identifier': {
        info: { required: false, id: 'anchora_20260430_00112233445566778899aabb' },
      },
    },
  };
  const request = buildFacilitatorSettleRequest(encodePayment(paymentPayload), requirement);

  assert.deepEqual(request, {
    paymentPayload,
    paymentRequirements: requirement,
  });
});

test('resolveSignerUrl appends the default path and rejects non-local http signers', () => {
  assert.equal(
    resolveSignerUrl('https://wallet.example'),
    'https://wallet.example/v1/x402/sign'
  );
  assert.equal(
    resolveSignerUrl('http://localhost:8787'),
    'http://localhost:8787/v1/x402/sign'
  );
  assert.throws(() => resolveSignerUrl('http://wallet.example'), /https outside localhost/);
});

test('callCommandSigner returns sanitized signer failures', async () => {
  const signerCommand = JSON.stringify([
    process.execPath,
    '-e',
    'console.error(JSON.stringify({ok:false,error:"no funds",secretKey:[1,2,3],xPayment:"secret-header",details:{transaction:"signed-tx",logs:["safe"]}})); process.exit(2)',
  ]);

  await assert.rejects(
    () => callCommandSigner({ signerCommand, payload: { hello: 'world' }, timeoutMs: 1_000 }),
    error => {
      assert.equal(error.details.signerError.error, 'no funds');
      assert.equal(error.details.signerError.secretKey, '[redacted]');
      assert.equal(error.details.signerError.xPayment, '[redacted]');
      assert.equal(error.details.signerError.details.transaction, '[redacted]');
      assert.deepEqual(error.details.signerError.details.logs, ['safe']);
      return true;
    }
  );
});

test('buildPaymentIdentifier matches the server payment-identifier shape', () => {
  assert.equal(
    buildPaymentIdentifier(new Date('2026-04-30T00:00:00Z'), Buffer.from('00112233445566778899aabb', 'hex')),
    'anchora_20260430_00112233445566778899aabb'
  );
});

test('runAgentPayment fetches the free catalog without a signer', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://anchora.markets/api/x402/v1/catalog');
    return new Response(
      JSON.stringify({
        name: 'Anchora x402 Agent API',
        x402Version: 1,
        baseUrl: 'https://anchora.markets/api/x402/v1',
        settlement: {
          scheme: 'exact',
          network: 'solana-devnet',
          asset: 'USDC',
          payTo: DEFAULT_PAY_TO,
          mode: 'direct-solana',
          ready: true,
          detail: 'x402 direct Solana facilitator mode is enabled.',
          facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
        },
        idempotency: {
          extension: 'payment-identifier',
          required: false,
          ttlSeconds: 600,
        },
        routes: [
          {
            routeId: 'proofPackage',
            method: 'GET',
            pathTemplate: '/api/x402/v1/assets/{asset_address}/proof-package',
            priceUsd: 0.05,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const result = await runAgentPayment(baseConfig({ argv: ['--route', 'catalog'] }));
    assert.equal(result.ok, true);
    assert.equal(result.paymentRequired, false);
    assert.equal(result.body.settlement.ready, true);
    assert.equal(result.body.settlement.facilitatorUrl, 'https://api.cdp.coinbase.com/platform/v2/x402');
    assert.equal(result.body.routes[0].routeId, 'proofPackage');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runAgentPayment treats quote-only validation as a successful dry run', async () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const catalogUrl = 'https://anchora.markets/api/x402/v1/catalog';
  const quoteUrl = `https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=${ASSET_ADDRESS}&policy=collateral_screening`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url) === catalogUrl) {
      return new Response(
        JSON.stringify({
          name: 'Anchora x402 Agent API',
          settlement: {
            mode: 'direct-solana',
            ready: true,
            detail: 'x402 direct Solana facilitator mode is enabled.',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    assert.equal(String(url), quoteUrl);
    return new Response(JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await runAgentPayment(baseConfig());
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.quoteValidated, true);
    assert.equal(result.paymentRequired, true);
    assert.equal(result.quoteSource, 'quote-endpoint');
    assert.equal(result.requirement.payTo, DEFAULT_PAY_TO);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runAgentPayment falls back to HTTP 402 quote when quote endpoint is unavailable', async () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const catalogUrl = 'https://anchora.markets/api/x402/v1/catalog';
  const quoteUrl = `https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=${ASSET_ADDRESS}&policy=collateral_screening`;
  const previousFetch = globalThis.fetch;
  const seen = [];

  globalThis.fetch = async url => {
    seen.push(String(url));
    if (String(url) === catalogUrl) {
      return new Response(
        JSON.stringify({
          name: 'Anchora x402 Agent API',
          settlement: { mode: 'direct-solana', ready: true, detail: 'ready' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (String(url) === quoteUrl) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    assert.equal(String(url), targetUrl);
    return new Response(JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await runAgentPayment(baseConfig());
    assert.equal(result.ok, true);
    assert.equal(result.quoteSource, 'http-402');
    assert.deepEqual(seen, [catalogUrl, quoteUrl, targetUrl]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runAgentPayment checks payment status without x402 payment', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(
      String(url),
      'https://anchora.markets/api/x402/v1/payments/anchora_20260512_00112233445566778899aabb/status'
    );
    return new Response(
      JSON.stringify({
        paymentIdentifier: 'anchora_20260512_00112233445566778899aabb',
        status: 'settled',
        settlementTransaction: 'settlement-tx',
        settledAt: '2026-05-12T10:00:00.000Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    const result = await runAgentPayment(baseConfig({
      argv: ['--check-payment', 'anchora_20260512_00112233445566778899aabb'],
    }));
    assert.equal(result.ok, true);
    assert.equal(result.paymentRequired, false);
    assert.equal(result.body.status, 'settled');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runAgentPayment retries once on structured pre-send blockhash expiry', async () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const catalogUrl = 'https://anchora.markets/api/x402/v1/catalog';
  const quoteUrl = `https://anchora.markets/api/x402/v1/quote?route=proof-package&asset_address=${ASSET_ADDRESS}&policy=collateral_screening`;
  const signerScript = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      const id = request.extensions['payment-identifier'].info.id;
      const payload = {
        extensions: { 'payment-identifier': { info: { required: false, id } } },
        payload: { authorization: { from: 'payer' } }
      };
      process.stdout.write(JSON.stringify({
        xPayment: Buffer.from(JSON.stringify(payload)).toString('base64'),
        paymentIdentifier: id,
        payerAddress: 'payer'
      }));
    });
  `;
  const previousFetch = globalThis.fetch;
  const seen = [];

  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), hasPayment: Boolean(init.headers?.['X-PAYMENT']) });
    if (String(url) === catalogUrl) {
      return new Response(
        JSON.stringify({
          name: 'Anchora x402 Agent API',
          settlement: { mode: 'direct-solana', ready: true, detail: 'ready' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (String(url) === quoteUrl) {
      return new Response(JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    assert.equal(String(url), targetUrl);
    if (!init.headers?.['X-PAYMENT']) {
      return new Response(JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }

    const paidAttempt = seen.filter(entry => entry.url === targetUrl && entry.hasPayment).length;
    if (paidAttempt === 1) {
      return new Response(
        JSON.stringify({
          error: 'blockhash_expired',
          phase: 'verify',
          retryable: true,
          detail: 'Solana blockhash expired during pre-send verification',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, asset: { assetId: 'A1' } }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-payment-response': JSON.stringify({ success: true, transaction: 'settlement-tx' }),
        },
      }
    );
  };

  try {
    const result = await runAgentPayment(baseConfig({
      argv: [
        '--execute-payment',
        '--signer-cmd',
        JSON.stringify([process.execPath, '-e', signerScript]),
      ],
    }));
    assert.equal(result.ok, true);
    assert.equal(result.retries.length, 1);
    assert.deepEqual(result.retries[0], {
      reason: 'blockhash_expired',
      phase: 'verify',
      status: 402,
    });
    assert.equal(seen.filter(entry => entry.url === targetUrl && entry.hasPayment).length, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runOfflineAgentPayment builds a signer request from a saved quote without network fetches', async () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const dir = mkdtempSync(join(tmpdir(), 'anchora-x402-offline-'));
  const quoteFile = join(dir, 'quote.json');
  writeFileSync(quoteFile, JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }));
  const config = baseConfig({
    argv: [
      '--offline-context-plan',
      '--quote-file',
      quoteFile,
      '--payment-identifier',
      'anchora_20260430_00112233445566778899aabb',
    ],
  });

  const result = await runOfflineAgentPayment(config);

  assert.equal(result.ok, true);
  assert.equal(result.offlineContextPlan, true);
  assert.equal(result.signerRequest.type, 'x402.sign');
  assert.equal(result.signerRequest.paymentRequirements.resource, targetUrl);
  assert.equal(
    result.signerRequest.extensions['payment-identifier'].info.id,
    'anchora_20260430_00112233445566778899aabb'
  );
});

test('runOfflineAgentPayment returns bridge-safe facilitator settle instructions after signing', async () => {
  const targetUrl = `https://anchora.markets/api/x402/v1/assets/${ASSET_ADDRESS}/proof-package?policy=collateral_screening`;
  const dir = mkdtempSync(join(tmpdir(), 'anchora-x402-offline-sign-'));
  const quoteFile = join(dir, 'quote.json');
  writeFileSync(quoteFile, JSON.stringify({ x402Version: 1, accepts: [validRequirement(targetUrl)] }));
  const signerScript = `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      const id = request.extensions['payment-identifier'].info.id;
      const payload = {
        x402Version: 1,
        scheme: 'exact',
        network: request.paymentRequirements.network,
        payload: { transaction: 'signed-solana-transaction' },
        extensions: { 'payment-identifier': { info: { required: false, id } } }
      };
      process.stdout.write(JSON.stringify({
        xPayment: Buffer.from(JSON.stringify(payload)).toString('base64'),
        paymentIdentifier: id,
        payerAddress: 'payer'
      }));
    });
  `;
  const config = baseConfig({
    argv: [
      '--offline-sign',
      '--quote-file',
      quoteFile,
      '--payment-identifier',
      'anchora_20260430_00112233445566778899aabb',
      '--signer-cmd',
      JSON.stringify([process.execPath, '-e', signerScript]),
    ],
  });

  const result = await runOfflineAgentPayment(config);

  assert.equal(result.ok, true);
  assert.equal(result.offlineSign, true);
  assert.equal(result.facilitatorSettle.url, 'https://anchora.markets/api/x402/facilitator/settle');
  assert.equal(result.facilitatorSettle.method, 'POST');
  assert.equal(result.facilitatorSettle.body.paymentPayload.payload.transaction, 'signed-solana-transaction');
  assert.deepEqual(result.facilitatorSettle.body.paymentRequirements, validRequirement(targetUrl));
  assert.equal(
    result.paymentStatus.url,
    'https://anchora.markets/api/x402/v1/payments/anchora_20260430_00112233445566778899aabb/status'
  );
  assert.equal(Array.isArray(result.next), true);
});

test('runAgentPayment refuses to sign when catalog settlement is not ready', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://anchora.markets/api/x402/v1/catalog');
    return new Response(
      JSON.stringify({
        name: 'Anchora x402 Agent API',
        settlement: {
          mode: 'cdp',
          ready: false,
          detail: 'x402 CDP mainnet facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET.',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    await assert.rejects(
      () => runAgentPayment(baseConfig()),
      error => {
        assert.match(error.message, /settlement is not ready/);
        assert.equal(error.details.settlement.ready, false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
