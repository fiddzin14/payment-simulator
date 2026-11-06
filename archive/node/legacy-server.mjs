import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULTS = {
  controlKey: 'local-control-demo',
  merchantKey: 'local-merchant-demo',
  webhookSecret: 'local-webhook-demo',
};
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function requireValue(condition, status, code, message) {
  if (!condition) throw new ApiError(status, code, message);
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  const first = Buffer.from(String(a || '')),
    second = Buffer.from(String(b || ''));
  return first.length === second.length && timingSafeEqual(first, second);
};
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export function signWebhook(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function createSimulator(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = options.clock || Date.now;
  const orders = new Map(),
    attempts = new Map(),
    events = new Map(),
    receipts = new Map(),
    refunds = new Map(),
    refundLedger = new Map(),
    inbox = new Map(),
    keys = new Map(),
    bankReferences = new Map();
  const logs = [];
  let baseUrl = '',
    automaticDelivery = true;
  const timestamp = () => new Date(now()).toISOString();
  const log = (type, message, details = {}) => {
    logs.unshift({ id: randomUUID(), at: timestamp(), type, message, ...details });
    if (logs.length > 300) logs.length = 300;
  };
  function money(value, label = 'amount') {
    requireValue(
      Number.isSafeInteger(value) && value > 0 && value <= 10000000000,
      422,
      'INVALID_AMOUNT',
      `${label} must be an integer rupiah amount from 1 to 10,000,000,000.`,
    );
    return value;
  }
  function text(value, max = 150) {
    return String(value || '')
      .trim()
      .slice(0, max);
  }
  function find(map, id, label) {
    const record = map.get(id);
    requireValue(record, 404, 'NOT_FOUND', `${label} not found.`);
    return record;
  }
  function localUrl(value, label, required = true) {
    if (!value && !required) return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new ApiError(422, 'INVALID_URL', `${label} must be a local HTTP URL.`);
    }
    requireValue(
      url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        !url.username &&
        !url.password,
      422,
      'LOCAL_URL_ONLY',
      `${label} must use HTTP on loopback. Redirects are not followed.`,
    );
    return url.href;
  }
  function idempotent(scope, key, payload, create) {
    requireValue(
      typeof key === 'string' && key.length >= 8 && key.length <= 100,
      422,
      'IDEMPOTENCY_REQUIRED',
      'Supply an Idempotency-Key of 8–100 characters.',
    );
    const keyName = `${scope}:${key}`,
      requestHash = hash(stable(payload));
    if (keys.has(keyName)) {
      const old = keys.get(keyName);
      requireValue(
        old.hash === requestHash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'The key was already used with different input.',
      );
      return old.value;
    }
    const value = create();
    keys.set(keyName, { hash: requestHash, value });
    return value;
  }
  const orderReceipts = (id) => [...receipts.values()].filter((receipt) => receipt.order_id === id);
  function balance(order) {
    const received = orderReceipts(order.id).reduce((sum, item) => sum + item.amount, 0),
      returned = [...refundLedger.values()]
        .filter((item) => item.order_id === order.id)
        .reduce((sum, item) => sum + item.amount, 0),
      net = received - returned;
    return {
      received_amount: received,
      refunded_amount: returned,
      net_paid_amount: net,
      balance_amount: order.cancelled ? 0 : Math.max(order.total_amount - net, 0),
      overpaid_amount: Math.max(net - order.total_amount, 0),
      deposit_due_amount: Math.max(order.deposit_amount - net, 0),
      payment_status: order.cancelled
        ? 'cancelled'
        : net > order.total_amount
          ? 'overpaid'
          : net === order.total_amount
            ? 'paid'
            : net > 0
              ? 'partial'
              : 'unpaid',
    };
  }
  function reconcile(order) {
    const current = balance(order);
    if (order.cancelled) order.booking_status = 'cancelled';
    else if (order.booking_status !== 'confirmed' && now() > Date.parse(order.hold_expires_at))
      order.booking_status = 'expired';
    else if (
      order.booking_status === 'awaiting_deposit' &&
      current.net_paid_amount >= order.deposit_amount &&
      !orderReceipts(order.id).some((item) => item.needs_review)
    )
      order.booking_status = 'confirmed';
    return { ...order, ...current };
  }
  function publicAttempt(attempt) {
    const { checkout_token, proof, ...safe } = attempt;
    return {
      ...safe,
      checkout_url:
        attempt.method === 'gateway'
          ? `${baseUrl}/checkout.html?session=${attempt.id}&token=${checkout_token}`
          : null,
      proof: proof
        ? {
            filename: proof.filename,
            mime: proof.mime,
            size: proof.bytes.length,
            uploaded_at: proof.uploaded_at,
          }
        : null,
      merchant_status: attempt.order_id
        ? receipts.has(attempt.id)
          ? 'succeeded'
          : attempt.merchant_status || 'pending'
        : null,
    };
  }
  function state() {
    return {
      base_url: baseUrl,
      automatic_delivery: automaticDelivery,
      orders: [...orders.values()].map(reconcile).reverse(),
      attempts: [...attempts.values()].map(publicAttempt).reverse(),
      events: [...events.values()]
        .map((event) => ({
          id: event.payload.id,
          type: event.payload.type,
          attempt_id: event.payload.data.session_id,
          created_at: event.payload.created_at,
          payload: event.payload,
          deliveries: event.deliveries,
          merchant_processing: inbox.get(event.payload.id)?.status || 'not_received',
        }))
        .reverse(),
      payments: [...receipts.values()].reverse(),
      refunds: [...refunds.values()]
        .map((item) => ({
          ...item,
          merchant_status: refundLedger.has(item.id) ? 'succeeded' : 'pending',
        }))
        .reverse(),
      logs,
    };
  }
  function postReceipt(attempt, bankReference = null) {
    if (receipts.has(attempt.id)) return receipts.get(attempt.id);
    const order = find(orders, attempt.order_id, 'Merchant order');
    if (bankReference) {
      const normalized = text(bankReference, 150).toUpperCase();
      requireValue(
        !bankReferences.has(normalized),
        409,
        'DUPLICATE_BANK_REFERENCE',
        'This bank reference has already been credited.',
      );
      bankReference = normalized;
    }
    const snapshot = reconcile(order),
      late =
        order.cancelled ||
        order.booking_status === 'expired' ||
        (order.booking_status !== 'confirmed' && now() > Date.parse(order.hold_expires_at)),
      overpaid = snapshot.net_paid_amount + attempt.amount > order.total_amount;
    const receipt = {
      id: `pay_${randomUUID()}`,
      order_id: order.id,
      attempt_id: attempt.id,
      amount: attempt.amount,
      currency: 'IDR',
      method: attempt.method,
      received_at: timestamp(),
      bank_reference: bankReference,
      needs_review: Boolean(late || overpaid),
      review_reason: late ? 'Reservation expired or cancelled' : overpaid ? 'Overpayment' : null,
    };
    receipts.set(attempt.id, receipt);
    if (bankReference) bankReferences.set(bankReference, receipt.id);
    attempt.merchant_status = 'succeeded';
    reconcile(order);
    log('receipt', `Verified receipt ${receipt.id}`, {
      order_id: order.id,
      attempt_id: attempt.id,
    });
    return receipt;
  }
  function makeEvent(attempt, status, extra = {}) {
    const payload = {
      id: `evt_${randomUUID()}`,
      type: `payment.${status}`,
      created_at: timestamp(),
      data: {
        session_id: attempt.id,
        merchant_reference: attempt.merchant_reference,
        provider_reference: attempt.provider_reference,
        amount: extra.amount_override ?? attempt.amount,
        currency: extra.currency_override ?? attempt.currency,
        status,
      },
    };
    const event = { payload, callback_url: attempt.callback_url, deliveries: [] };
    events.set(payload.id, event);
    log('event', payload.type, { attempt_id: attempt.id, event_id: payload.id });
    return event;
  }
  async function deliver(event) {
    const raw = JSON.stringify(event.payload),
      seconds = Math.floor(now() / 1000).toString();
    let delivery;
    try {
      const response = await fetch(event.callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Simulator-Timestamp': seconds,
          'X-Simulator-Signature': signWebhook(config.webhookSecret, seconds, raw),
          'X-Simulator-Event-Id': event.payload.id,
        },
        body: raw,
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      const body = (await response.text()).slice(0, 1000);
      delivery = { at: timestamp(), http_status: response.status, ok: response.ok, response: body };
    } catch (error) {
      delivery = { at: timestamp(), http_status: null, ok: false, response: error.message };
    }
    event.deliveries.push(delivery);
    log(
      delivery.ok ? 'webhook_delivered' : 'webhook_failed',
      `Webhook delivery ${delivery.ok ? 'acknowledged' : 'failed'}`,
      { event_id: event.payload.id },
    );
    return delivery;
  }
  async function maybeDeliver(event) {
    if (automaticDelivery) await deliver(event);
  }
  function createGateway(input, key, orderId = null) {
    const normalized = {
      merchant_reference: text(input.merchant_reference),
      amount: money(input.amount),
      currency: input.currency || 'IDR',
      callback_url: localUrl(input.callback_url, 'callback_url'),
      return_url: localUrl(input.return_url, 'return_url', false),
      expires_seconds: input.expires_seconds ?? 900,
    };
    requireValue(
      normalized.merchant_reference.length > 0,
      422,
      'REFERENCE_REQUIRED',
      'merchant_reference is required.',
    );
    requireValue(
      normalized.currency === 'IDR',
      422,
      'CURRENCY_UNSUPPORTED',
      'This simulator supports IDR.',
    );
    requireValue(
      Number.isInteger(normalized.expires_seconds) &&
        normalized.expires_seconds >= 60 &&
        normalized.expires_seconds <= 86400,
      422,
      'INVALID_EXPIRY',
      'expires_seconds must be 60–86400.',
    );
    return idempotent('gateway', key, normalized, () => {
      const attempt = {
        id: randomUUID(),
        order_id: orderId,
        merchant_reference: normalized.merchant_reference,
        provider_reference: `SIM-${randomUUID()}`,
        method: 'gateway',
        amount: normalized.amount,
        currency: 'IDR',
        provider_status: 'pending',
        merchant_status: 'pending',
        callback_url: normalized.callback_url,
        return_url: normalized.return_url,
        checkout_token: randomBytes(24).toString('hex'),
        expires_at: new Date(now() + normalized.expires_seconds * 1000).toISOString(),
        created_at: timestamp(),
        proof: null,
      };
      attempts.set(attempt.id, attempt);
      return attempt;
    });
  }
  function receiveWebhook(raw, headers) {
    const seconds = String(headers['x-simulator-timestamp'] || ''),
      signature = String(headers['x-simulator-signature'] || '');
    requireValue(
      /^\d+$/.test(seconds) && Math.abs(now() / 1000 - Number(seconds)) <= 300,
      401,
      'STALE_WEBHOOK',
      'Webhook timestamp is missing or stale.',
    );
    requireValue(
      equal(signature, signWebhook(config.webhookSecret, seconds, raw)),
      401,
      'BAD_SIGNATURE',
      'Webhook signature is invalid.',
    );
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'Webhook JSON is invalid.');
    }
    requireValue(
      event.id && event.data && event.id === headers['x-simulator-event-id'],
      422,
      'INVALID_EVENT',
      'Event ID and data are required.',
    );
    const bodyHash = hash(raw),
      previous = inbox.get(event.id);
    if (previous) {
      requireValue(
        previous.hash === bodyHash,
        409,
        'EVENT_CONFLICT',
        'Event ID has different content.',
      );
      if (['processed', 'ignored'].includes(previous.status))
        return { acknowledged: true, duplicate: true };
      if (previous.status === 'quarantined')
        throw new ApiError(422, 'QUARANTINED', 'Event requires reconciliation.');
    }
    const record = { hash: bodyHash, status: 'received' };
    inbox.set(event.id, record);
    try {
      const attempt = find(attempts, event.data.session_id, 'Payment session');
      requireValue(
        attempt.order_id && orders.has(attempt.order_id),
        422,
        'UNKNOWN_MERCHANT_ORDER',
        'Demo receiver does not own this merchant reference. Use your Laravel callback for external invoices.',
      );
      requireValue(
        event.data.merchant_reference === attempt.merchant_reference &&
          event.data.provider_reference === attempt.provider_reference,
        422,
        'REFERENCE_MISMATCH',
        'Payment reference mismatch.',
      );
      if (event.type === 'refund.succeeded') {
        const refund = find(refunds, event.data.refund_id, 'Refund');
        requireValue(
          refund.attempt_id === attempt.id &&
            event.data.amount === refund.amount &&
            event.data.currency === 'IDR',
          422,
          'REFUND_MISMATCH',
          'Refund does not match the requested amount.',
        );
        if (!refundLedger.has(refund.id))
          refundLedger.set(refund.id, { ...refund, completed_at: timestamp() });
        reconcile(orders.get(attempt.order_id));
      } else {
        requireValue(
          ['pending', 'succeeded', 'failed', 'expired', 'cancelled'].includes(event.data.status) &&
            event.type === `payment.${event.data.status}`,
          422,
          'INVALID_EVENT_TYPE',
          'Unsupported payment event.',
        );
        requireValue(
          event.data.amount === attempt.amount && event.data.currency === attempt.currency,
          422,
          'AMOUNT_MISMATCH',
          'Amount or currency does not match the attempt.',
        );
        if (receipts.has(attempt.id) && event.data.status !== 'succeeded') {
          record.status = 'ignored';
          return {
            acknowledged: true,
            ignored: true,
            reason: 'Successful payment cannot be downgraded',
          };
        }
        if (event.data.status === 'succeeded') postReceipt(attempt);
        else attempt.merchant_status = event.data.status;
      }
      record.status = 'processed';
      return { acknowledged: true, duplicate: false };
    } catch (error) {
      record.status = error instanceof ApiError ? 'quarantined' : 'failed';
      record.error = error.message;
      throw error;
    }
  }
  async function simulate(attempt, input) {
    requireValue(
      attempt.method === 'gateway',
      409,
      'TRANSFER_REVIEW_REQUIRED',
      'Use proof review for a bank transfer.',
    );
    const status = input.status;
    requireValue(
      ['pending', 'succeeded', 'failed', 'expired', 'cancelled'].includes(status),
      422,
      'INVALID_STATUS',
      'Unsupported simulation status.',
    );
    if (!input.stale) {
      requireValue(
        attempt.provider_status !== 'succeeded' || status === 'succeeded',
        409,
        'TERMINAL_SUCCESS',
        'Use stale=true to emit an out-of-order failure without changing captured funds.',
      );
      requireValue(
        !['failed', 'expired', 'cancelled'].includes(attempt.provider_status) ||
          status !== 'pending',
        409,
        'TERMINAL_ATTEMPT',
        'Create a new attempt after failure/expiry, or emit a stale event.',
      );
      requireValue(
        !['failed', 'expired', 'cancelled'].includes(attempt.provider_status) ||
          status !== 'succeeded' ||
          input.late_capture === true,
        409,
        'LATE_CAPTURE_FLAG_REQUIRED',
        'Use late_capture=true to model settlement after a terminal failure.',
      );
      attempt.provider_status = status;
    }
    const event = makeEvent(attempt, status, input);
    await maybeDeliver(event);
    return { attempt: publicAttempt(attempt), event_id: event.payload.id };
  }
  async function body(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      requireValue(bytes <= 3000000, 413, 'BODY_TOO_LARGE', 'Request exceeds the 3 MB limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  function json(response, status, value) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(value));
  }
  function authorize(request, kind = 'control') {
    const expected = kind === 'merchant' ? config.merchantKey : config.controlKey,
      actual = request.headers[kind === 'merchant' ? 'x-api-key' : 'x-control-key'];
    requireValue(equal(actual, expected), 401, 'UNAUTHORIZED', `A valid ${kind} key is required.`);
  }
  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/styles.css': 'styles.css',
    '/app.js': 'app.js',
    '/checkout': 'checkout.html',
    '/checkout.html': 'checkout.html',
    '/checkout.js': 'checkout.js',
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, baseUrl || 'http://127.0.0.1'),
        path = url.pathname,
        method = request.method;
      if (method === 'GET' && files[path]) {
        const name = files[path],
          content = await readFile(new URL(`./public/${name}`, import.meta.url));
        response.writeHead(200, {
          'Content-Type': name.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : name.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(content);
        return;
      }
      if (method === 'GET' && path === '/health') {
        json(response, 200, { ok: true, mode: 'simulation-only' });
        return;
      }
      if (method === 'POST' && path === '/api/webhooks/gateway') {
        const raw = await body(request);
        json(response, 200, receiveWebhook(raw, request.headers));
        return;
      }
      let match;
      if ((match = path.match(/^\/v1\/checkout\/([^/]+)(\/pay)?$/))) {
        const attempt = find(attempts, match[1], 'Checkout');
        let input = {};
        if (method === 'POST') {
          const raw = await body(request);
          input = JSON.parse(raw || '{}');
        }
        requireValue(
          equal(input.token || url.searchParams.get('token'), attempt.checkout_token),
          401,
          'INVALID_CHECKOUT_TOKEN',
          'Checkout token is invalid.',
        );
        requireValue(attempt.method === 'gateway', 404, 'NOT_FOUND', 'Checkout not found.');
        if (method === 'GET' && !match[2]) {
          json(response, 200, {
            id: attempt.id,
            amount: attempt.amount,
            currency: 'IDR',
            status: attempt.provider_status,
            merchant_reference: attempt.merchant_reference,
            expires_at: attempt.expires_at,
            return_url: attempt.return_url,
          });
          return;
        }
        if (method === 'POST' && match[2]) {
          requireValue(
            now() <= Date.parse(attempt.expires_at),
            409,
            'CHECKOUT_EXPIRED',
            'Checkout has expired.',
          );
          requireValue(
            ['succeeded', 'failed', 'pending'].includes(input.scenario),
            422,
            'INVALID_SCENARIO',
            'Choose succeeded, pending, or failed.',
          );
          requireValue(
            attempt.provider_status === 'pending',
            409,
            'CHECKOUT_CLOSED',
            'Checkout is no longer pending.',
          );
          json(response, 200, await simulate(attempt, { status: input.scenario }));
          return;
        }
      }
      if (path.startsWith('/v1/payment-sessions')) authorize(request, 'merchant');
      else if (path.startsWith('/api/')) authorize(request);
      if (method === 'GET' && path === '/api/state') {
        json(response, 200, state());
        return;
      }
      if (method === 'GET' && (match = path.match(/^\/api\/attempts\/([^/]+)\/proof-file$/))) {
        const proof = find(attempts, match[1], 'Attempt').proof;
        requireValue(proof, 404, 'NO_PROOF', 'No proof uploaded.');
        response.writeHead(200, {
          'Content-Type': proof.mime,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(proof.bytes);
        return;
      }
      if (method === 'GET' && (match = path.match(/^\/v1\/payment-sessions\/([^/]+)$/))) {
        json(response, 200, publicAttempt(find(attempts, match[1], 'Payment session')));
        return;
      }
      requireValue(method === 'POST', 404, 'NOT_FOUND', 'Endpoint not found.');
      const raw = await body(request);
      let input;
      try {
        input = JSON.parse(raw || '{}');
      } catch {
        throw new ApiError(400, 'INVALID_JSON', 'Invalid JSON body.');
      }
      const idempotency = request.headers['idempotency-key'];
      if (path === '/v1/payment-sessions') {
        const attempt = createGateway(input, idempotency);
        json(response, 201, publicAttempt(attempt));
        return;
      }
      if (path === '/api/settings') {
        requireValue(
          typeof input.automatic_delivery === 'boolean',
          422,
          'BOOLEAN_REQUIRED',
          'automatic_delivery must be a boolean.',
        );
        automaticDelivery = input.automatic_delivery;
        json(response, 200, { automatic_delivery: automaticDelivery });
        return;
      }
      if (path === '/api/orders') {
        const normalized = {
          client_label: text(input.client_label, 100) || 'Demo client',
          total_amount: money(input.total_amount),
          deposit_amount: input.deposit_amount,
          hold_minutes: input.hold_minutes ?? 1440,
        };
        requireValue(
          Number.isSafeInteger(normalized.deposit_amount) &&
            normalized.deposit_amount >= 0 &&
            normalized.deposit_amount <= normalized.total_amount,
          422,
          'INVALID_DEPOSIT',
          'Deposit must be between zero and total.',
        );
        requireValue(
          Number.isInteger(normalized.hold_minutes) &&
            normalized.hold_minutes >= 1 &&
            normalized.hold_minutes <= 10080,
          422,
          'INVALID_HOLD',
          'Hold must be 1–10080 minutes.',
        );
        const order = idempotent('orders', idempotency, normalized, () => {
          const record = {
            id: randomUUID(),
            number: `INV-DEMO-${String(orders.size + 1).padStart(3, '0')}`,
            ...normalized,
            currency: 'IDR',
            booking_status: normalized.deposit_amount === 0 ? 'confirmed' : 'awaiting_deposit',
            cancelled: false,
            hold_expires_at: new Date(now() + normalized.hold_minutes * 60000).toISOString(),
            created_at: timestamp(),
          };
          orders.set(record.id, record);
          log('order', 'Demo invoice created', { order_id: record.id });
          return record;
        });
        json(response, 201, reconcile(order));
        return;
      }
      if ((match = path.match(/^\/api\/orders\/([^/]+)\/attempts$/))) {
        const order = find(orders, match[1], 'Order');
        const normalized = { method: input.method, amount: input.amount };
        requireValue(
          ['gateway', 'bank_transfer'].includes(input.method),
          422,
          'INVALID_METHOD',
          'Choose gateway or bank_transfer.',
        );
        money(input.amount);
        const attempt = idempotent(`attempt:${order.id}`, idempotency, normalized, () => {
          const snapshot = reconcile(order);
          requireValue(
            !order.cancelled && order.booking_status !== 'expired',
            409,
            'RESERVATION_CLOSED',
            'Reservation is cancelled or expired.',
          );
          requireValue(
            input.amount <= snapshot.balance_amount,
            422,
            'AMOUNT_EXCEEDS_BALANCE',
            'Amount exceeds the outstanding balance.',
          );
          requireValue(
            ![...attempts.values()].some(
              (item) =>
                item.order_id === order.id &&
                (item.provider_status === 'pending' ||
                  (item.provider_status === 'succeeded' && !receipts.has(item.id))),
            ),
            409,
            'OPEN_ATTEMPT_EXISTS',
            'Finish or review the existing attempt first.',
          );
          if (input.method === 'gateway')
            return createGateway(
              {
                merchant_reference: order.id,
                amount: input.amount,
                currency: 'IDR',
                callback_url: `${baseUrl}/api/webhooks/gateway`,
                return_url: `${baseUrl}/`,
                expires_seconds: 900,
              },
              `demo-${hash(String(idempotency))}`,
              order.id,
            );
          const record = {
            id: randomUUID(),
            order_id: order.id,
            merchant_reference: order.id,
            provider_reference: null,
            method: 'bank_transfer',
            amount: input.amount,
            currency: 'IDR',
            provider_status: 'pending',
            merchant_status: 'pending',
            created_at: timestamp(),
            expires_at: order.hold_expires_at,
            proof: null,
          };
          attempts.set(record.id, record);
          return record;
        });
        json(response, 201, publicAttempt(attempt));
        return;
      }
      if ((match = path.match(/^\/api\/attempts\/([^/]+)\/simulate$/))) {
        json(response, 200, await simulate(find(attempts, match[1], 'Attempt'), input));
        return;
      }
      if ((match = path.match(/^\/api\/events\/([^/]+)\/deliver$/))) {
        json(response, 200, await deliver(find(events, match[1], 'Event')));
        return;
      }
      if ((match = path.match(/^\/api\/orders\/([^/]+)\/(expire|cancel)$/))) {
        const order = find(orders, match[1], 'Order');
        if (match[2] === 'cancel') {
          order.cancelled = true;
          order.booking_status = 'cancelled';
        } else {
          requireValue(
            order.booking_status !== 'confirmed',
            409,
            'ALREADY_CONFIRMED',
            'A confirmed reservation cannot be expired as an unpaid hold.',
          );
          order.hold_expires_at = new Date(now() - 1000).toISOString();
          order.booking_status = 'expired';
        }
        log(match[2], `Reservation ${match[2]}`, { order_id: order.id });
        json(response, 200, reconcile(order));
        return;
      }
      if ((match = path.match(/^\/api\/attempts\/([^/]+)\/proof$/))) {
        const attempt = find(attempts, match[1], 'Attempt');
        requireValue(
          attempt.method === 'bank_transfer' && attempt.provider_status === 'pending',
          409,
          'NOT_REVIEWABLE',
          'This is not a pending bank transfer.',
        );
        requireValue(
          !attempt.proof,
          409,
          'PROOF_EXISTS',
          'Proof already exists. Review this attempt before creating a replacement.',
        );
        const encoded = String(input.data_url || '').match(
          /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/,
        );
        requireValue(encoded, 422, 'INVALID_PROOF', 'Upload a PNG or JPEG image.');
        const bytes = Buffer.from(encoded[2], 'base64');
        requireValue(
          bytes.length > 0 && bytes.length <= 2 * 1024 * 1024,
          422,
          'INVALID_PROOF_SIZE',
          'Proof must be at most 2 MB.',
        );
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        requireValue(
          encoded[1] === 'image/png' ? png : jpeg,
          422,
          'PROOF_TYPE_MISMATCH',
          'File bytes do not match the declared image type.',
        );
        attempt.proof = {
          bytes,
          mime: encoded[1],
          filename: text(input.filename, 100).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'proof.png',
          uploaded_at: timestamp(),
        };
        const order = find(orders, attempt.order_id, 'Order');
        if (!order.hold_extended_at && now() < Date.parse(order.hold_expires_at)) {
          order.hold_expires_at = new Date(
            Date.parse(order.hold_expires_at) + 86400000,
          ).toISOString();
          order.hold_extended_at = timestamp();
        }
        log('proof', 'Transfer proof uploaded; no money credited', { attempt_id: attempt.id });
        json(response, 200, publicAttempt(attempt));
        return;
      }
      if ((match = path.match(/^\/api\/attempts\/([^/]+)\/review$/))) {
        const attempt = find(attempts, match[1], 'Attempt');
        requireValue(
          attempt.method === 'bank_transfer',
          409,
          'NOT_TRANSFER',
          'Only transfers use admin review.',
        );
        if (input.decision === 'approve' && receipts.has(attempt.id)) {
          json(response, 200, receipts.get(attempt.id));
          return;
        }
        requireValue(
          attempt.provider_status === 'pending' && attempt.proof,
          409,
          'PROOF_REQUIRED',
          'A pending transfer with uploaded proof is required.',
        );
        if (input.decision === 'approve') {
          requireValue(
            text(input.bank_reference).length >= 4,
            422,
            'BANK_REFERENCE_REQUIRED',
            'Record the verified bank reference.',
          );
          const receipt = postReceipt(attempt, input.bank_reference);
          attempt.provider_status = 'succeeded';
          attempt.reviewed_at = timestamp();
          json(response, 200, receipt);
          return;
        }
        requireValue(
          input.decision === 'reject' && text(input.reason).length >= 3,
          422,
          'REASON_REQUIRED',
          'A rejection reason is required.',
        );
        attempt.provider_status = 'rejected';
        attempt.merchant_status = 'rejected';
        attempt.rejection_reason = text(input.reason, 500);
        attempt.reviewed_at = timestamp();
        json(response, 200, publicAttempt(attempt));
        return;
      }
      if (path === '/api/refunds') {
        const normalized = {
          payment_id: input.payment_id,
          amount: money(input.amount),
          reason: text(input.reason, 500),
        };
        requireValue(
          normalized.reason.length >= 3,
          422,
          'REASON_REQUIRED',
          'Refund reason is required.',
        );
        const refund = idempotent('refund', idempotency, normalized, () => {
          const receipt = [...receipts.values()].find((item) => item.id === input.payment_id);
          requireValue(receipt, 404, 'NOT_FOUND', 'Receipt not found.');
          const order = find(orders, receipt.order_id, 'Order');
          requireValue(
            order.cancelled,
            409,
            'CANCEL_FIRST',
            'Cancel the demo reservation before requesting a refund.',
          );
          const reserved = [...refunds.values()]
            .filter((item) => item.payment_id === receipt.id)
            .reduce((sum, item) => sum + item.amount, 0);
          requireValue(
            input.amount <= receipt.amount - reserved,
            422,
            'REFUND_EXCEEDS_RECEIPT',
            'Refund exceeds the remaining refundable amount.',
          );
          const record = {
            id: `ref_${randomUUID()}`,
            payment_id: receipt.id,
            attempt_id: receipt.attempt_id,
            order_id: receipt.order_id,
            amount: input.amount,
            currency: 'IDR',
            reason: normalized.reason,
            status: 'succeeded',
            created_at: timestamp(),
          };
          refunds.set(record.id, record);
          if (receipt.method === 'bank_transfer')
            refundLedger.set(record.id, { ...record, completed_at: timestamp() });
          return record;
        });
        if (!refund.event_id && !refundLedger.has(refund.id)) {
          const attempt = attempts.get(refund.attempt_id),
            payload = {
              id: `evt_${randomUUID()}`,
              type: 'refund.succeeded',
              created_at: timestamp(),
              data: {
                session_id: attempt.id,
                merchant_reference: attempt.merchant_reference,
                provider_reference: attempt.provider_reference,
                refund_id: refund.id,
                payment_id: refund.payment_id,
                amount: refund.amount,
                currency: 'IDR',
                status: 'succeeded',
              },
            };
          const event = { payload, callback_url: attempt.callback_url, deliveries: [] };
          events.set(payload.id, event);
          refund.event_id = payload.id;
          await maybeDeliver(event);
        }
        json(response, 201, refund);
        return;
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          error instanceof ApiError ? error.status : error instanceof SyntaxError ? 400 : 500,
          {
            error: {
              code: error.code || 'INTERNAL_ERROR',
              message:
                error instanceof ApiError || error instanceof SyntaxError
                  ? error.message
                  : 'Unexpected simulator error.',
            },
          },
        );
      else response.end();
    }
  });
  return {
    server,
    async listen(port = 4179) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      return baseUrl;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    snapshot: state,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createSimulator({
    controlKey: process.env.SIMULATOR_CONTROL_KEY || DEFAULTS.controlKey,
    merchantKey: process.env.MERCHANT_API_KEY || DEFAULTS.merchantKey,
    webhookSecret: process.env.WEBHOOK_SECRET || DEFAULTS.webhookSecret,
  });
  const url = await app.listen(Number(process.env.PORT || 4179));
  console.log(`Lumen gateway simulator: ${url}`);
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
}
