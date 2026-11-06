# Local gateway API contract

Base URL: `http://127.0.0.1:4179` by default. All monetary `amount` values are **integer rupiah**, currency `IDR`; do not convert them to cents.

## Provider endpoints for Laravel

### Create hosted checkout

`POST /v1/payment-sessions`

Headers:

```text
Content-Type: application/json
X-API-Key: local-merchant-demo
Idempotency-Key: a-unique-key-at-least-eight-characters
```

```json
{
  "merchant_reference": "INV-2026-0001",
  "amount": 6250000,
  "currency": "IDR",
  "callback_url": "http://127.0.0.1:8000/webhooks/payments/simulator",
  "return_url": "http://127.0.0.1:8000/client/invoices/INV-2026-0001",
  "expires_seconds": 900
}
```

Response includes `id`, `provider_reference`, `provider_status`, `checkout_url`, `expires_at`, and the original merchant reference/amount. Reusing the same key and normalized input returns the same session. Changed input with the same key returns `409`.

Call this from Laravel's server, not from client-side JavaScript. The hosted checkout URL includes a token for that checkout only.

### Read provider session

`GET /v1/payment-sessions/{id}` with `X-API-Key`.

This reports provider state. It does not assert your application has processed the webhook or settled its invoice.

### Hosted checkout

- `GET /checkout.html?session={id}&token={checkout-token}` — user-facing page.
- `GET /v1/checkout/{id}?token={checkout-token}` — safe checkout details.
- `POST /v1/checkout/{id}/pay` with `token` and `scenario` (`succeeded`, `pending`, `failed`) — synthetic customer outcome.

The checkout enforces its token, pending state, and expiry. A browser return URL only navigates; the merchant must fetch its own verified invoice state.

## Signed event format

```json
{
  "id": "evt_unique-event-id",
  "type": "payment.succeeded",
  "created_at": "2026-10-31T10:00:00.000Z",
  "data": {
    "session_id": "provider-session-id",
    "merchant_reference": "INV-2026-0001",
    "provider_reference": "SIM-provider-reference",
    "amount": 6250000,
    "currency": "IDR",
    "status": "succeeded"
  }
}
```

Headers:

```text
X-Simulator-Event-Id: evt_unique-event-id
X-Simulator-Timestamp: UNIX_SECONDS
X-Simulator-Signature: HEX_HMAC_SHA256
```

Signature input is the literal timestamp, a dot, and the **raw request body**:

```text
HMAC_SHA256(WEBHOOK_SECRET, timestamp + "." + rawBody)
```

Reject timestamps outside the configured tolerance (the demo uses five minutes). Compare signatures in constant time, match the header/body event ID, and then validate references, currency, amount and event type. A retry keeps its event ID and raw payload, but receives a fresh delivery timestamp/signature.

Use unique `(provider, provider_event_id)` and unique receipt-per-attempt constraints. A valid repeated event is acknowledged without another receipt. A successful payment cannot be downgraded by a late pending/failure event. A duplicate event ID with altered content is a conflict, even if signed.

## Lab operator endpoints

All following endpoints require `X-Control-Key` (`local-control-demo` by default). They control synthetic state rather than perform real financial actions.

| Method/path                         | Function                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/state`                    | Mock invoices, sessions, events, receipts, refunds, and logs                                        |
| `POST /api/settings`                | Set `automatic_delivery` boolean                                                                    |
| `POST /api/orders`                  | Create accepted mock invoice: client label, total, deposit, hold minutes; requires idempotency key  |
| `POST /api/orders/{id}/attempts`    | Create gateway/bank-transfer attempt with amount; requires idempotency key                          |
| `POST /api/attempts/{id}/simulate`  | Generate provider outcome; optional `stale`, `late_capture`, `amount_override`, `currency_override` |
| `POST /api/events/{id}/deliver`     | Deliver/replay the exact event to its callback                                                      |
| `POST /api/orders/{id}/expire`      | Force unpaid reservation-hold expiry                                                                |
| `POST /api/orders/{id}/cancel`      | Cancel mock reservation and further collection                                                      |
| `POST /api/attempts/{id}/proof`     | Submit `filename` and PNG/JPG base64 `data_url`                                                     |
| `GET /api/attempts/{id}/proof-file` | Authorized proof preview                                                                            |
| `POST /api/attempts/{id}/review`    | Approve with bank reference or reject with reason                                                   |
| `POST /api/refunds`                 | Refund a bundled mock merchant receipt after cancellation; requires idempotency key                 |

`POST /api/webhooks/gateway` is the bundled mock merchant receiver and authenticates using the signature headers instead of the control key. External Laravel invoices must use the Laravel receiver URL.

## Failure examples

- `401`: missing key, bad checkout token, bad signature, stale timestamp.
- `409`: reused idempotency key with changed input, open attempt already exists, duplicate bank reference, event payload conflict, terminal checkout state, closed reservation.
- `422`: invalid amount/currency, proof type mismatch, amount mismatch, refund too large, non-loopback callback URL.

Responses use `{"error":{"code":"...","message":"..."}}`. A delivery failure stays visible in the event inbox and can be replayed manually. The simulator does not run an automatic retry scheduler; the Laravel inbox/outbox workers will supply durable retry behaviour.
