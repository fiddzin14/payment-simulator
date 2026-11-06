# Laravel gateway integration

Backend simulator is now Laravel/MySQL. Activate it using [the gateway README](../README.md), then configure Lumen Studio using [the shared-hosting tutorial](../../lumen-studio/docs/DEPLOYMENT-SHARED-HOSTING.md). The existing HTTP/HMAC snippets below remain examples; the complete studio adapter is `lumen-studio/app/Services/SimulatorGateway.php`.

# Laravel connection snippets (no Laravel project is created)

These snippets show where to connect the gateway when you implement your Laravel app. The runnable Node example is in `merchant-app.mjs`. Replace domain/model logic with your own invoice schema and authorization checks.

## Environment and services configuration

```dotenv
LUMEN_GATEWAY_URL=http://127.0.0.1:4179
LUMEN_GATEWAY_KEY=sk_test_REPLACE_ME
LUMEN_WEBHOOK_SECRET=whsec_test_REPLACE_ME
```

Add to `config/services.php`:

```php
'lumen' => [
    'url' => env('LUMEN_GATEWAY_URL'),
    'key' => env('LUMEN_GATEWAY_KEY'),
    'webhook_secret' => env('LUMEN_WEBHOOK_SECRET'),
],
```

## Create an invoice payment from the backend

```php
use Illuminate\Support\Facades\Http;

// Authorize invoice ownership first. Calculate amount from your own invoice.
// Persist this key per payment attempt; reuse it after a timeout/retry.
$idempotencyKey = $invoice->gateway_idempotency_key;

$payment = Http::acceptJson()
  ->withToken(config('services.lumen.key'))
  ->withHeaders(['Idempotency-Key' => $idempotencyKey])
  ->connectTimeout(3)
  ->timeout(10)
  ->post(config('services.lumen.url') . '/v1/payments', [
    'external_id' => $invoice->number . '-DP-' . $attemptNumber,
    'amount' => (int) $invoice->deposit_due,
    'payment_method' => 'qris',
    'expires_in' => 900,
    'description' => 'Booking deposit',
  ])
  ->throw()
  ->json();

// Persist payment.id + external_id on the payment attempt before redirecting.
return redirect()->away($payment['checkout_url']);
```

For VA, use `payment_method=virtual_account`, `bank_code=BCA`, and `expires_in=86400`. Send the same JSON and idempotency key on transport retry. Never accept the amount supplied by the browser as authoritative.

## Verify the raw webhook

Register a POST endpoint reachable by the gateway. Prefer a stateless API route (commonly `/api/webhooks/lumen`); if using web middleware, configure CSRF exemption only for this signed callback route. Do not disable CSRF globally. No session login should be required for this endpoint.

```php
use Illuminate\Http\Request;

$raw = $request->getContent();
$timestamp = (string) $request->header('X-Simulator-Timestamp', '');
$signature = (string) $request->header('X-Simulator-Signature', '');

abort_unless(ctype_digit($timestamp), 401);
abort_if(abs(time() - (int) $timestamp) > 300, 401);
$expected = hash_hmac('sha256', $timestamp . '.' . $raw, config('services.lumen.webhook_secret'));
abort_unless(hash_equals($expected, $signature), 401);

$event = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
abort_unless(
  isset($event['id'], $event['data']) && $event['id'] === $request->header('X-Simulator-Event-Id'),
  422,
);
```

## Apply business state atomically (adaptation required)

This part depends on your future app schema; these are integration requirements, not migrations or a prebuilt controller:

1. Durably enqueue the verified event or open a DB transaction.
2. Use a unique event ID constraint for deduplication. Acknowledge processed duplicates with 2xx.
3. Find and lock the matching invoice/payment attempt by provider payment ID plus external ID.
4. For `payment.paid`, use the server-side GET status endpoint and compare merchant ID, invoice reference, amount, currency, and status. Your invoice owns the expected amount.
5. In one transaction, record the receipt, apply the invoice transition, and insert the processed event ID. Never insert the dedupe record first and fail before updating the invoice.
6. Acknowledge quickly after durable receipt/processing. If queued, your worker must retry failed business processing separately.
7. Do not downgrade paid invoices on stale pending/expired/failed events. Treat refund and late_received events separately.

Keep work within the simulator's four-second delivery timeout, or durably enqueue and acknowledge promptly. Configure the callback URL in the merchant workspace. A return_url is only customer navigation and must not settle an invoice.

## Local runnable demonstration

Set `GATEWAY_API_KEY` and `GATEWAY_WEBHOOK_SECRET` in an ignored environment file, then:

```powershell
node --env-file=.env examples/merchant-app.mjs
```

Set the merchant webhook to `http://127.0.0.1:4181/webhooks/lumen`. POST an integer amount and method to `http://127.0.0.1:4181/demo/payments`. Open the returned checkout URL and simulate payment. GET `/demo/invoices` to see the example invoice become paid only after a signed verified webhook. This tiny example uses in-memory invoices/deduplication for demonstration; production app state needs durable transactions.
