const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
document.querySelector('#createExample').textContent =
  `curl -X POST ${location.origin}/v1/payments \\\n  -H "Authorization: Bearer YOUR_TEST_SECRET_KEY" \\\n  -H "Idempotency-Key: invoice-101-deposit-1" \\\n  -H "Content-Type: application/json" \\\n  -d '{"external_id":"INV-101-DP-1","amount":150000,\n       "payment_method":"qris","expires_in":900}'`;
document.querySelector('#verifyExample').textContent =
  `// Node.js: verify BEFORE parsing/re-encoding JSON.
const expected = createHmac('sha256', webhookSecret)
  .update(timestamp + '.' + rawBody).digest('hex');
// Reject stale timestamp (>300 seconds), then compare in constant time.
// Require payload.id === X-Simulator-Event-Id.
// Match invoice amount/currency/reference + GET provider status.
// Atomically process the event once, then acknowledge with 2xx.`;
try {
  const spec = await (await fetch('/openapi.json')).json();
  document.querySelector('#endpointList').innerHTML =
    `<table><thead><tr><th>Method / path</th><th>Purpose</th></tr></thead><tbody>${Object.entries(
      spec.paths,
    )
      .flatMap(([path, methods]) =>
        Object.entries(methods).map(
          ([method, op]) =>
            `<tr><td><code>${esc(method.toUpperCase())} ${esc(path)}</code></td><td>${esc(op.summary)}</td></tr>`,
        ),
      )
      .join('')}</tbody></table>`;
} catch {
  document.querySelector('#endpointList').textContent =
    'OpenAPI reference could not load. See API.md in the repository.';
}
