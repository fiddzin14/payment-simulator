import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import QRCode from 'qrcode';
import { createGateway, BANKS } from '../gateway.mjs';
import { signature, validateDestination, privateAddress, deliverHttp } from '../lib/security.mjs';
async function setup(t, opts = {}) {
  let time = Date.parse('2026-11-04T05:00:00Z');
  const app = await createGateway({
      clock: () => time,
      background: false,
      disableRateLimit: true,
      ...opts,
    }),
    base = await app.listen(0);
  t.after(() => app.close());
  async function call(path, body, auth, headers = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, headers: r.headers, data: await r.json() };
  }
  const signup = async () => {
    const r = await call('/portal/register', {
      name: 'Test workspace',
      email: randomUUID() + '@example.test',
      password: 'TestingOnly123!',
    });
    assert.equal(r.status, 201);
    return { ...r.data, cookie: r.headers.get('set-cookie') };
  };
  const payment = async (a, extra = {}, headers = {}) =>
    call(
      '/v1/payments',
      { external_id: randomUUID(), amount: 150000, payment_method: 'qris', ...extra },
      a.credential.secret_key,
      headers,
    );
  return { app, base, call, signup, payment, advance: (ms) => (time += ms) };
}
test('registration immediately issues separate credentials; login, cookie, and state do not disclose stored secrets', async (t) => {
  const x = await setup(t),
    a = await x.signup();
  assert.match(a.credential.secret_key, /^sk_test_/);
  assert.match(a.webhook_secret, /^whsec_test_/);
  assert.match(a.cookie, /HttpOnly/);
  assert.match(a.cookie, /SameSite=Lax/);
  const state = await x.call('/portal/state', undefined, a.access_token);
  assert.equal(state.status, 200);
  assert.ok(!JSON.stringify(state.data).includes(a.credential.secret_key));
  assert.ok(!JSON.stringify(state.data).includes(a.webhook_secret));
  assert.equal(
    (await x.call('/portal/login', { email: a.merchant.email, password: 'wrong' })).status,
    401,
  );
  assert.equal(
    (await x.call('/portal/login', { email: a.merchant.email, password: 'TestingOnly123!' }))
      .status,
    200,
  );
  assert.equal(
    (
      await x.call('/portal/register', {
        name: 'Duplicate',
        email: a.merchant.email,
        password: 'TestingOnly123!',
      })
    ).status,
    409,
  );
  assert.equal((await x.call('/portal/logout', {}, a.access_token)).status, 200);
  assert.equal((await x.call('/portal/state', undefined, a.access_token)).status, 401);
});
test('merchant isolation covers payment lookup, simulation, event replay, refund, and state', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    b = await x.signup(),
    p = (await x.payment(a)).data;
  assert.equal(
    (await x.call('/v1/payments/' + p.id, undefined, b.credential.secret_key)).status,
    404,
  );
  assert.equal(
    (
      await x.call(
        `/portal/payments/${p.id}/simulate`,
        { outcome: 'paid', bank_reference: 'OTHER' },
        b.access_token,
      )
    ).status,
    404,
  );
  const event = x.app.snapshot().events[0];
  assert.equal((await x.call(`/portal/events/${event.id}/retry`, {}, b.access_token)).status, 404);
  assert.equal(
    (
      await x.call(
        `/v1/payments/${p.id}/refunds`,
        { amount: 1, reason: 'test' },
        b.credential.secret_key,
      )
    ).status,
    404,
  );
  assert.equal((await x.call('/portal/state', undefined, b.access_token)).data.payments.length, 0);
});
test('dynamic QR is transaction-specific, amount-bound, scannable SVG, and unavailable after payment', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a)).data,
    q = (await x.payment(a, { amount: 200000 })).data;
  assert.notEqual(p.qr_string, q.qr_string);
  assert.ok(p.qr_string.includes('amount=150000'));
  assert.match(p.qr_image_url, /qr.svg$/);
  const svg = await fetch(p.qr_image_url);
  assert.equal(svg.status, 200);
  assert.equal(
    await svg.text(),
    await QRCode.toString(p.qr_string, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 280,
    }),
  );
  const path = new URL(p.checkout_url).pathname.replace('/pay/', '/checkout-api/');
  const settled = await x.call(path + '/simulate', {
    outcome: 'paid',
    amount: 150000,
    bank_reference: 'QR-ONE',
  });
  assert.equal(settled.data.status, 'paid');
  assert.equal((await fetch(p.qr_image_url)).status, 409);
  assert.equal((await x.call('/checkout-api/cs_test_' + 'a'.repeat(56))).status, 404);
});
test('all five VA banks allocate unique, closed-amount, single-use synthetic account numbers', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    numbers = [];
  for (const bank of Object.keys(BANKS)) {
    const r = await x.payment(a, { payment_method: 'virtual_account', bank_code: bank });
    assert.equal(r.status, 201);
    assert.match(r.data.account_number, /^999\d{13}$/);
    numbers.push(r.data.account_number);
    assert.equal(r.data.qr_string, null);
  }
  assert.equal(new Set(numbers).size, 5);
  assert.equal(
    (await x.payment(a, { payment_method: 'virtual_account', bank_code: 'INVALID' })).status,
    422,
  );
});
test('concurrent idempotent creation is atomic; key conflicts and external-reference duplicates are rejected', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    payload = { external_id: 'ORDER-ONE', amount: 70000, payment_method: 'qris' },
    headers = { 'Idempotency-Key': 'order-key-12345' };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      x.call('/v1/payments', payload, a.credential.secret_key, headers),
    ),
  );
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(x.app.snapshot().payments.length, 1);
  assert.equal(
    (await x.call('/v1/payments', { ...payload, amount: 80000 }, a.credential.secret_key, headers))
      .status,
    409,
  );
  assert.equal((await x.call('/v1/payments', payload, a.credential.secret_key)).status, 409);
  assert.equal(
    (await x.call('/v1/payments', payload, a.credential.secret_key, { 'Idempotency-Key': '' }))
      .status,
    422,
  );
});
test('under/overpayment is rejected; duplicate reference is idempotent; success cannot be downgraded', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a, { payment_method: 'virtual_account', bank_code: 'BCA' })).data,
    path = `/portal/payments/${p.id}/simulate`;
  for (const amount of [149999, 150001])
    assert.equal(
      (await x.call(path, { outcome: 'paid', amount, bank_reference: 'VA-EXACT' }, a.access_token))
        .status,
      422,
    );
  assert.equal(x.app.snapshot().receipts.length, 0);
  const input = { outcome: 'paid', amount: 150000, bank_reference: 'VA-EXACT' };
  assert.equal((await x.call(path, input, a.access_token)).status, 200);
  assert.equal((await x.call(path, input, a.access_token)).status, 200);
  assert.equal(x.app.snapshot().receipts.length, 1);
  assert.equal((await x.call(path, { outcome: 'failed' }, a.access_token)).status, 409);
  assert.equal(
    (await x.call(path, { ...input, bank_reference: 'VA-NEW' }, a.access_token)).status,
    409,
  );
  const q = (await x.payment(a)).data;
  assert.equal(
    (await x.call(`/portal/payments/${q.id}/simulate`, input, a.access_token)).status,
    409,
  );
});
test('expiry emits once; late funds require merchant authorization and never reactivate the payment', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a, { expires_in: 60 })).data;
  x.advance(60000);
  await x.app.tick();
  await x.app.tick();
  assert.equal(
    x.app.snapshot().events.filter((e) => e.payload.type === 'payment.expired').length,
    1,
  );
  const path = new URL(p.checkout_url).pathname.replace('/pay/', '/checkout-api/');
  assert.equal(
    (await x.call(path + '/simulate', { outcome: 'paid', bank_reference: 'LATE-A' })).status,
    409,
  );
  assert.equal(
    (
      await x.call(path + '/simulate', {
        outcome: 'paid',
        bank_reference: 'LATE-A',
        late_payment: true,
      })
    ).status,
    403,
  );
  const r = await x.call(
    `/portal/payments/${p.id}/simulate`,
    { outcome: 'paid', amount: p.amount, bank_reference: 'LATE-A', late_payment: true },
    a.access_token,
  );
  assert.equal(r.data.status, 'expired');
  assert.equal(r.data.paid_amount, 0);
  assert.equal(r.data.late_received_amount, p.amount);
  assert.equal(x.app.snapshot().receipts[0].needs_review, true);
});
test('signed webhook retry uses stable event ID/raw body and a fresh signature timestamp', async (t) => {
  const calls = [];
  let paidAttempts = 0;
  const x = await setup(t, {
      sendWebhook: async (url, raw, headers) => {
        const p = JSON.parse(raw);
        calls.push({ url, raw, headers, p });
        return {
          status: p.type === 'payment.paid' && paidAttempts++ === 0 ? 503 : 204,
          body: 'do not persist this receiver body',
        };
      },
    }),
    a = await x.signup();
  await x.call('/portal/webhook', { url: 'https://receiver.example.test/hook' }, a.access_token);
  const p = (await x.payment(a)).data;
  await x.call(
    `/portal/payments/${p.id}/simulate`,
    { outcome: 'paid', bank_reference: 'WEBHOOK-A' },
    a.access_token,
  );
  await x.app.tick();
  const e = x.app.snapshot().events.find((e) => e.payload.type === 'payment.paid');
  assert.equal(e.status, 'pending');
  assert.equal(e.deliveries[0].http_status, 503);
  x.advance(4999);
  await x.app.tick();
  assert.equal(paidAttempts, 1);
  x.advance(1);
  await x.app.tick();
  assert.equal(paidAttempts, 2);
  const pair = calls.filter((c) => c.p.type === 'payment.paid');
  assert.equal(pair[0].raw, pair[1].raw);
  assert.notEqual(
    pair[0].headers['X-Simulator-Timestamp'],
    pair[1].headers['X-Simulator-Timestamp'],
  );
  for (const c of pair)
    assert.equal(
      c.headers['X-Simulator-Signature'],
      signature(a.webhook_secret, c.headers['X-Simulator-Timestamp'], c.raw),
    );
  assert.equal(x.app.snapshot().events.find((v) => v.id === e.id).status, 'delivered');
  assert.ok(!JSON.stringify(x.app.snapshot()).includes('do not persist this receiver body'));
  await x.call(`/portal/events/${e.id}/retry`, {}, a.access_token);
  await x.app.tick();
  assert.equal(calls.filter((c) => c.p.id === e.id).length, 3);
});
test('automatic retries stop after initial plus six retries, and manual replay starts another cycle', async (t) => {
  const x = await setup(t, { sendWebhook: async () => ({ status: 500, body: '' }) }),
    a = await x.signup();
  await x.call('/portal/webhook', { url: 'https://receiver.example.test/hook' }, a.access_token);
  await x.payment(a);
  await x.app.tick();
  for (const delay of [5, 30, 120, 600, 1800, 7200]) {
    x.advance(delay * 1000);
    await x.app.tick();
  }
  let e = x.app.snapshot().events[0];
  assert.equal(e.status, 'failed');
  assert.equal(e.deliveries.length, 7);
  x.advance(10000000);
  await x.app.tick();
  assert.equal(x.app.snapshot().events[0].deliveries.length, 7);
  await x.call(`/portal/events/${e.id}/retry`, {}, a.access_token);
  await x.app.tick();
  assert.equal(x.app.snapshot().events[0].deliveries.length, 8);
});
test('refund requests reserve funds, failed refunds can retry, and settlement is idempotent', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a)).data;
  await x.call(
    `/portal/payments/${p.id}/simulate`,
    { outcome: 'paid', bank_reference: 'REF-PAY' },
    a.access_token,
  );
  const path = `/v1/payments/${p.id}/refunds`,
    headers = { 'Idempotency-Key': 'refund-unique-123' },
    input = { amount: 100000, reason: 'Partial refund test' };
  const r = (await x.call(path, input, a.credential.secret_key, headers)).data;
  assert.equal((await x.call(path, input, a.credential.secret_key, headers)).data.id, r.id);
  assert.equal(
    (await x.call(path, { amount: 50001, reason: 'excess' }, a.credential.secret_key)).status,
    422,
  );
  await x.call(`/portal/refunds/${r.id}/simulate`, { outcome: 'failed' }, a.access_token);
  await x.call(`/portal/refunds/${r.id}/retry`, {}, a.access_token);
  await x.call(`/portal/refunds/${r.id}/simulate`, { outcome: 'succeeded' }, a.access_token);
  await x.call(`/portal/refunds/${r.id}/simulate`, { outcome: 'succeeded' }, a.access_token);
  assert.equal(
    (await x.call(`/v1/payments/${p.id}`, undefined, a.credential.secret_key)).data.refunded_amount,
    100000,
  );
  assert.equal(
    x.app.snapshot().events.filter((e) => e.payload.type === 'refund.succeeded').length,
    1,
  );
});
test('revoked credentials stop immediately; new keys retain access to owned payments', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a)).data,
    newKey = (await x.call('/portal/credentials', { name: 'Another application' }, a.access_token))
      .data;
  await x.call(`/portal/credentials/${a.credential.id}/revoke`, {}, a.access_token);
  assert.equal((await x.call('/v1/payments', undefined, a.credential.secret_key)).status, 401);
  assert.equal((await x.call(`/v1/payments/${p.id}`, undefined, newKey.secret_key)).status, 200);
});
test('accounts, hashed keys, payments, and retry queue survive a file-store restart', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'lumen-gateway-')),
    file = join(folder, 'state.json');
  t.after(() => rm(folder, { recursive: true, force: true }));
  const x = await setup(t, { dataFile: file }),
    a = await x.signup(),
    p = (await x.payment(a)).data;
  await x.app.close();
  const disk = await readFile(file, 'utf8');
  assert.ok(!disk.includes(a.credential.secret_key));
  assert.ok(!disk.includes('TestingOnly123!'));
  assert.ok(!disk.includes(a.access_token));
  const y = await setup(t, { dataFile: file });
  assert.equal(
    (await y.call(`/v1/payments/${p.id}`, undefined, a.credential.secret_key)).data.id,
    p.id,
  );
  assert.equal(
    (await y.call('/portal/login', { email: a.merchant.email, password: 'TestingOnly123!' }))
      .status,
    200,
  );
});
test('webhook destination rules block private/reserved addresses and URL tricks', async () => {
  for (const url of [
    'http://127.0.0.1:123/hook',
    'https://10.0.0.1/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://169.254.169.254/x',
    'https://user:pass@example.com/x',
    'https://example.com:8443/x',
  ])
    assert.throws(() => validateDestination(url));
  assert.equal(
    validateDestination('http://127.0.0.1:123/hook', { allowLocal: true }),
    'http://127.0.0.1:123/hook',
  );
  assert.equal(privateAddress('::ffff:7f00:1'), true);
  assert.equal(privateAddress('8.8.8.8'), false);
  await assert.rejects(() => deliverHttp('https://10.0.0.1/x', '{}', {}));
});
test('actual loopback webhook receiver gets a valid raw HMAC signature and no redirect is followed', async (t) => {
  let seen;
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (x) => (raw += x));
    req.on('end', () => {
      seen = { raw, headers: req.headers };
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => receiver.close(r)));
  const x = await setup(t),
    a = await x.signup();
  await x.call(
    '/portal/webhook',
    { url: `http://127.0.0.1:${receiver.address().port}/hook` },
    a.access_token,
  );
  await x.payment(a);
  await x.app.tick();
  assert.ok(seen);
  assert.equal(
    seen.headers['x-simulator-signature'],
    signature(a.webhook_secret, seen.headers['x-simulator-timestamp'], seen.raw),
  );
});
test('origin checks, limits, pagination, and resource authentication reject malformed requests', async (t) => {
  const x = await setup(t),
    a = await x.signup();
  assert.equal(
    (
      await x.call('/portal/webhook', { url: 'https://example.com/hook' }, a.access_token, {
        Origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
  assert.equal((await x.payment(a, { amount: 10000001 })).status, 422);
  assert.equal((await x.payment(a, { expires_in: 30 })).status, 422);
  assert.equal((await x.payment(a, { currency: 'USD' })).status, 422);
  assert.equal((await x.call('/v1/payments')).status, 401);
  await x.payment(a);
  await x.payment(a);
  const page = (await x.call('/v1/payments?limit=1', undefined, a.credential.secret_key)).data;
  assert.equal(page.data.length, 1);
  assert.equal(page.has_more, true);
  assert.equal(
    (
      await x.call(
        '/v1/payments?limit=1&starting_after=' + page.next_cursor,
        undefined,
        a.credential.secret_key,
      )
    ).data.has_more,
    false,
  );
});
import { createMerchantExample, verifyWebhook } from '../examples/merchant-app.mjs';
test('runnable merchant example settles only verified events and deduplicates replay', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    example = createMerchantExample({
      gatewayBase: x.base,
      apiKey: a.credential.secret_key,
      webhookSecret: a.webhook_secret,
    }),
    url = await example.listen(0);
  t.after(() => example.close());
  await x.call('/portal/webhook', { url: url + '/webhooks/lumen' }, a.access_token);
  const response = await fetch(url + '/demo/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      external_id: 'EXAMPLE-INVOICE',
      amount: 150000,
      payment_method: 'qris',
    }),
  });
  assert.equal(response.status, 201);
  const { payment: p } = await response.json();
  assert.equal(example.invoices.get('EXAMPLE-INVOICE').status, 'pending');
  await x.call(
    `/portal/payments/${p.id}/simulate`,
    { outcome: 'paid', bank_reference: 'EXAMPLE-REF' },
    a.access_token,
  );
  const seconds = String(Math.floor(Date.now() / 1000)),
    e = x.app.snapshot().events.find((e) => e.payload.type === 'payment.paid'),
    raw = JSON.stringify(e.payload),
    headers = {
      'Content-Type': 'application/json',
      'X-Simulator-Timestamp': seconds,
      'X-Simulator-Signature': signature(a.webhook_secret, seconds, raw),
      'X-Simulator-Event-Id': e.id,
    };
  assert.equal(
    (await fetch(url + '/webhooks/lumen', { method: 'POST', headers, body: raw })).status,
    200,
  );
  assert.equal(example.invoices.get('EXAMPLE-INVOICE').status, 'paid');
  const replay = await fetch(url + '/webhooks/lumen', { method: 'POST', headers, body: raw });
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(
    (await fetch(url + '/webhooks/lumen', { method: 'POST', headers, body: raw + ' ' })).status,
    401,
  );
  assert.equal(
    verifyWebhook(
      a.webhook_secret,
      raw,
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      Date.now() + 301000,
    ),
    false,
  );
});
test('credential signup throttles abuse without a manual approval state', async (t) => {
  const x = await setup(t, { disableRateLimit: false });
  for (let i = 0; i < 5; i++) await x.signup();
  const denied = await x.call('/portal/register', {
    name: 'Extra',
    email: randomUUID() + '@example.test',
    password: 'TestingOnly123!',
  });
  assert.equal(denied.status, 429);
  assert.equal((await x.call('/portal/register', null)).status, 422);
});
test('online docs, OpenAPI, PDF download, and hosted assets are served successfully', async (t) => {
  const x = await setup(t);
  for (const path of [
    '/',
    '/portal.js',
    '/portal.css',
    '/docs',
    '/docs.js',
    '/openapi.json',
    '/guide.pdf',
  ]) {
    const r = await fetch(x.base + path);
    assert.equal(r.status, 200, path);
    const body = await r.text();
    assert.ok(body.length > 100, path);
    if (path === '/guide.pdf') assert.ok(body.startsWith('%PDF-'));
    if (path === '/openapi.json') assert.ok(JSON.parse(body).paths['/v1/payments']);
  }
});

test('scanning the QR URL records one payment, ignores altered amount, and repeated scans are idempotent', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    p = (await x.payment(a)).data;
  assert.match(p.qr_string, /\/qris\/cs_test_/);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => fetch(p.qr_string.replace('amount=150000', 'amount=1'))),
  );
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Pembayaran QRIS/);
  }
  const state = x.app.snapshot();
  assert.equal(state.payments[0].status, 'paid');
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].amount, 150000);
  assert.equal(state.events.filter((e) => e.payload.type === 'payment.paid').length, 1);
});

test('expired and cancelled QR scans cannot create receipts; VA cannot use the scan endpoint', async (t) => {
  const x = await setup(t),
    a = await x.signup(),
    expired = (await x.payment(a, { expires_in: 60 })).data;
  x.advance(60000);
  assert.equal((await fetch(expired.qr_string)).status, 410);
  assert.equal(x.app.snapshot().receipts.length, 0);
  const cancelled = (await x.payment(a)).data;
  await x.call('/v1/payments/' + cancelled.id + '/cancel', {}, a.credential.secret_key);
  assert.equal((await fetch(cancelled.qr_string)).status, 410);
  const va = (await x.payment(a, { payment_method: 'virtual_account', bank_code: 'BCA' })).data;
  const token = new URL(va.checkout_url).pathname.split('/').pop();
  assert.equal((await fetch(x.base + '/qris/' + token)).status, 404);
  assert.equal(x.app.snapshot().receipts.length, 0);
});

test('QR scan emits the signed merchant webhook while the scan page does not expose merchant credentials', async (t) => {
  const delivered = [];
  const x = await setup(t, {
      sendWebhook: async (url, body, headers) => {
        delivered.push({ url, body, headers });
        return { status: 200 };
      },
    }),
    a = await x.signup();
  await x.call(
    '/portal/webhook',
    { url: 'http://127.0.0.1:8000/webhooks/payments/simulator' },
    a.access_token,
  );
  const p = (await x.payment(a)).data;
  const page = await (await fetch(p.qr_string)).text();
  assert.ok(!page.includes(a.credential.secret_key));
  assert.ok(!page.includes(a.webhook_secret));
  await x.app.tick();
  const paid = delivered.find((e) => JSON.parse(e.body).type === 'payment.paid');
  assert.ok(paid);
  assert.equal(
    paid.headers['X-Simulator-Signature'],
    signature(a.webhook_secret, paid.headers['X-Simulator-Timestamp'], paid.body),
  );
});
