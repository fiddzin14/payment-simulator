# Lumen payment gateway simulator

A standalone, dependency-free Node.js tool for the approved **prototype 03**. It includes a mock merchant invoice, hosted checkout, signed gateway events, event replay, bank-transfer proof review, and cancellation/refund scenarios.

**Simulation only. No actual money, bank connection, payment provider, email, or card data is used.** All records and proof images stay in server memory and reset when it stops.

## Start

From this folder:

```powershell
node legacy-server.mjs
```

Open [Gateway Lab](http://127.0.0.1:4179). No package installation is required. Stop with `Ctrl+C`. The browser creates an illustrative invoice and pending gateway checkout when opening an empty lab.

The local control key is `local-control-demo`. This is an intentionally public development default, not a production credential. API and webhook defaults are in `.env.example`; the server reads process environment variables and does not automatically load that file.

To override configuration, set `PORT`, `SIMULATOR_CONTROL_KEY`, `MERCHANT_API_KEY`, and `WEBHOOK_SECRET` before starting Node. Bind is always loopback. Callback and return URLs must be local HTTP URLs; HTTP redirects during webhook delivery are rejected.

## Try these flows

1. **Deposit success:** click Success. The provider creates a signed event, the receiver records one receipt, the invoice becomes partially paid, and the held reservation confirms.
2. **Full settlement:** create another attempt for the remaining amount, then complete it. The invoice becomes paid.
3. **Delayed webhook:** turn off automatic sending, then click Success. Provider success appears while the merchant remains unpaid. Send the event from the inbox to post the receipt.
4. **Duplicate event:** replay a delivered event. Delivery count increases, but receipt count and balance do not.
5. **Out-of-order failure:** after success, send a late failure. The merchant preserves the successful receipt.
6. **Late capture:** expire a reservation hold, expire its attempt, then use Late capture. Funds are recorded for review; the booking stays expired.
7. **Bank transfer:** create a new invoice/attempt with bank transfer, upload a sample PNG/JPG proof, and check that nothing is credited. Approve with a verified-demo bank reference or reject with a reason. A rejected attempt can be replaced by a new one.
8. **Refund:** cancel a paid reservation, expand the receipt/refund section, and refund an amount against a receipt. Replay does not issue another refund. Refunds cannot exceed the original receipt's remaining refundable amount.

Proof images are limited to 2 MB and PNG/JPEG signatures are checked. The mock image check is a local demonstration; the Laravel implementation should validate/decode and store files privately through its upload pipeline.

## Real Laravel integration

The provider API is documented in [API.md](API.md). Laravel creates sessions server-side through `/v1/payment-sessions` with its merchant key and local webhook URL. Open the returned checkout URL in the browser. External merchant sessions appear in the lab's invoice list for simulation/replay; their actual invoice bookkeeping remains in Laravel.

The bundled mock receiver processes events synchronously to make the lab easy to inspect. The planned Laravel implementation uses the durable inbox, unique receipt constraint, transactions, and outbox described in [the architecture documents](../docs/architecture/README.md).

Gateway refunds in this lab are currently demonstrated against the bundled merchant's verified receipts. An external Laravel checkout can be paid and have events replayed; external provider-refund creation is a later adapter extension.

## Validation

```powershell
node --test test/payment-flow.test.mjs
```

The integration tests cover partial/full payments, duplicate/reordered events, delayed delivery, expired reservation capture, proof approval/rejection, duplicate bank references, idempotency conflicts, signatures/timestamps, amount mismatches, refund limits/replay, external API authentication, and checkout tokens/expiry.

The simulator demonstrates protocol/business behaviour with synthetic in-memory state. It does not test MySQL locking, real gateway credentials, real settlement, or production authentication.

Review result: all 10 integration tests pass. The lab and hosted checkout were also checked in a browser, including delayed delivery, signed checkout settlement, and desktop/mobile page widths. Saved previews are in `previews/`.
