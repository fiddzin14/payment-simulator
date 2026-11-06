import http from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function verifyWebhook(secret, raw, headers, now = Date.now()) {
  const timestamp = headers['x-simulator-timestamp'] || '',
    supplied = headers['x-simulator-signature'] || '';
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f0-9]{64}$/.test(supplied)
  )
    return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
export function createMerchantExample({ gatewayBase, apiKey, webhookSecret }) {
  const invoices = new Map(),
    processed = new Map();
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function gateway(path, body, key) {
    const r = await fetch(gatewayBase.replace(/\/$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error?.message || 'Gateway request failed');
    return value;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      let raw = '',
        bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) return json(res, 413, { error: 'Body too large' });
        raw += chunk;
      }
      if (req.method === 'POST' && path === '/demo/payments') {
        const input = JSON.parse(raw),
          reference = input.external_id || 'DEMO-' + randomUUID();
        let invoice = invoices.get(reference);
        if (!invoice) {
          invoice = {
            external_id: reference,
            amount: input.amount,
            currency: 'IDR',
            status: 'pending',
            idempotency_key: randomUUID(),
          };
          invoices.set(reference, invoice);
        }
        if (invoice.amount !== input.amount)
          return json(res, 409, { error: 'Same reference has a different amount' });
        const p = await gateway(
          '/v1/payments',
          {
            external_id: reference,
            amount: invoice.amount,
            payment_method: input.payment_method || 'qris',
            bank_code: input.bank_code,
            description: 'Example app integration',
          },
          invoice.idempotency_key,
        );
        invoice.payment_id = p.id;
        return json(res, 201, { invoice, payment: p });
      }
      if (req.method === 'POST' && path === '/webhooks/lumen') {
        if (!verifyWebhook(webhookSecret, raw, req.headers))
          return json(res, 401, { error: 'Invalid or stale signature' });
        const e = JSON.parse(raw);
        if (!e.id || e.id !== req.headers['x-simulator-event-id'] || !e.data)
          return json(res, 422, { error: 'Event ID mismatch' });
        if (processed.has(e.id)) return json(res, 200, { received: true, duplicate: true });
        if (e.type === 'payment.paid') {
          const invoice = invoices.get(e.data.external_id);
          if (!invoice || invoice.payment_id !== e.data.payment_id)
            return json(res, 409, { error: 'Invoice/payment not matched' });
          // Fetch authoritative provider state: never trust the browser return URL.
          const p = await gateway('/v1/payments/' + invoice.payment_id);
          if (
            p.status !== 'paid' ||
            p.external_id !== invoice.external_id ||
            p.amount !== invoice.amount ||
            p.currency !== 'IDR' ||
            e.data.amount !== invoice.amount ||
            e.data.currency !== 'IDR' ||
            e.data.merchant_id !== p.merchant_id
          )
            return json(res, 422, { error: 'Payment verification mismatch' });
          invoice.status = 'paid';
          invoice.paid_at = p.paid_at;
        }
        // Production: apply invoice transition and unique event insertion in ONE database transaction.
        processed.set(e.id, true);
        return json(res, 200, { received: true });
      }
      if (req.method === 'GET' && path === '/demo/invoices')
        return json(res, 200, { data: [...invoices.values()] });
      return json(res, 404, {
        error: 'Use POST /demo/payments, GET /demo/invoices, or POST /webhooks/lumen',
      });
    } catch (error) {
      json(res, 502, { error: error.message });
    }
  });
  return {
    server,
    invoices,
    processed,
    async listen(port = 4181) {
      await new Promise((r, j) => {
        server.once('error', j);
        server.listen(port, '127.0.0.1', r);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      server.closeIdleConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { GATEWAY_API_KEY, GATEWAY_WEBHOOK_SECRET } = process.env;
  if (!GATEWAY_API_KEY || !GATEWAY_WEBHOOK_SECRET) {
    console.error(
      'Set GATEWAY_API_KEY and GATEWAY_WEBHOOK_SECRET in your environment or an ignored .env file.',
    );
    process.exitCode = 1;
  } else {
    const app = createMerchantExample({
      gatewayBase: process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:4179',
      apiKey: GATEWAY_API_KEY,
      webhookSecret: GATEWAY_WEBHOOK_SECRET,
    });
    console.log('Example app: ' + (await app.listen(Number(process.env.EXAMPLE_PORT || 4181))));
    console.log('Configure gateway webhook: /webhooks/lumen on this example app.');
    process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  }
}
