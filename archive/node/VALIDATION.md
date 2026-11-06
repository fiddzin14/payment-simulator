# Validation - Gateway v2

Reviewed 4 November 2026.

- `node --test test/*.test.mjs`: **28 passed**, 0 failed (18 v2 / 10 legacy).
- Syntax checks passed for server/service/browser JavaScript.
- HTTP suite includes merchant isolation, credential lifecycle, both payment channels, QR SVG, concurrent idempotency, exact/duplicate payments, expiry and late receipts, signed webhook retries/replay, refund bounds, persistence, callback restrictions, runnable receiver, signup throttling, and docs/OpenAPI/PDF delivery.
- Browser: automatic registration displayed one-time credentials immediately; QRIS payer settled; VA underpayment produced a clear error and exact payment settled; partial refund changed net volume once.
- Browser: desktop/mobile merchant workspace, mobile navigation, active QRIS checkout, and online docs checked. No horizontal page overflow or JavaScript errors observed in checked views.
- PDF: 13 pages generated, text/page count checked, every page rendered with PDFium, contact sheet and representative full-size code/reference pages visually inspected. No clipped text, overflow, or broken glyphs observed.
- Browser QA used isolated disposable state at `tmp/browser-qa-gateway.json`. The normal `.data/gateway.json` starts independently.
- Screenshots: `previews/gateway-v2-desktop.png`, `gateway-v2-mobile.png`, `qris-v2-desktop.png`, `qris-v2-mobile.png`, `va-v2-desktop.png`.

Limits: this is a single-process file-backed sandbox, not a certified/live gateway or a horizontally scaled service. Public deployment and real bank integration were not performed. Laravel snippets describe future app integration; no Laravel app or database was created.
