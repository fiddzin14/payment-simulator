const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const money = (value) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value || 0);
const time = (value) =>
  new Date(value).toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const labels = {
  pending: 'Pending',
  succeeded: 'Berhasil',
  failed: 'Gagal',
  expired: 'Kedaluwarsa',
  cancelled: 'Dibatalkan',
  rejected: 'Ditolak',
  confirmed: 'Terkonfirmasi',
  awaiting_deposit: 'Menunggu DP',
  partial: 'Dibayar sebagian',
  paid: 'Lunas',
  unpaid: 'Belum dibayar',
  overpaid: 'Kelebihan bayar',
  processed: 'Diproses',
  ignored: 'Diabaikan',
  quarantined: 'Perlu review',
  not_received: 'Belum diterima',
  external: 'Server eksternal',
};
const badge = (status) =>
  `<span class="status ${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span>`;
let data = null,
  selected = null,
  toastTimer,
  proofUrl;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: {
      'X-Control-Key': $('#controlKey').value,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Request failed.');
  return result;
}
const currentOrder = () => data.orders.find((order) => order.id === selected);
const currentAttempts = () =>
  selected?.startsWith('external:')
    ? data.attempts.filter((attempt) => attempt.id === selected.slice(9))
    : data.attempts.filter((attempt) => attempt.order_id === selected);
async function refresh() {
  data = await api('/api/state');
  const external = data.attempts.find((attempt) => !attempt.order_id),
    exists =
      data.orders.some((order) => order.id === selected) ||
      (selected?.startsWith('external:') &&
        data.attempts.some((attempt) => attempt.id === selected.slice(9)));
  if (!exists) selected = data.orders[0]?.id || (external ? `external:${external.id}` : null);
  render();
}
async function action(button, run) {
  if (button) button.disabled = true;
  try {
    await run();
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}
function render() {
  const order = currentOrder(),
    attempts = currentAttempts(),
    attempt = attempts[0];
  $('#automaticDelivery').checked = data.automatic_delivery;
  const pendingEvents = data.events.filter((event) => !event.deliveries.at(-1)?.ok).length,
    received =
      data.payments.reduce((sum, item) => sum + item.amount, 0) -
      data.refunds
        .filter((item) => item.merchant_status === 'succeeded')
        .reduce((sum, item) => sum + item.amount, 0),
    reviews = data.attempts.filter(
      (item) => item.method === 'bank_transfer' && item.proof && item.provider_status === 'pending',
    ).length;
  $('#metrics').innerHTML = [
    [data.orders.length, 'Invoice merchant', 'Mock invoice yang sudah diterbitkan'],
    [money(received), 'Penerimaan terverifikasi', 'Net receipt setelah refund demo'],
    [pendingEvents, 'Webhook belum terkirim', 'Termasuk pengiriman tertunda / gagal'],
    [reviews, 'Transfer perlu review', 'Proof belum menambah saldo invoice'],
  ]
    .map(
      ([value, label, small]) =>
        `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${small}</small></article>`,
    )
    .join('');
  $('#orderList').innerHTML =
    data.orders
      .map(
        (item) =>
          `<button class="order-list-item ${selected === item.id ? 'active' : ''}" data-order="${item.id}"><small>${escapeHtml(item.number)}</small><strong>${escapeHtml(item.client_label)}</strong><span class="order-row-bottom">${badge(item.payment_status)}<span>${money(item.total_amount)}</span></span></button>`,
      )
      .join('') +
    data.attempts
      .filter((item) => !item.order_id)
      .map(
        (item) =>
          `<button class="order-list-item ${selected === `external:${item.id}` ? 'active' : ''}" data-order="external:${item.id}"><small>EXTERNAL MERCHANT</small><strong>${escapeHtml(item.merchant_reference)}</strong><span class="order-row-bottom">${badge(item.provider_status)}<span>${money(item.amount)}</span></span></button>`,
      )
      .join('');
  if (order) {
    $('#merchantPanel').innerHTML =
      `<div class="invoice-heading"><div><small>MOCK MERCHANT / ${escapeHtml(order.number)}</small><h2>${escapeHtml(order.client_label)}</h2></div>${badge(order.booking_status)}</div><p class="invoice-subtitle">DP minimum ${money(order.deposit_amount)} · Quote sudah diterima.</p><div class="balance-grid"><div><span>Total invoice</span><strong>${money(order.total_amount)}</strong></div><div><span>Sisa tagihan</span><strong>${money(order.balance_amount)}</strong></div><div class="balance-paid"><span>Penerimaan net terverifikasi</span><strong>${money(order.net_paid_amount)}</strong></div><div><span>Status pembayaran</span><strong style="font-size:15px">${labels[order.payment_status] || order.payment_status}</strong></div></div><div class="invoice-footer"><span>Hold hingga ${new Date(order.hold_expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</span><span><button class="button secondary small" data-order-action="expire" ${order.booking_status === 'confirmed' || order.cancelled ? 'disabled' : ''}>Expire hold</button> <button class="button danger small" data-order-action="cancel" ${order.cancelled ? 'disabled' : ''}>Batalkan</button></span></div>`;
  } else {
    $('#merchantPanel').innerHTML =
      `<div class="invoice-heading"><div><small>EXTERNAL MERCHANT</small><h2>${escapeHtml(attempt?.merchant_reference || 'Pilih invoice')}</h2></div>${badge('external')}</div><p class="invoice-subtitle">Pembukuan invoice dan status reservasi berada di aplikasi Laravel.</p><div class="balance-grid"><div><span>Nilai checkout</span><strong>${money(attempt?.amount)}</strong></div><div><span>Receiver</span><strong style="font-size:12px;word-break:break-all">${escapeHtml(attempt?.callback_url || '—')}</strong></div></div>`;
  }
  const open = attempts.some(
      (item) =>
        item.provider_status === 'pending' ||
        (item.provider_status === 'succeeded' && item.merchant_status !== 'succeeded'),
    ),
    amount = order
      ? order.deposit_due_amount > 0
        ? Math.min(order.deposit_due_amount, order.balance_amount)
        : order.balance_amount
      : 0;
  $('#attemptPanel').innerHTML =
    `<div class="panel-heading"><h2>Payment attempt</h2><span class="count">${attempts.length}</span></div>${order ? `<form class="attempt-form" id="attemptForm"><label class="field">Metode<select name="method"><option value="gateway">Payment gateway</option><option value="bank_transfer">Transfer bank</option></select></label><label class="field">Jumlah (rupiah)<input type="number" name="amount" value="${amount}" min="1" max="${order.balance_amount}" step="1" required></label><button class="button primary" type="submit" ${open || order.balance_amount === 0 || ['expired', 'cancelled'].includes(order.booking_status) ? 'disabled' : ''}>Buat attempt ↗</button></form>` : ''}${attempt ? renderAttempt(attempt) : '<div class="empty">Pilih metode dan buat payment attempt pertama.</div>'}`;
  renderReceipts(order);
  const ids = new Set(attempts.map((item) => item.id)),
    events = data.events.filter((event) => ids.has(event.attempt_id));
  $('#eventCount').textContent = events.length;
  $('#eventList').innerHTML = events.length
    ? events
        .map((event) => {
          const last = event.deliveries.at(-1);
          return `<article class="event-list-item"><div class="event-top"><strong>${escapeHtml(event.type)}</strong><small>${time(event.created_at)}</small></div><p class="event-id">${escapeHtml(event.id)}</p><div class="event-delivery"><span>${event.deliveries.length} pengiriman</span><span class="${last?.ok ? 'http-ok' : 'http-fail'}">${last ? `HTTP ${last.http_status || 'ERROR'}` : 'Belum dikirim'}</span></div>${badge(order ? event.merchant_processing : 'external')}<div><button class="button secondary small" data-deliver="${event.id}">${event.deliveries.length ? 'Replay event yang sama ↻' : 'Kirim webhook ↗'}</button></div><details><summary>Payload & respons</summary><pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>${last ? `<pre>${escapeHtml(last.response)}</pre>` : ''}</details></article>`;
        })
        .join('')
    : '<div class="empty">Belum ada event. Simulasikan hasil pembayaran.</div>';
  $('#activityList').innerHTML =
    data.logs
      .slice(0, 10)
      .map(
        (item) =>
          `<div class="activity-row"><time>${time(item.at)}</time><span>${escapeHtml(item.type)}</span><span>${escapeHtml(item.message)}</span></div>`,
      )
      .join('') || '<div class="empty">Aktivitas akan muncul di sini.</div>';
  const proofImage = $('#proofPreview');
  if (proofUrl) {
    URL.revokeObjectURL(proofUrl);
    proofUrl = null;
  }
  if (proofImage && attempt?.proof) {
    fetch(`/api/attempts/${attempt.id}/proof-file`, {
      headers: { 'X-Control-Key': $('#controlKey').value },
    })
      .then((response) => {
        if (!response.ok) throw new Error('Proof unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (proofImage.isConnected) {
          proofUrl = URL.createObjectURL(blob);
          proofImage.src = proofUrl;
        }
      })
      .catch(() => {});
  }
}
function renderAttempt(attempt) {
  return `<div class="attempt-card"><div class="attempt-top"><strong>${attempt.method === 'gateway' ? 'Gateway checkout' : 'Transfer bank'}</strong><span>${money(attempt.amount)}</span></div><div class="attempt-id">${escapeHtml(attempt.id)}</div><div class="status-pair"><div><small>Provider / attempt</small>${badge(attempt.provider_status)}</div><div><small>Merchant</small>${badge(attempt.merchant_status || 'external')}</div></div>${attempt.method === 'gateway' ? `<a class="button secondary full" href="${escapeHtml(attempt.checkout_url)}" target="_blank" rel="noopener">Buka hosted checkout ↗</a><p class="simulate-label">PROVIDER SCENARIOS</p><div class="attempt-actions"><button class="button green small" data-simulate="succeeded">Success</button><button class="button secondary small" data-simulate="pending">Pending</button><button class="button danger small" data-simulate="failed">Failed</button><button class="button secondary small" data-simulate="expired">Expired</button></div><div class="attempt-actions"><button class="button secondary small" data-stale ${attempt.provider_status !== 'succeeded' ? 'disabled' : ''}>Kirim failure lama</button><button class="button secondary small" data-late ${!['failed', 'expired', 'cancelled'].includes(attempt.provider_status) ? 'disabled' : ''}>Late capture</button></div><p class="scenario-note">Success mencatat hasil provider. Jeda webhook untuk melihat invoice tetap menunggu verifikasi. Replay menggunakan ID event yang sama.</p>` : `${attempt.proof ? `<p class="scenario-note">Proof: ${escapeHtml(attempt.proof.filename)} · ${(attempt.proof.size / 1024).toFixed(1)} KB</p><img id="proofPreview" class="proof-preview" alt="Bukti transfer demo">` : `${attempt.provider_status === 'pending' ? '<form id="proofForm" class="proof-upload"><label for="proofFile">Upload bukti transfer demo</label><input id="proofFile" type="file" accept="image/png,image/jpeg" required><button class="button secondary small" type="submit">Upload proof ↗</button><p class="scenario-note">PNG / JPG, maksimal 2 MB. Upload belum mengubah status paid.</p></form>' : ''}`}${attempt.proof && attempt.provider_status === 'pending' ? '<form id="reviewForm" class="review-form"><strong>Admin review</strong><label class="field">Referensi bank yang sudah diverifikasi<input name="bank_reference" placeholder="BANK-DEMO-001"></label><label class="field">Alasan jika ditolak<input name="reason" placeholder="Contoh: dana belum masuk"></label><div class="attempt-actions"><button type="button" class="button green small" data-review="approve">Verifikasi & kreditkan ✓</button><button type="button" class="button danger small" data-review="reject">Tolak proof</button></div></form>' : ''}${attempt.rejection_reason ? `<p class="rejection-note">Ditolak: ${escapeHtml(attempt.rejection_reason)}</p>` : ''}`}</div>`;
}
function renderReceipts(order) {
  const payments = order ? data.payments.filter((item) => item.order_id === order.id) : [],
    refunds = order ? data.refunds.filter((item) => item.order_id === order.id) : [];
  $('#receiptPanel').innerHTML =
    `<div class="panel-heading"><h2>Receipt & refund ledger</h2><span class="count">${payments.length}</span></div><p class="panel-description">Satu receipt untuk setiap attempt yang terverifikasi.</p><div class="receipt-list">${payments.length ? payments.map((item) => `<div class="receipt-row"><div><strong>${money(item.amount)}</strong><small>${escapeHtml(item.method)} · ${time(item.received_at)}</small>${item.needs_review ? `<span class="review-flag">Review: ${escapeHtml(item.review_reason)}</span>` : ''}</div><span>${escapeHtml(item.id.slice(0, 16))}<br>VERIFIED</span></div>`).join('') : '<div class="empty">Belum ada penerimaan terverifikasi.</div>'}</div>${payments.length ? `<details class="refund-section"><summary>Skenario refund setelah pembatalan</summary><p>Batalkan reservasi, lalu pilih receipt dan jumlah pengembalian. Semua dana tetap simulasi.</p><form id="refundForm"><label class="field">Receipt<select name="payment_id">${payments.map((item) => `<option value="${item.id}">${money(item.amount)} · ${item.id.slice(0, 14)}</option>`).join('')}</select></label><label class="field">Refund (rupiah)<input name="amount" type="number" min="1" step="1" value="${payments[0].amount}" required></label><label class="field">Alasan<input name="reason" value="Pembatalan sesi demo" required></label><button class="button secondary" type="submit" ${!order?.cancelled ? 'disabled' : ''}>Simulasikan refund ↗</button></form>${refunds.map((item) => `<div class="refund-status">${money(item.amount)} · ${badge(item.merchant_status)}</div>`).join('')}</details>` : ''}`;
}
$('#refreshButton').addEventListener('click', () =>
  action($('#refreshButton'), async () => {
    await refresh();
    toast('State simulator diperbarui.');
  }),
);
$('#automaticDelivery').addEventListener('change', (event) =>
  action(null, async () => {
    await api('/api/settings', 'POST', { automatic_delivery: event.target.checked });
    toast(
      event.target.checked
        ? 'Webhook otomatis aktif.'
        : 'Webhook ditahan. Kirim dari inbox untuk memprosesnya.',
    );
  }),
);
$('#openCreate').addEventListener('click', () => $('#createDialog').showModal());
$('#closeCreate').addEventListener('click', () => $('#createDialog').close());
$('#createForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(event.target);
  action(event.submitter, async () => {
    const order = await api('/api/orders', 'POST', {
      client_label: values.get('client_label'),
      total_amount: Number(values.get('total_amount')),
      deposit_amount: Number(values.get('deposit_amount')),
      hold_minutes: Number(values.get('hold_minutes')),
    });
    selected = order.id;
    $('#createDialog').close();
    toast('Invoice demo baru dibuat.');
  });
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'attemptForm') {
    event.preventDefault();
    const values = new FormData(event.target);
    action(event.submitter, () =>
      api(`/api/orders/${selected}/attempts`, 'POST', {
        method: values.get('method'),
        amount: Number(values.get('amount')),
      }),
    );
  }
  if (event.target.id === 'proofForm') {
    event.preventDefault();
    const file = $('#proofFile').files[0];
    if (!file) return;
    action(event.submitter, async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error('Proof maksimal 2 MB.');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('File tidak bisa dibaca.'));
        reader.readAsDataURL(file);
      });
      await api(`/api/attempts/${currentAttempts()[0].id}/proof`, 'POST', {
        data_url: dataUrl,
        filename: file.name,
      });
      toast('Proof menunggu review. Saldo belum berubah.');
    });
  }
  if (event.target.id === 'refundForm') {
    event.preventDefault();
    const values = new FormData(event.target);
    action(event.submitter, () =>
      api('/api/refunds', 'POST', {
        payment_id: values.get('payment_id'),
        amount: Number(values.get('amount')),
        reason: values.get('reason'),
      }),
    );
  }
});
document.addEventListener('click', (event) => {
  const order = event.target.closest('[data-order]'),
    simulate = event.target.closest('[data-simulate]'),
    deliver = event.target.closest('[data-deliver]'),
    review = event.target.closest('[data-review]'),
    orderAction = event.target.closest('[data-order-action]'),
    stale = event.target.closest('[data-stale]'),
    late = event.target.closest('[data-late]');
  if (order) {
    selected = order.dataset.order;
    render();
  }
  if (simulate)
    action(simulate, () =>
      api(`/api/attempts/${currentAttempts()[0].id}/simulate`, 'POST', {
        status: simulate.dataset.simulate,
      }),
    );
  if (deliver)
    action(deliver, async () => {
      const result = await api(`/api/events/${deliver.dataset.deliver}/deliver`, 'POST', {});
      toast(result.ok ? 'Webhook diakui receiver.' : 'Pengiriman gagal. Lihat respons pada event.');
    });
  if (orderAction)
    action(orderAction, () =>
      api(`/api/orders/${selected}/${orderAction.dataset.orderAction}`, 'POST', {}),
    );
  if (stale)
    action(stale, () =>
      api(`/api/attempts/${currentAttempts()[0].id}/simulate`, 'POST', {
        status: 'failed',
        stale: true,
      }),
    );
  if (late)
    action(late, () =>
      api(`/api/attempts/${currentAttempts()[0].id}/simulate`, 'POST', {
        status: 'succeeded',
        late_capture: true,
      }),
    );
  if (review) {
    const values = new FormData($('#reviewForm'));
    action(review, async () => {
      await api(`/api/attempts/${currentAttempts()[0].id}/review`, 'POST', {
        decision: review.dataset.review,
        bank_reference: values.get('bank_reference'),
        reason: values.get('reason'),
      });
      toast(
        review.dataset.review === 'approve'
          ? 'Transfer terverifikasi dan receipt dicatat.'
          : 'Proof ditolak tanpa menambah saldo.',
      );
    });
  }
});
window.addEventListener('focus', () => {
  if (data && !$('#createDialog').open) refresh().catch(() => {});
});
try {
  await refresh();
  if (data.orders.length === 0 && data.attempts.length === 0) {
    const order = await api('/api/orders', 'POST', {
      client_label: 'Maya & Arga — Wedding Story',
      total_amount: 12500000,
      deposit_amount: 6250000,
      hold_minutes: 1440,
    });
    selected = order.id;
    await api(`/api/orders/${order.id}/attempts`, 'POST', { method: 'gateway', amount: 6250000 });
    await refresh();
  }
} catch (error) {
  toast(`${error.message} Periksa control key.`);
}
