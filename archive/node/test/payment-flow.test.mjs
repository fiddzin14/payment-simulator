import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSimulator, signWebhook } from '../server.mjs';

const CONTROL = 'test-control-key',
  MERCHANT = 'test-merchant-key',
  SECRET = 'test-webhook-secret';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9kAAAAASUVORK5CYII=';
async function setup(t, options = {}) {
  const app = createSimulator({
    controlKey: CONTROL,
    merchantKey: MERCHANT,
    webhookSecret: SECRET,
    ...options,
  });
  const base = await app.listen(0);
  t.after(() => app.close());
  async function request(path, body, extra = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Control-Key': CONTROL,
        'Idempotency-Key': randomUUID(),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const order = async (amount = 1000000, deposit = 500000) =>
    (
      await request('/api/orders', {
        client_label: 'Synthetic test',
        total_amount: amount,
        deposit_amount: deposit,
      })
    ).data;
  const attempt = async (order, method = 'gateway', amount = 500000) =>
    (await request(`/api/orders/${order.id}/attempts`, { method, amount })).data;
  const state = async () => (await request('/api/state')).data;
  const simulate = (attempt, status, extra = {}) =>
    request(`/api/attempts/${attempt.id}/simulate`, { status, ...extra });
  return { base, request, order, attempt, state, simulate };
}

test('deposit, duplicate replay, stale failure, and balance settlement preserve one receipt per attempt', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  const paid = await app.simulate(attempt, 'succeeded');
  assert.equal(paid.status, 200);
  let state = await app.state();
  assert.equal(state.payments.length, 1);
  assert.equal(state.orders[0].net_paid_amount, 500000);
  assert.equal(state.orders[0].payment_status, 'partial');
  assert.equal(state.orders[0].booking_status, 'confirmed');
  const replay = await app.request(`/api/events/${paid.data.event_id}/deliver`, {});
  assert.equal(replay.data.ok, true);
  assert.equal(JSON.parse(replay.data.response).duplicate, true);
  await app.simulate(attempt, 'failed', { stale: true });
  state = await app.state();
  assert.equal(state.payments.length, 1);
  assert.equal(state.attempts[0].provider_status, 'succeeded');
  assert.equal(state.attempts[0].merchant_status, 'succeeded');
  assert.equal(state.events[0].merchant_processing, 'ignored');
  const balance = await app.attempt(order, 'gateway', 500000);
  await app.simulate(balance, 'succeeded');
  state = await app.state();
  assert.equal(state.payments.length, 2);
  assert.equal(state.orders[0].net_paid_amount, 1000000);
  assert.equal(state.orders[0].payment_status, 'paid');
  assert.equal(state.orders[0].balance_amount, 0);
  assert.equal((await app.simulate(balance, 'failed')).status, 409);
});

test('paused webhook delivery keeps provider and merchant states separate until a verified replay', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  await app.request('/api/settings', { automatic_delivery: false });
  const result = await app.simulate(attempt, 'succeeded');
  let state = await app.state();
  assert.equal(state.attempts[0].provider_status, 'succeeded');
  assert.equal(state.orders[0].net_paid_amount, 0);
  assert.equal(state.orders[0].booking_status, 'awaiting_deposit');
  assert.equal(state.events[0].deliveries.length, 0);
  await app.request(`/api/events/${result.data.event_id}/deliver`, {});
  await app.request(`/api/events/${result.data.event_id}/deliver`, {});
  state = await app.state();
  assert.equal(state.orders[0].net_paid_amount, 500000);
  assert.equal(state.payments.length, 1);
});

test('capture after reservation expiry records money for review without reactivating the booking', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  await app.request(`/api/orders/${order.id}/expire`, {});
  await app.simulate(attempt, 'expired');
  const result = await app.simulate(attempt, 'succeeded', { late_capture: true });
  assert.equal(result.status, 200);
  const state = await app.state();
  assert.equal(state.orders[0].booking_status, 'expired');
  assert.equal(state.orders[0].net_paid_amount, 500000);
  assert.equal(state.payments[0].needs_review, true);
});

test('bank proof never credits funds before approval; rejection and duplicate bank references are enforced', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    first = await app.attempt(order, 'bank_transfer');
  assert.equal(
    (
      await app.request(`/api/attempts/${first.id}/review`, {
        decision: 'approve',
        bank_reference: 'BANK-001',
      })
    ).status,
    409,
  );
  await app.request(`/api/attempts/${first.id}/proof`, { data_url: PNG, filename: 'proof.png' });
  let state = await app.state();
  assert.equal(state.payments.length, 0);
  assert.equal(state.orders[0].payment_status, 'unpaid');
  const approved = await app.request(`/api/attempts/${first.id}/review`, {
    decision: 'approve',
    bank_reference: 'BANK-001',
  });
  assert.equal(approved.status, 200);
  await app.request(`/api/attempts/${first.id}/review`, {
    decision: 'approve',
    bank_reference: 'BANK-001',
  });
  assert.equal((await app.state()).payments.length, 1);
  const second = await app.attempt(order, 'bank_transfer');
  await app.request(`/api/attempts/${second.id}/proof`, { data_url: PNG, filename: 'proof2.png' });
  assert.equal(
    (
      await app.request(`/api/attempts/${second.id}/review`, {
        decision: 'reject',
        reason: 'Dana belum masuk',
      })
    ).status,
    200,
  );
  assert.equal((await app.state()).payments.length, 1);
  const third = await app.attempt(order, 'bank_transfer');
  await app.request(`/api/attempts/${third.id}/proof`, { data_url: PNG, filename: 'proof3.png' });
  assert.equal(
    (
      await app.request(`/api/attempts/${third.id}/review`, {
        decision: 'approve',
        bank_reference: 'bank-001',
      })
    ).status,
    409,
  );
  await app.request(`/api/attempts/${third.id}/review`, {
    decision: 'approve',
    bank_reference: 'BANK-002',
  });
  state = await app.state();
  assert.equal(state.orders[0].payment_status, 'paid');
  assert.equal(state.payments.length, 2);
});

test('invalid proof types and reused idempotency keys with changed input are rejected', async (t) => {
  const app = await setup(t),
    key = randomUUID(),
    body = { client_label: 'Idempotent', total_amount: 1000000, deposit_amount: 500000 };
  const first = await app.request('/api/orders', body, { 'Idempotency-Key': key }),
    second = await app.request('/api/orders', body, { 'Idempotency-Key': key });
  assert.equal(first.data.id, second.data.id);
  assert.equal(
    (
      await app.request(
        '/api/orders',
        { ...body, total_amount: 2000000 },
        { 'Idempotency-Key': key },
      )
    ).status,
    409,
  );
  const attempt = await app.attempt(first.data, 'bank_transfer');
  assert.equal(
    (
      await app.request(`/api/attempts/${attempt.id}/proof`, {
        filename: 'fake.png',
        data_url: 'data:image/png;base64,aGVsbG8=',
      })
    ).status,
    422,
  );
  assert.equal((await app.state()).payments.length, 0);
});

test('signed amount mismatches are quarantined; a corrected new event can reconcile once', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  await app.simulate(attempt, 'succeeded', { amount_override: 1 });
  let state = await app.state();
  assert.equal(state.payments.length, 0);
  assert.equal(state.events[0].merchant_processing, 'quarantined');
  assert.equal(state.events[0].deliveries[0].http_status, 422);
  await app.simulate(attempt, 'succeeded');
  state = await app.state();
  assert.equal(state.payments.length, 1);
  assert.equal(state.orders[0].net_paid_amount, 500000);
});

test('bad signatures, stale timestamps, and event ID payload conflicts cannot change the ledger', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  await app.request('/api/settings', { automatic_delivery: false });
  await app.simulate(attempt, 'succeeded');
  const event = (await app.state()).events[0].payload,
    raw = JSON.stringify(event),
    seconds = Math.floor(Date.now() / 1000).toString();
  async function send(payload, timestamp, signature) {
    const response = await fetch(app.base + '/api/webhooks/gateway', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Simulator-Event-Id': event.id,
        'X-Simulator-Timestamp': timestamp,
        'X-Simulator-Signature': signature,
      },
      body: payload,
    });
    return response.status;
  }
  assert.equal(await send(raw, seconds, 'bad'), 401);
  const stale = String(Number(seconds) - 1000);
  assert.equal(await send(raw, stale, signWebhook(SECRET, stale, raw)), 401);
  assert.equal((await app.state()).payments.length, 0);
  const statuses = await Promise.all([
    send(raw, seconds, signWebhook(SECRET, seconds, raw)),
    send(raw, seconds, signWebhook(SECRET, seconds, raw)),
  ]);
  assert.deepEqual(statuses, [200, 200]);
  assert.equal((await app.state()).payments.length, 1);
  const changed = JSON.stringify({ ...event, data: { ...event.data, amount: 1 } });
  assert.equal(await send(changed, seconds, signWebhook(SECRET, seconds, changed)), 409);
  assert.equal((await app.state()).payments.length, 1);
});

test('refunds require cancellation, are idempotent, and cannot exceed the original receipt', async (t) => {
  const app = await setup(t),
    order = await app.order(),
    attempt = await app.attempt(order);
  await app.simulate(attempt, 'succeeded');
  const receipt = (await app.state()).payments[0],
    key = randomUUID(),
    input = { payment_id: receipt.id, amount: 200000, reason: 'Synthetic cancellation' };
  assert.equal((await app.request('/api/refunds', input, { 'Idempotency-Key': key })).status, 409);
  await app.request(`/api/orders/${order.id}/cancel`, {});
  const first = await app.request('/api/refunds', input, { 'Idempotency-Key': key }),
    duplicate = await app.request('/api/refunds', input, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  assert.equal(first.data.id, duplicate.data.id);
  let state = await app.state();
  assert.equal(state.refunds.length, 1);
  assert.equal(state.orders[0].refunded_amount, 200000);
  assert.equal(state.orders[0].net_paid_amount, 300000);
  assert.equal(state.orders[0].balance_amount, 0);
  assert.equal(state.orders[0].booking_status, 'cancelled');
  assert.equal((await app.request('/api/refunds', { ...input, amount: 300001 })).status, 422);
  await app.request(`/api/events/${first.data.event_id}/deliver`, {});
  state = await app.state();
  assert.equal(state.orders[0].refunded_amount, 200000);
});

test('external merchant sessions use API authentication, local callbacks, and idempotent checkout creation', async (t) => {
  const app = await setup(t),
    key = randomUUID(),
    input = {
      merchant_reference: 'LARAVEL-INV-001',
      amount: 500000,
      currency: 'IDR',
      callback_url: app.base + '/external-hook',
      return_url: app.base + '/',
    };
  assert.equal(
    (await app.request('/v1/payment-sessions', input, { 'X-API-Key': 'wrong' })).status,
    401,
  );
  assert.equal(
    (
      await app.request(
        '/v1/payment-sessions',
        { ...input, callback_url: 'https://example.com/hook' },
        { 'X-API-Key': MERCHANT },
      )
    ).status,
    422,
  );
  const first = await app.request('/v1/payment-sessions', input, {
      'X-API-Key': MERCHANT,
      'Idempotency-Key': key,
    }),
    second = await app.request('/v1/payment-sessions', input, {
      'X-API-Key': MERCHANT,
      'Idempotency-Key': key,
    });
  assert.equal(first.status, 201);
  assert.equal(first.data.id, second.data.id);
  assert.ok(first.data.checkout_url.includes('token='));
  assert.equal(first.data.order_id, null);
});

test('hosted checkout needs its token, settles through webhook, and prevents payment after success or expiry', async (t) => {
  let clock = Date.now();
  const app = await setup(t, { clock: () => clock }),
    order = await app.order(),
    attempt = await app.attempt(order),
    url = new URL(attempt.checkout_url),
    token = url.searchParams.get('token');
  assert.equal((await app.request(`/v1/checkout/${attempt.id}?token=bad`)).status, 401);
  assert.equal(
    (await app.request(`/v1/checkout/${attempt.id}/pay`, { token, scenario: 'succeeded' })).status,
    200,
  );
  assert.equal((await app.state()).orders[0].booking_status, 'confirmed');
  assert.equal(
    (await app.request(`/v1/checkout/${attempt.id}/pay`, { token, scenario: 'succeeded' })).status,
    409,
  );
  const another = await app.order(),
    expired = await app.attempt(another),
    expiredToken = new URL(expired.checkout_url).searchParams.get('token');
  clock += 901000;
  assert.equal(
    (
      await app.request(`/v1/checkout/${expired.id}/pay`, {
        token: expiredToken,
        scenario: 'succeeded',
      })
    ).status,
    409,
  );
  assert.equal((await app.state()).payments.length, 1);
});
