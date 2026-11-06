# Lumen Gateway Laravel API contract

Base URL: `http://127.0.0.1:4179`. JSON only. Currency IDR; amount is an integer rupiah value. All instruments and funds are test-only. The contract is independent of Midtrans/Xendit; their SDKs are not compatible.

## Credentials without approval

`POST /portal/register` (no API key):

```json
{
  "name": "My booking app",
  "email": "developer@example.test",
  "password": "your-test-password-10plus"
}
```

Returns 201 immediately with `merchant`, `credential.secret_key`, `webhook_secret`, and a 24-hour `access_token`. The browser also receives an HttpOnly session cookie. Secrets are only returned on creation. Email is not verified. Login: `POST /portal/login` with email/password. Logout: `POST /portal/logout` with session authentication. Portal operations require the cookie or `Authorization: Bearer sess_...` and same-origin browser requests.

## Merchant API

Every `/v1/*` request requires `Authorization: Bearer sk_test_...`. Do not send a portal session token as an API key. Key revocation takes effect on the next request.

### GET /v1/payment-methods

Returns QRIS and VA capabilities, supported banks, expiry and amount limits.

### POST /v1/payments

Required `Idempotency-Key` header: 8-100 characters. Reuse the same value and identical body for retries. A different body with the same key returns 409. Keys are scoped by merchant and operation and retained in MySQL. An external_id is unique per merchant, including terminal payments; a new attempt uses a new external_id.

| Field          | Rules                                                              |
| -------------- | ------------------------------------------------------------------ |
| external_id    | Required, 1-100 characters after trimming                          |
| amount         | Required positive integer; QRIS <= 10,000,000; VA <= 100,000,000   |
| currency       | Optional, IDR only                                                 |
| payment_method | qris or virtual_account                                            |
| bank_code      | VA only: BCA / BNI / BRI / MANDIRI / PERMATA                       |
| expires_in     | Seconds; QRIS 60-3600 (default 900), VA 60-604800 (default 86400)  |
| description    | Optional, max 300 characters                                       |
| customer_name  | Optional dummy label, max 100 characters                           |
| return_url     | Optional absolute URL, HTTPS publicly; loopback HTTP in local mode |

QRIS request:

```json
{
  "external_id": "INV-101-DP-1",
  "amount": 150000,
  "currency": "IDR",
  "payment_method": "qris",
  "expires_in": 900,
  "description": "Booking deposit"
}
```

VA request:

```json
{
  "external_id": "INV-102-DP-1",
  "amount": 250000,
  "payment_method": "virtual_account",
  "bank_code": "BCA",
  "expires_in": 86400
}
```

Returns 201: `id`, `merchant_id`, `external_id`, amount/currency/method, status, created_at/expires_at/paid_at, paid_amount, refunded_amount, late_received_amount, `checkout_url`, `qr_string`, `qr_image_url`, account_number/account_name/bank_code, description/customer_name, `simulation_only: true`. Fields not relevant to a channel are null. qr_string is the sandbox payer URL including the transaction token and amount, not an EMV QRIS payload. account_number is synthetic, not bank allocated.

### GET /v1/payments/{payment_id}

Authoritative provider status. Compare merchant_id, external_id, amount, currency, and status with your invoice. Browser redirect is not proof. Payment state is independent of webhook delivery status.

### GET /v1/payments

Query: `limit` (1-100, default 20), `starting_after` (a returned payment ID), `external_id` (exact filter). Newest first. Returns `data`, `has_more`, `next_cursor`. Only this merchant's records are visible.

### POST /v1/payments/{payment_id}/cancel

Cancels a pending payment. Repeating cancellation is harmless. Paid/failed/expired payments cannot be changed to cancelled.

### POST /v1/payments/{payment_id}/refunds

Idempotency-Key required. Body: `amount` positive integer, `reason` at least 3 characters. Returns pending refund with `id`, payment_id, amount, currency, status, created_at. Pending/succeeded amounts reserve the refundable balance. No refund may exceed original paid funds. GET `/v1/refunds/{refund_id}` retrieves status. Simulate completion/failure through portal; failed refunds can be retried. Success is idempotent, increases refunded_amount once, and retains the original payment receipt. Refunds are simulated, not fund transfers. Late/quarantined funds require out-of-band operator reconciliation and cannot use this settled-payment refund endpoint.

## One-scan QR payment endpoint

`GET /qris/{checkout_token}?amount=150000` records the pending QRIS payment immediately and returns a mobile HTML confirmation. The stored amount is authoritative; editing or omitting the query amount cannot alter it. No API key or portal session is required because the payment-specific checkout token is a bearer capability. Repeated paid scans return the same success without another receipt or event. Expired/cancelled/failed payments return 410; VA or unknown tokens return 404. A successful first scan emits the normal signed `payment.paid` event. The merchant application must still verify the webhook and provider status; browser navigation itself is not proof of payment.

`qr_string` and the generated SVG encode this `/qris/` URL. For LAN mobile demos set gateway `APP_URL=http://PRIVATE_IP:4179` and bind the PHP development server to an interface reachable from the phone. Production uses the gateway HTTPS domain; there is no separate Node/LAN listener. All amounts and receipts remain test data.

## Hosted payer endpoints

`GET /pay/{checkout_token}` displays QRIS/VA instructions. `GET /issuer/{checkout_token}` shows the payer/bank simulator. The unguessable checkout token is a bearer capability: anyone holding that URL may run payment scenarios. Do not use real data or share test checkout links unintentionally.

- `GET /checkout-api/{checkout_token}`: limited public checkout details.
- `GET /checkout-api/{checkout_token}/qr.svg`: active QRIS image. Closed QR returns 409.
- `POST /checkout-api/{checkout_token}/simulate`: `outcome` paid/pending/failed/expired/cancelled, `amount` (paid only; defaults to expected), optional bank_reference (auto-generated if omitted). Wrong amount returns 422. Closed payment returns 409. Duplicate same reference/payment is idempotent. A different reference cannot credit a paid payment again. Late-payment scenarios require merchant portal authorization.

## Webhooks

Configure URL in **Webhook & event** before creating payment. The payment snapshots the configured URL. With no URL, events are `unconfigured`; saving a URL queues those events. Existing event snapshots are preserved unless manual replay explicitly selects the current URL.

Headers:

```text
Content-Type: application/json
X-Simulator-Event-Id: evt_...
X-Simulator-Timestamp: <Unix seconds at delivery>
X-Simulator-Signature: <lowercase hex HMAC-SHA256>
```

Signature: `HMAC_SHA256(webhook_secret, timestamp + "." + exact_raw_body)`.

Validate the timestamp within +/-300 seconds and compare signatures in constant time. Parse JSON only after verifying the raw bytes. Require payload.id to match X-Simulator-Event-Id. Then match the payment/invoice reference, merchant, integer amount and currency, and retrieve provider status from the backend. Apply invoice changes and record a unique event ID atomically in your app's database; acknowledge duplicates with 2xx. Do not downgrade a paid invoice on a stale pending/failed event.

```json
{
  "id": "evt_example",
  "type": "payment.paid",
  "api_version": "2026-11-04",
  "created_at": "2026-11-04T05:00:00.000Z",
  "data": {
    "payment_id": "pay_example",
    "merchant_id": "mer_example",
    "external_id": "INV-101-DP-1",
    "amount": 150000,
    "currency": "IDR",
    "payment_method": "qris",
    "bank_code": null,
    "status": "paid",
    "paid_amount": 150000,
    "refunded_amount": 0
  }
}
```

Types: payment.pending, payment.paid, payment.expired, payment.failed, payment.cancelled, payment.late_received, refund.pending, refund.succeeded, refund.failed. Refund events add refund_id/refund_amount. Late events add received_amount/needs_review and retain the terminal payment status. Do not fulfill late_received.

Delivery is asynchronous, at least once. Any 2xx acknowledges. Timeout (4s), network failures, redirects and other statuses retry after 5s/30s/120s/600s/1800s/7200s: initial + six retries. Due retries/expiry resume after restart. Event ID and payload stay constant; each delivery has a fresh timestamp/signature. After exhaustion status is failed; manual replay starts another cycle. The Laravel `gateway:work` command runs local cycles every second, or `gateway:tick` is invoked by the scheduler/cron; each batch processes up to 10 due events. Webhook secret rotation affects all subsequent deliveries. Event data is a historical snapshot, so GET status can be newer.

## Portal management endpoints

All require a workspace cookie/session bearer:

| Method/path                          | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| GET /portal/state                    | Only this merchant's state, masked credentials, audit |
| POST /portal/credentials             | Issue key: name; max 10 active                        |
| POST /portal/credentials/{id}/revoke | Revoke one key immediately                            |
| POST /portal/webhook                 | Set url or empty to clear merchant default            |
| POST /portal/webhook/rotate          | Return a new one-time signing secret                  |
| POST /portal/payments                | Same creation body and Idempotency-Key as v1          |
| POST /portal/payments/{id}/simulate  | Payer outcome; supports late_payment=true             |
| POST /portal/payments/{id}/refunds   | Same refund body/idempotency as v1                    |
| POST /portal/refunds/{id}/simulate   | outcome succeeded or failed                           |
| POST /portal/refunds/{id}/retry      | Retry a failed refund                                 |
| POST /portal/events/{id}/retry       | use_current_url boolean, optional                     |

## Errors and controls

```json
{
  "error": {
    "code": "AMOUNT_MISMATCH",
    "message": "Closed-amount payments require the exact amount. No funds were recorded.",
    "request_id": "req_example"
  }
}
```

400 invalid JSON; 401 invalid key/login; 403 origin/action restriction; 404 missing or another merchant's resource; 409 duplicate/conflicting/closed operation; 413 body >64 KB; 422 validation; 429 rate limit (Retry-After); 500 internal error. Rate limits and public callback restrictions are documented in README. APIs have no browser cross-origin CORS allowance: call them from your backend. Health: GET `/health`.

## Design references

The simulator's own versioned protocol is implemented by Laravel services in app/Services. The former Node runtime and its previous tests are archived in archive/node; those results do not validate this port. General behavior references, accessed 4 November 2026:

- Bank Indonesia QRIS overview: https://www.bi.go.id/id/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx
- Midtrans server-side notification verification and idempotency: https://docs.midtrans.com/docs/https-notification-webhooks
- Xendit webhook handling/retry principles: https://docs.xendit.co/docs/handling-webhooks
- Xendit API credential separation: https://docs.xendit.co/docs/api-keys
- Laravel HTTP client API: https://api.laravel.com/docs/12.x/Illuminate/Http/Client/PendingRequest.html

Bank Indonesia describes dynamic QRIS as carrying the amount and states a Rp10 million transaction cap. This simulator uses that QRIS test amount ceiling. VA limits, expiry ranges, HMAC protocol, and retry intervals here are explicit simulator policy, not a claim to reproduce any particular provider's API or certification.
