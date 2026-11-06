import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { createStore } from './lib/store.mjs';
import {
  ApiError,
  ensure,
  digest,
  token,
  equal,
  canonical,
  signature,
  passwordHash,
  passwordMatches,
  validateDestination,
  deliverHttp,
} from './lib/security.mjs';

export const BANKS = {
  BCA: '99901',
  BNI: '99902',
  BRI: '99903',
  MANDIRI: '99904',
  PERMATA: '99905',
};
const RETRIES = [5, 30, 120, 600, 1800, 7200];
const clean = (value, max = 150) =>
  String(value || '')
    .trim()
    .slice(0, max);
export async function createGateway(options = {}) {
  const store = await createStore(options.dataFile ?? null),
    clock = options.clock || Date.now;
  const allowLocal = options.allowLocalWebhooks ?? true,
    send = options.sendWebhook || deliverHttp;
  let base = '',
    interval,
    closing = false,
    working = false,
    scanServer = null;
  const scanUrl = (p) =>
    `${(options.scanBaseUrl || base).replace(/\/$/, '')}/qris/${p.checkout_token}?amount=${p.amount}`;
  const inFlight = new Set(),
    rates = new Map();
  const date = () => new Date(clock()).toISOString(),
    id = (prefix) => `${prefix}_${randomUUID()}`;
  const publicMerchant = (m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    webhook_url: m.webhook_url,
    created_at: m.created_at,
    mode: 'test',
    email_verified: false,
  });
  const audit = (s, m, action, resource) => {
    s.audit.unshift({ id: id('log'), merchant_id: m, action, resource, created_at: date() });
    if (s.audit.length > 5000) s.audit.length = 5000;
  };
  const scoped = (s, collection, key, merchant) => {
    const item = s[collection].find((x) => x.id === key && x.merchant_id === merchant);
    ensure(item, 404, 'NOT_FOUND', 'Resource not found.');
    return item;
  };
  const publicKey = (k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    last_four: k.last_four,
    created_at: k.created_at,
    revoked_at: k.revoked_at,
    last_used_at: k.last_used_at,
  });
  function issueKey(s, m, name) {
    ensure(
      s.credentials.filter((x) => x.merchant_id === m.id && !x.revoked_at).length < 10,
      409,
      'KEY_LIMIT',
      'Revoke an unused credential before creating another. Maximum 10 active keys.',
    );
    const secret = token('sk_test_'),
      record = {
        id: id('key'),
        merchant_id: m.id,
        name: clean(name, 60) || 'Default application',
        hash: digest(secret),
        prefix: secret.slice(0, 15),
        last_four: secret.slice(-4),
        created_at: date(),
        revoked_at: null,
        last_used_at: null,
      };
    s.credentials.push(record);
    audit(s, m.id, 'credential.created', record.id);
    return { ...publicKey(record), secret_key: secret };
  }
  function event(s, p, type, extra = {}) {
    const merchant = s.merchants.find((x) => x.id === p.merchant_id);
    const payload = {
      id: id('evt'),
      type,
      api_version: '2026-11-04',
      created_at: date(),
      data: {
        payment_id: p.id,
        merchant_id: p.merchant_id,
        external_id: p.external_id,
        amount: p.amount,
        currency: 'IDR',
        payment_method: p.payment_method,
        bank_code: p.bank_code,
        status: p.status,
        paid_amount: p.paid_amount,
        refunded_amount: p.refunded_amount,
        ...extra,
      },
    };
    const record = {
      id: payload.id,
      merchant_id: p.merchant_id,
      payment_id: p.id,
      payload,
      target_url: p.webhook_url || merchant.webhook_url,
      status: p.webhook_url || merchant.webhook_url ? 'pending' : 'unconfigured',
      retry_count: 0,
      next_attempt_at: date(),
      deliveries: [],
    };
    s.events.push(record);
    return record;
  }
  function paymentView(p) {
    const { checkout_token, webhook_url, request_hash, ...safe } = p;
    const url = `${base}/pay/${checkout_token}`;
    return {
      ...safe,
      checkout_url: url,
      qr_string: p.payment_method === 'qris' ? scanUrl(p) : null,
      qr_image_url:
        p.payment_method === 'qris' ? `${base}/checkout-api/${checkout_token}/qr.svg` : null,
      simulation_only: true,
    };
  }
  function amount(value, max = 100000000) {
    ensure(
      Number.isSafeInteger(value) && value >= 1 && value <= max,
      422,
      'INVALID_AMOUNT',
      `amount must be an integer IDR value between 1 and ${max}.`,
    );
    return value;
  }
  function idem(s, merchant, scope, key, input, create) {
    ensure(
      typeof key === 'string' && key.length >= 8 && key.length <= 100,
      422,
      'IDEMPOTENCY_REQUIRED',
      'Supply an Idempotency-Key of 8-100 characters.',
    );
    const hash = digest(canonical(input)),
      old = s.idempotency.find(
        (x) => x.merchant_id === merchant && x.scope === scope && x.key === key,
      );
    if (old) {
      ensure(
        old.hash === hash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was used with different input.',
      );
      return old.resource_id;
    }
    const resource = create();
    s.idempotency.push({
      merchant_id: merchant,
      scope,
      key,
      hash,
      resource_id: resource.id,
      created_at: date(),
    });
    return resource.id;
  }
  function createPayment(s, m, input, key, credentialId = null) {
    const channel = input.payment_method;
    ensure(
      ['qris', 'virtual_account'].includes(channel),
      422,
      'INVALID_METHOD',
      'Choose qris or virtual_account.',
    );
    amount(input.amount, channel === 'qris' ? 10000000 : 100000000);
    const normalized = {
      external_id: clean(input.external_id, 100),
      amount: input.amount,
      currency: input.currency || 'IDR',
      payment_method: channel,
      bank_code: channel === 'virtual_account' ? clean(input.bank_code).toUpperCase() : null,
      expires_in: input.expires_in ?? (channel === 'qris' ? 900 : 86400),
      description: clean(input.description, 300),
      customer_name: clean(input.customer_name, 100),
      return_url: validateDestination(input.return_url, { allowLocal, returnUrl: true }),
    };
    ensure(
      normalized.external_id.length >= 1,
      422,
      'REFERENCE_REQUIRED',
      'external_id is required.',
    );
    ensure(normalized.currency === 'IDR', 422, 'CURRENCY_UNSUPPORTED', 'Only IDR is supported.');
    ensure(
      channel !== 'virtual_account' || BANKS[normalized.bank_code],
      422,
      'INVALID_BANK',
      'Supported banks: BCA, BNI, BRI, MANDIRI, PERMATA.',
    );
    ensure(
      Number.isInteger(normalized.expires_in) &&
        normalized.expires_in >= 60 &&
        normalized.expires_in <= (channel === 'qris' ? 3600 : 604800),
      422,
      'INVALID_EXPIRY',
      channel === 'qris'
        ? 'QRIS expires_in must be 60-3600 seconds.'
        : 'VA expires_in must be 60-604800 seconds.',
    );
    const paymentId = idem(s, m.id, 'payment', key, normalized, () => {
      ensure(
        !s.payments.some((x) => x.merchant_id === m.id && x.external_id === normalized.external_id),
        409,
        'REFERENCE_EXISTS',
        'external_id already exists. Retrieve that payment or use a new reference.',
      );
      let account = null;
      if (channel === 'virtual_account') {
        do {
          account =
            BANKS[normalized.bank_code] + Array.from({ length: 11 }, () => randomInt(10)).join('');
        } while (s.payments.some((x) => x.account_number === account));
      }
      const p = {
        id: id('pay'),
        merchant_id: m.id,
        credential_id: credentialId,
        ...normalized,
        account_number: account,
        account_name: `SIM ${m.name}`.slice(0, 50),
        checkout_token: token('cs_test_'),
        webhook_url: m.webhook_url,
        status: 'pending',
        paid_amount: 0,
        refunded_amount: 0,
        late_received_amount: 0,
        created_at: date(),
        expires_at: new Date(clock() + normalized.expires_in * 1000).toISOString(),
        paid_at: null,
      };
      s.payments.push(p);
      event(s, p, 'payment.pending');
      audit(s, m.id, 'payment.created', p.id);
      return p;
    });
    return paymentView(scoped(s, 'payments', paymentId, m.id));
  }
  function transition(s, p, input) {
    const outcome = input.outcome;
    ensure(
      ['paid', 'failed', 'expired', 'cancelled', 'pending'].includes(outcome),
      422,
      'INVALID_OUTCOME',
      'Choose paid, failed, expired, cancelled, or pending.',
    );
    if (outcome === 'pending') {
      ensure(p.status === 'pending', 409, 'PAYMENT_CLOSED', 'Payment is no longer pending.');
      return paymentView(p);
    }
    if (outcome === 'paid') {
      const value = input.amount ?? p.amount;
      amount(value);
      ensure(
        value === p.amount,
        422,
        'AMOUNT_MISMATCH',
        'Closed-amount payments require the exact amount. No funds were recorded.',
      );
      const reference = clean(input.bank_reference, 100);
      ensure(
        reference.length >= 4,
        422,
        'BANK_REFERENCE_REQUIRED',
        'Supply a unique simulated bank reference (at least 4 characters).',
      );
      const existing = s.receipts.find((x) => x.bank_reference === reference);
      if (existing) {
        ensure(
          existing.payment_id === p.id && existing.amount === value,
          409,
          'BANK_REFERENCE_USED',
          'Bank reference already used.',
        );
        return paymentView(p);
      }
      ensure(
        p.status !== 'paid',
        409,
        'ALREADY_PAID',
        'Payment already paid. Duplicate notifications cannot add another receipt.',
      );
      const late = p.status !== 'pending' || clock() >= Date.parse(p.expires_at);
      ensure(
        !late || input.late_payment === true,
        409,
        'PAYMENT_CLOSED',
        'Payment is expired or closed. Use an authorized late-payment scenario to record reconciliation funds.',
      );
      s.receipts.push({
        id: id('rcpt'),
        merchant_id: p.merchant_id,
        payment_id: p.id,
        amount: value,
        bank_reference: reference,
        needs_review: late,
        created_at: date(),
      });
      if (late) {
        p.late_received_amount += value;
        event(s, p, 'payment.late_received', { received_amount: value, needs_review: true });
      } else {
        p.status = 'paid';
        p.paid_amount = value;
        p.paid_at = date();
        event(s, p, 'payment.paid');
      }
    } else {
      ensure(
        p.status === 'pending',
        409,
        'PAYMENT_CLOSED',
        'Terminal payments cannot be changed or downgraded.',
      );
      p.status = outcome;
      event(s, p, `payment.${outcome}`);
    }
    audit(s, p.merchant_id, `payment.${outcome}`, p.id);
    return paymentView(p);
  }
  function createRefund(s, m, paymentId, input, key) {
    const p = scoped(s, 'payments', paymentId, m.id),
      normalized = { amount: amount(input.amount), reason: clean(input.reason, 300) };
    ensure(normalized.reason.length >= 3, 422, 'REASON_REQUIRED', 'Supply a refund reason.');
    const refundId = idem(s, m.id, `refund:${p.id}`, key, normalized, () => {
      ensure(
        p.status === 'paid',
        409,
        'PAYMENT_NOT_PAID',
        'Only settled payments can be refunded.',
      );
      const reserved = s.refunds
        .filter((x) => x.payment_id === p.id && ['pending', 'succeeded'].includes(x.status))
        .reduce((n, r) => n + r.amount, 0);
      ensure(
        normalized.amount <= p.paid_amount - reserved,
        422,
        'REFUND_EXCEEDS_PAYMENT',
        'Refund exceeds unreserved settled funds.',
      );
      const r = {
        id: id('ref'),
        merchant_id: m.id,
        payment_id: p.id,
        ...normalized,
        currency: 'IDR',
        status: 'pending',
        created_at: date(),
      };
      s.refunds.push(r);
      event(s, p, 'refund.pending', { refund_id: r.id, refund_amount: r.amount });
      audit(s, m.id, 'refund.requested', r.id);
      return r;
    });
    return scoped(s, 'refunds', refundId, m.id);
  }
  async function expirePayments() {
    if (
      !store.data.payments.some(
        (p) => p.status === 'pending' && Date.parse(p.expires_at) <= clock(),
      )
    )
      return;
    await store.change((s) => {
      for (const p of s.payments)
        if (p.status === 'pending' && Date.parse(p.expires_at) <= clock()) {
          p.status = 'expired';
          event(s, p, 'payment.expired');
        }
    });
  }
  async function deliver(eventId) {
    if (inFlight.has(eventId) || closing) return;
    inFlight.add(eventId);
    try {
      let task;
      await store.change((s) => {
        const e = s.events.find((x) => x.id === eventId);
        if (!e || e.status !== 'pending' || Date.parse(e.next_attempt_at) > clock()) return;
        const m = s.merchants.find((x) => x.id === e.merchant_id);
        if (!e.target_url) {
          e.status = 'unconfigured';
          return;
        }
        e.status = 'delivering';
        task = { payload: e.payload, url: e.target_url, secret: m.webhook_secret };
      });
      if (!task) return;
      const raw = JSON.stringify(task.payload),
        seconds = String(Math.floor(clock() / 1000));
      let result;
      try {
        const r = await send(
          task.url,
          raw,
          {
            'Content-Type': 'application/json',
            'X-Simulator-Timestamp': seconds,
            'X-Simulator-Signature': signature(task.secret, seconds, raw),
            'X-Simulator-Event-Id': eventId,
            'User-Agent': 'Lumen-Sandbox/2.0',
          },
          { allowLocal },
        );
        result = {
          http_status: r.status,
          ok: r.status >= 200 && r.status < 300,
          error: r.status >= 200 && r.status < 300 ? null : `HTTP ${r.status}`,
        };
      } catch (error) {
        result = { http_status: null, ok: false, error: clean(error.message, 300) };
      }
      await store.change((s) => {
        const e = s.events.find((x) => x.id === eventId);
        e.deliveries.push({ at: date(), ...result });
        e.deliveries = e.deliveries.slice(-50);
        if (result.ok) {
          e.status = 'delivered';
          e.next_attempt_at = null;
        } else if (e.retry_count < RETRIES.length) {
          e.next_attempt_at = new Date(clock() + RETRIES[e.retry_count++] * 1000).toISOString();
          e.status = 'pending';
        } else {
          e.status = 'failed';
          e.next_attempt_at = null;
        }
      });
    } finally {
      inFlight.delete(eventId);
    }
  }
  async function tick() {
    if (working || closing) return;
    working = true;
    try {
      await expirePayments();
      const due = store.data.events
        .filter((e) => e.status === 'pending' && Date.parse(e.next_attempt_at) <= clock())
        .slice(0, 10);
      await Promise.all(due.map((e) => deliver(e.id)));
    } finally {
      working = false;
    }
  }
  // A crash can interrupt a delivery after the receiver processed it. Retry the same stable event ID.
  if (store.data.events.some((e) => e.status === 'delivering'))
    await store.change((s) => {
      for (const e of s.events)
        if (e.status === 'delivering') {
          e.status = 'pending';
          e.next_attempt_at = date();
        }
    });
  function rate(key, limit = 120, window = 60000) {
    if (options.disableRateLimit) return;
    const old = rates.get(key);
    if (!old || old.until <= clock()) rates.set(key, { count: 1, until: clock() + window });
    else {
      ensure(
        old.count < limit,
        429,
        'RATE_LIMITED',
        'Too many requests. Retry after the current rate-limit window.',
      );
      old.count++;
    }
    if (rates.size > 10000) for (const [k, v] of rates) if (v.until <= clock()) rates.delete(k);
  }
  async function rawBody(req) {
    let size = 0,
      chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      ensure(size <= 65536, 413, 'BODY_TOO_LARGE', 'Request body limit is 64 KB.');
      chunks.push(chunk);
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'Request body must be JSON.');
    }
    ensure(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      422,
      'INVALID_BODY',
      'Request body must be a JSON object.',
    );
    return parsed;
  }
  function response(res, status, value, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(JSON.stringify(value));
  }
  const cookieToken = (req) => {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)lumen_session=([^;]+)/);
    return match?.[1] || '';
  };
  function sessionCookie(secret, seconds = 86400) {
    return `lumen_session=${secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${base.startsWith('https:') ? '; Secure' : ''}`;
  }
  function sessionAuth(req) {
    const access = (req.headers.authorization || '').replace(/^Bearer /, '') || cookieToken(req),
      session = store.data.sessions.find(
        (x) => equal(x.hash, digest(access)) && Date.parse(x.expires_at) > clock(),
      );
    ensure(session, 401, 'LOGIN_REQUIRED', 'Sign in to your merchant workspace.');
    return store.data.merchants.find((x) => x.id === session.merchant_id);
  }
  function apiAuth(req) {
    const secret = (req.headers.authorization || '').replace(/^Bearer /, ''),
      key = store.data.credentials.find((x) => !x.revoked_at && equal(x.hash, digest(secret)));
    ensure(
      secret.startsWith('sk_test_') && key,
      401,
      'INVALID_API_KEY',
      'Use an active test secret API key in Authorization: Bearer.',
    );
    return { merchant: store.data.merchants.find((x) => x.id === key.merchant_id), key };
  }
  function newSession(s, m) {
    const access = token('sess_');
    s.sessions = s.sessions.filter((x) => Date.parse(x.expires_at) > clock());
    s.sessions.push({
      id: id('sess'),
      merchant_id: m.id,
      hash: digest(access),
      expires_at: new Date(clock() + 86400000).toISOString(),
    });
    return access;
  }

  const htmlEscape = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  async function scanPayment(req, res) {
    const match = new URL(req.url, 'http://localhost').pathname.match(
      /^\/qris\/(cs_test_[a-f0-9]+)$/,
    );
    if (req.method !== 'GET' || !match) {
      response(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Only the QRIS scan endpoint is available.' },
      });
      return;
    }
    try {
      rate('scan:' + req.socket.remoteAddress, 60);
      await expirePayments();
      const current = store.data.payments.find((p) => equal(p.checkout_token, match[1]));
      ensure(
        current && current.payment_method === 'qris',
        404,
        'QR_NOT_FOUND',
        'QRIS is not available.',
      );
      const result = await store.change((s) => {
        const p = s.payments.find((p) => p.id === current.id);
        if (p.status === 'paid') return paymentView(p);
        ensure(
          p.status === 'pending' && clock() < Date.parse(p.expires_at),
          410,
          'QR_CLOSED',
          'QRIS expired or was cancelled. No payment was recorded.',
        );
        return transition(s, p, {
          outcome: 'paid',
          amount: p.amount,
          bank_reference: 'SCAN-' + p.id,
        });
      });
      const merchant = store.data.merchants.find((m) => m.id === result.merchant_id);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(
        `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QRIS simulasi diterima</title><style>body{margin:0;background:#f4f3ff;color:#19223d;font:16px system-ui,sans-serif;display:grid;min-height:100dvh;place-items:center}.card{background:white;border-radius:24px;padding:38px 26px;margin:22px;max-width:400px;text-align:center;box-shadow:0 20px 60px #5154ed18}.icon{background:#e0f7e9;color:#208153;border-radius:50%;font-size:36px;width:76px;height:76px;display:grid;place-items:center;margin:0 auto 24px}.tag{color:#5154ed;font-weight:700;font-size:11px;letter-spacing:1.4px}h1{font-size:30px;letter-spacing:-1px;line-height:1.15}strong{font-size:32px;color:#5154ed}p{font-size:14px;line-height:1.8;color:#68728a}.reference{background:#f6f6fc;padding:14px;overflow-wrap:anywhere;border-radius:12px;font-size:12px}.note{font-size:11px}</style><main class="card"><div class="icon">&#10003;</div><div class="tag">LUMEN GATEWAY / SANDBOX</div><h1>Pembayaran QRIS<br>sudah diterima.</h1><strong>Rp${result.amount.toLocaleString('id-ID')}</strong><p>${htmlEscape(merchant.name)}</p><div class="reference">${htmlEscape(result.external_id)}</div><p>Status pembayaran akan diperbarui pada aplikasi merchant melalui webhook. Kamu boleh menutup halaman ini.</p><p class="note">Simulasi pembayaran. Tidak ada uang atau saldo bank yang dipindahkan.</p></main></html>`,
      );
    } catch (error) {
      response(res, error instanceof ApiError ? error.status : 500, {
        error: {
          code: error.code || 'SCAN_FAILED',
          message: error instanceof ApiError ? error.message : 'Unable to process scan.',
        },
      });
    }
  }

  const staticFiles = {
    '/': 'portal.html',
    '/index.html': 'portal.html',
    '/portal.css': 'portal.css',
    '/portal.js': 'portal.js',
    '/checkout-v2.js': 'checkout-v2.js',
    '/docs': 'docs.html',
    '/docs.js': 'docs.js',
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const requestId = id('req');
    res.setHeader('X-Request-Id', requestId);
    try {
      const u = new URL(req.url, base || 'http://localhost'),
        path = u.pathname,
        method = req.method;
      if (method === 'GET' && path === '/health')
        return response(res, 200, {
          ok: true,
          version: '2.0.0',
          mode: 'test',
          storage: options.dataFile ? 'file' : 'memory',
        });
      if (method === 'GET' && path === '/guide.pdf') {
        try {
          const file = await readFile(
            new URL('./output/pdf/lumen-gateway-integration-guide.pdf', import.meta.url),
          );
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="lumen-gateway-integration-guide.pdf"',
          });
          res.end(file);
          return;
        } catch {
          throw new ApiError(404, 'GUIDE_NOT_FOUND', 'PDF guide is not generated yet.');
        }
      }
      if (path.startsWith('/qris/')) return await scanPayment(req, res);
      if (
        method === 'GET' &&
        (staticFiles[path] || /^\/(pay|issuer)\/cs_test_[a-f0-9]+$/.test(path))
      ) {
        const file = staticFiles[path] || 'checkout-v2.html',
          body = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, {
          'Content-Type': file.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      if (method === 'GET' && path === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(await readFile(new URL('./docs/openapi.json', import.meta.url)));
        return;
      }
      rate(`ip:${req.socket.remoteAddress}`, 300);
      if (['POST', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/portal/')) {
        const origin = req.headers.origin;
        ensure(
          !origin || origin === new URL(base).origin,
          403,
          'ORIGIN_REJECTED',
          'Use this workspace from its own origin.',
        );
      }
      const input = ['POST', 'PATCH', 'DELETE'].includes(method) ? await rawBody(req) : {};
      let match;
      if (path === '/portal/register' && method === 'POST') {
        rate(`register:${req.socket.remoteAddress}`, 5, 3600000);
        const email = clean(input.email, 200).toLowerCase(),
          name = clean(input.name, 80),
          password = String(input.password || '');
        ensure(
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && name.length >= 2,
          422,
          'INVALID_ACCOUNT',
          'Enter a workspace name and valid email address.',
        );
        ensure(
          password.length >= 10 && password.length <= 128,
          422,
          'WEAK_PASSWORD',
          'Use a password of 10-128 characters.',
        );
        const hashed = await passwordHash(password);
        const result = await store.change((s) => {
          ensure(
            !s.merchants.some((x) => x.email === email),
            409,
            'EMAIL_EXISTS',
            'This email is already registered. Sign in instead.',
          );
          const m = {
            id: id('mer'),
            name,
            email,
            password_hash: hashed,
            webhook_url: null,
            webhook_secret: token('whsec_test_'),
            created_at: date(),
          };
          s.merchants.push(m);
          const credential = issueKey(s, m, 'Default application');
          return {
            merchant: publicMerchant(m),
            credential,
            webhook_secret: m.webhook_secret,
            access_token: newSession(s, m),
          };
        });
        return response(res, 201, result, { 'Set-Cookie': sessionCookie(result.access_token) });
      }
      if (path === '/portal/login' && method === 'POST') {
        rate(`login:${req.socket.remoteAddress}`, 10, 60000);
        const email = clean(input.email, 200).toLowerCase(),
          password = String(input.password || '');
        ensure(password.length <= 128, 401, 'INVALID_LOGIN', 'Email or password is incorrect.');
        const m = store.data.merchants.find((x) => x.email === email);
        const match = await passwordMatches(
          password,
          m?.password_hash || '0'.repeat(32) + ':' + '0'.repeat(128),
        );
        ensure(m && match, 401, 'INVALID_LOGIN', 'Email or password is incorrect.');
        const access = await store.change((s) => newSession(s, m));
        return response(
          res,
          200,
          { merchant: publicMerchant(m), access_token: access },
          { 'Set-Cookie': sessionCookie(access) },
        );
      }
      if (path.startsWith('/portal/')) {
        const m = sessionAuth(req);
        rate(`merchant:${m.id}`);
        if (path === '/portal/logout' && method === 'POST') {
          const hash = digest(
            (req.headers.authorization || '').replace(/^Bearer /, '') || cookieToken(req),
          );
          await store.change((s) => (s.sessions = s.sessions.filter((x) => x.hash !== hash)));
          return response(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
        }
        if (path === '/portal/state' && method === 'GET') {
          await expirePayments();
          const s = store.data;
          return response(res, 200, {
            merchant: publicMerchant(m),
            base_url: base,
            allow_local_webhooks: allowLocal,
            credentials: s.credentials.filter((x) => x.merchant_id === m.id).map(publicKey),
            payments: s.payments
              .filter((x) => x.merchant_id === m.id)
              .map(paymentView)
              .reverse(),
            events: s.events
              .filter((x) => x.merchant_id === m.id)
              .map(({ merchant_id, ...e }) => e)
              .reverse(),
            refunds: s.refunds
              .filter((x) => x.merchant_id === m.id)
              .slice()
              .reverse(),
            receipts: s.receipts.filter((x) => x.merchant_id === m.id),
            audit: s.audit.filter((x) => x.merchant_id === m.id).slice(0, 100),
            banks: Object.keys(BANKS),
          });
        }
        if (path === '/portal/credentials' && method === 'POST') {
          const result = await store.change((s) =>
            issueKey(
              s,
              s.merchants.find((x) => x.id === m.id),
              input.name,
            ),
          );
          return response(res, 201, result);
        }
        if ((match = path.match(/^\/portal\/credentials\/([^/]+)\/revoke$/)) && method === 'POST') {
          await store.change((s) => {
            const key = scoped(s, 'credentials', match[1], m.id);
            key.revoked_at = date();
            audit(s, m.id, 'credential.revoked', key.id);
          });
          return response(res, 200, { revoked: true });
        }
        if (path === '/portal/webhook' && method === 'POST') {
          const url = validateDestination(input.url, { allowLocal });
          await store.change((s) => {
            s.merchants.find((x) => x.id === m.id).webhook_url = url;
            for (const e of s.events)
              if (e.merchant_id === m.id && e.status === 'unconfigured' && url) {
                e.target_url = url;
                e.status = 'pending';
                e.next_attempt_at = date();
              }
            audit(s, m.id, 'webhook.updated', m.id);
          });
          return response(res, 200, { webhook_url: url });
        }
        if (path === '/portal/webhook/rotate' && method === 'POST') {
          const secret = token('whsec_test_');
          await store.change((s) => {
            s.merchants.find((x) => x.id === m.id).webhook_secret = secret;
            audit(s, m.id, 'webhook.secret_rotated', m.id);
          });
          return response(res, 200, { webhook_secret: secret });
        }
        if (path === '/portal/payments' && method === 'POST') {
          return response(
            res,
            201,
            await store.change((s) =>
              createPayment(
                s,
                s.merchants.find((x) => x.id === m.id),
                input,
                req.headers['idempotency-key'],
              ),
            ),
          );
        }
        if ((match = path.match(/^\/portal\/payments\/([^/]+)\/refunds$/)) && method === 'POST')
          return response(
            res,
            201,
            await store.change((s) =>
              createRefund(s, m, match[1], input, req.headers['idempotency-key']),
            ),
          );
        if ((match = path.match(/^\/portal\/payments\/([^/]+)\/simulate$/)) && method === 'POST') {
          await expirePayments();
          return response(
            res,
            200,
            await store.change((s) => transition(s, scoped(s, 'payments', match[1], m.id), input)),
          );
        }
        if ((match = path.match(/^\/portal\/events\/([^/]+)\/retry$/)) && method === 'POST') {
          await store.change((s) => {
            const e = scoped(s, 'events', match[1], m.id);
            ensure(
              !inFlight.has(e.id),
              409,
              'DELIVERY_IN_PROGRESS',
              'An event delivery is already running.',
            );
            e.target_url = input.use_current_url ? m.webhook_url : e.target_url || m.webhook_url;
            ensure(e.target_url, 422, 'WEBHOOK_REQUIRED', 'Configure a webhook URL first.');
            e.status = 'pending';
            e.retry_count = 0;
            e.next_attempt_at = date();
            audit(s, m.id, 'webhook.replayed', e.id);
          });
          return response(res, 202, { queued: true, event_id: match[1] });
        }
        if ((match = path.match(/^\/portal\/refunds\/([^/]+)\/simulate$/)) && method === 'POST') {
          const result = await store.change((s) => {
            const r = scoped(s, 'refunds', match[1], m.id),
              p = scoped(s, 'payments', r.payment_id, m.id);
            if (r.status === 'succeeded') return r;
            ensure(
              ['succeeded', 'failed'].includes(input.outcome),
              422,
              'INVALID_OUTCOME',
              'Choose succeeded or failed.',
            );
            ensure(
              r.status === 'pending',
              409,
              'REFUND_CLOSED',
              'Retry a failed refund before simulating again.',
            );
            r.status = input.outcome;
            r.completed_at = date();
            if (r.status === 'succeeded') p.refunded_amount += r.amount;
            event(s, p, `refund.${r.status}`, { refund_id: r.id, refund_amount: r.amount });
            return r;
          });
          return response(res, 200, result);
        }
        if ((match = path.match(/^\/portal\/refunds\/([^/]+)\/retry$/)) && method === 'POST') {
          const result = await store.change((s) => {
            const r = scoped(s, 'refunds', match[1], m.id),
              p = scoped(s, 'payments', r.payment_id, m.id);
            ensure(
              r.status === 'failed',
              409,
              'REFUND_NOT_FAILED',
              'Only failed refunds can be retried.',
            );
            const reserved = s.refunds
              .filter((x) => x.payment_id === p.id && ['pending', 'succeeded'].includes(x.status))
              .reduce((n, x) => n + x.amount, 0);
            ensure(
              reserved + r.amount <= p.paid_amount,
              409,
              'REFUND_EXCEEDS_PAYMENT',
              'Refund amount is no longer available.',
            );
            r.status = 'pending';
            return r;
          });
          return response(res, 200, result);
        }
      }
      if ((match = path.match(/^\/checkout-api\/(cs_test_[a-f0-9]+)(\/qr.svg|\/simulate)?$/))) {
        const p = store.data.payments.find((x) => equal(x.checkout_token, match[1]));
        ensure(p, 404, 'CHECKOUT_NOT_FOUND', 'Checkout is not available.');
        await expirePayments();
        const current = store.data.payments.find((x) => x.id === p.id);
        if (method === 'GET' && match[2] === '/qr.svg') {
          ensure(
            current.payment_method === 'qris' && current.status === 'pending',
            409,
            'QR_UNAVAILABLE',
            'QR is not active.',
          );
          const qr = await QRCode.toString(scanUrl(p), {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 3,
            width: 280,
          });
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
          res.end(qr);
          return;
        }
        if (method === 'GET' && !match[2]) {
          const view = paymentView(current);
          return response(res, 200, {
            id: view.id,
            merchant_name: store.data.merchants.find((x) => x.id === p.merchant_id).name,
            external_id: view.external_id,
            amount: view.amount,
            currency: 'IDR',
            payment_method: view.payment_method,
            bank_code: view.bank_code,
            account_number: view.account_number,
            account_name: view.account_name,
            status: view.status,
            expires_at: view.expires_at,
            qr_image_url: view.qr_image_url,
            qr_string: view.qr_string,
            return_url: view.return_url,
            description: view.description,
            simulation_only: true,
          });
        }
        if (method === 'POST' && match[2] === '/simulate') {
          ensure(
            !input.late_payment,
            403,
            'MERCHANT_ACTION_REQUIRED',
            'Late-payment testing is available only in the merchant workspace.',
          );
          return response(
            res,
            200,
            await store.change((s) =>
              transition(
                s,
                s.payments.find((x) => x.id === p.id),
                { ...input, bank_reference: input.bank_reference || `SIM-${randomUUID()}` },
              ),
            ),
          );
        }
      }
      if (path.startsWith('/v1/')) {
        const { merchant: m, key } = apiAuth(req);
        rate(`api:${m.id}`);
        await expirePayments();
        if (path === '/v1/payment-methods' && method === 'GET')
          return response(res, 200, {
            data: [
              {
                code: 'qris',
                type: 'dynamic',
                currency: 'IDR',
                minimum_amount: 1,
                maximum_amount: 10000000,
                expires_in: { min: 60, max: 3600, default: 900 },
              },
              {
                code: 'virtual_account',
                type: 'closed_amount_single_use',
                currency: 'IDR',
                banks: Object.keys(BANKS),
                minimum_amount: 1,
                maximum_amount: 100000000,
                expires_in: { min: 60, max: 604800, default: 86400 },
              },
            ],
            mode: 'test',
          });
        if (path === '/v1/payments' && method === 'POST') {
          return response(
            res,
            201,
            await store.change((s) => {
              s.credentials.find((x) => x.id === key.id).last_used_at = date();
              return createPayment(
                s,
                s.merchants.find((x) => x.id === m.id),
                input,
                req.headers['idempotency-key'],
                key.id,
              );
            }),
          );
        }
        if (path === '/v1/payments' && method === 'GET') {
          const limit = Math.min(
              Math.max(Math.trunc(Number(u.searchParams.get('limit'))) || 20, 1),
              100,
            ),
            all = store.data.payments
              .filter(
                (x) =>
                  x.merchant_id === m.id &&
                  (!u.searchParams.get('external_id') ||
                    x.external_id === u.searchParams.get('external_id')),
              )
              .slice()
              .reverse(),
            cursor = u.searchParams.get('starting_after');
          let start = 0;
          if (cursor) {
            start = all.findIndex((x) => x.id === cursor) + 1;
            ensure(start > 0, 422, 'INVALID_CURSOR', 'Cursor is not in this result set.');
          }
          return response(res, 200, {
            data: all.slice(start, start + limit).map(paymentView),
            has_more: start + limit < all.length,
            next_cursor: start + limit < all.length ? all[start + limit - 1].id : null,
          });
        }
        if ((match = path.match(/^\/v1\/payments\/([^/]+)$/)) && method === 'GET')
          return response(res, 200, paymentView(scoped(store.data, 'payments', match[1], m.id)));
        if ((match = path.match(/^\/v1\/payments\/([^/]+)\/cancel$/)) && method === 'POST')
          return response(
            res,
            200,
            await store.change((s) => {
              const p = scoped(s, 'payments', match[1], m.id);
              if (p.status === 'cancelled') return paymentView(p);
              return transition(s, p, { outcome: 'cancelled' });
            }),
          );
        if ((match = path.match(/^\/v1\/payments\/([^/]+)\/refunds$/)) && method === 'POST')
          return response(
            res,
            201,
            await store.change((s) =>
              createRefund(s, m, match[1], input, req.headers['idempotency-key']),
            ),
          );
        if ((match = path.match(/^\/v1\/refunds\/([^/]+)$/)) && method === 'GET')
          return response(res, 200, scoped(store.data, 'refunds', match[1], m.id));
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
    } catch (error) {
      if (!res.headersSent) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        response(res, error instanceof ApiError ? error.status : 500, {
          error: {
            code: error.code && error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
            message: error instanceof ApiError ? error.message : 'An internal error occurred.',
            request_id: requestId,
          },
        });
      } else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    tick,
    snapshot: () => structuredClone(store.data),
    async listen(port = 4179, host = '127.0.0.1') {
      ensure(
        host === '127.0.0.1' ||
          host === 'localhost' ||
          (options.publicBaseUrl?.startsWith('https://') && !allowLocal),
        500,
        'PUBLIC_CONFIG_REQUIRED',
        'Public binding requires HTTPS PUBLIC_BASE_URL and ALLOW_LOCAL_WEBHOOKS=false.',
      );
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      base = (options.publicBaseUrl || `http://127.0.0.1:${server.address().port}`).replace(
        /\/$/,
        '',
      );
      if (options.scanHost) {
        const scanBase = new URL(options.scanBaseUrl || 'http://invalid');
        const parts = options.scanHost.split('.').map(Number);
        const privateLan =
          parts.length === 4 &&
          parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
          (parts[0] === 10 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168));
        ensure(
          privateLan && scanBase.protocol === 'http:' && scanBase.hostname === options.scanHost,
          500,
          'SCAN_CONFIG_INVALID',
          'The optional phone listener must bind an explicit private LAN IPv4 address matching SCAN_BASE_URL.',
        );
        scanServer = http.createServer(scanPayment);
        scanServer.requestTimeout = 10000;
        await new Promise((resolve, reject) => {
          scanServer.once('error', reject);
          scanServer.listen(Number(scanBase.port || 4181), options.scanHost, resolve);
        });
      }
      if (options.background !== false) {
        interval = setInterval(
          () =>
            tick().catch((error) =>
              console.error('Worker operation failed:', error.code || error.name),
            ),
          1000,
        );
        interval.unref();
      }
      return base;
    },
    async close() {
      closing = true;
      clearInterval(interval);
      if (scanServer) {
        scanServer.closeIdleConnections();
        await new Promise((resolve) => scanServer.close(resolve));
      }
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
      while (working) await new Promise((resolve) => setTimeout(resolve, 10));
      await store.drain();
    },
  };
}
