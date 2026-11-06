const $ = (s, r = document) => r.querySelector(s),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const money = (v) => 'Rp' + Number(v || 0).toLocaleString('id-ID'),
  when = (v) =>
    v
      ? new Date(v).toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s.replaceAll('_', ' '))}</span>`,
  button = (label, action, id = '', kind = 'secondary') =>
    `<button class="button ${kind}" type="button" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const brand = `<a class="brand" href="/"><b class="brand-mark">L</b><span>Lumen Gateway<small>DEVELOPER SANDBOX</small></span></a>`;
let data = null,
  authMode = 'register',
  filter = 'all',
  query = '',
  timer,
  oneTime = null;
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(body === undefined ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = await r.json();
  if (!r.ok) {
    const e = new Error(d.error?.message || 'Request failed.');
    e.status = r.status;
    throw e;
  }
  return d;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => $('#toast').classList.remove('visible'), 4000);
}
function dialog(title, intro, content) {
  const el = $('#dialog');
  el.innerHTML = `<div class="dialog-head"><div><h2>${title}</h2><p>${intro}</p></div><button class="dialog-close" data-action="close" aria-label="Tutup dialog">×</button></div>${content}`;
  if (!el.open) el.showModal();
}
function close() {
  oneTime = null;
  $('#dialog').close();
  $('#dialog').innerHTML = '';
}
function form(title, intro, fields, submit, action, id = '') {
  dialog(
    title,
    intro,
    `<form data-form="${action}" data-id="${esc(id)}">${fields}<p class="field-error" id="formError" role="alert" hidden></p><div class="modal-actions">${button('Kembali', 'close')}<button class="button" type="submit">${submit}</button></div></form>`,
  );
}
const field = (label, name, value = '', type = 'text', extra = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const heading = (k, t, d, a = '') =>
  `<div class="page-heading"><div><span class="eyebrow">${k}</span><h1>${t}</h1><p>${d}</p></div><div class="heading-actions">${a}</div></div>`;
const panel = (t, d, b, a = '') =>
  `<section class="panel"><div class="panel-head"><div><h2>${t}</h2><p>${d}</p></div>${a}</div>${b}</section>`;
const empty = (t, d, a = '') =>
  `<div class="empty"><span>↗</span><h3>${t}</h3><p>${d}</p>${a}</div>`;
function landing() {
  $('#app').innerHTML =
    `<div class="landing"><header class="landing-nav">${brand}<div><a href="/docs">Dokumentasi</a><a href="/guide.pdf" target="_blank">Panduan PDF ↗</a><span class="test-pill">100% SANDBOX</span></div></header><main class="landing-hero"><section class="hero-copy"><span class="eyebrow">BUILD THE FLOW. TEST EVERY POSSIBILITY.</span><h1>Pembayaran realistis.<br><em>Ruang aman</em><br>untuk bereksperimen.</h1><p>Uji QRIS dinamis, virtual account, dan webhook sebelum menghubungkan aplikasi ke pembayaran sesungguhnya.</p><div class="hero-points"><div><b>✓</b> Kredensial langsung aktif, tanpa proses approval.</div><div><b>✓</b> Workspace dan transaksi terpisah untuk setiap merchant.</div><div><b>✓</b> Sukses, gagal, kedaluwarsa, replay, hingga refund.</div></div><a class="button secondary" href="/docs">Lihat panduan integrasi ↗</a><div class="hero-micro">Dibuat untuk developer, mahasiswa, dan tim produk.</div></section><section class="hero-visual"><div class="mini-terminal">POST /v1/payments<span>201 Created · payment.pending</span></div><div class="auth-card"><div class="tab-row"><button type="button" data-auth="register" class="${authMode === 'register' ? 'active' : ''}">Minta kredensial</button><button type="button" data-auth="login" class="${authMode === 'login' ? 'active' : ''}">Masuk workspace</button></div><h2>${authMode === 'register' ? 'Mulai dalam satu menit.' : 'Selamat datang kembali.'}</h2><p>${authMode === 'register' ? 'Buat workspace dan dapatkan test API key secara otomatis.' : 'Lanjutkan pengujian dari workspace milikmu.'}</p><form data-form="${authMode}">${authMode === 'register' ? field('Nama workspace / aplikasi', 'name', '', 'text', 'required minlength="2" maxlength="80" placeholder="Contoh: Lumen Booking" autocomplete="organization"') : ''}${field('Email', 'email', '', 'email', 'required maxlength="200" placeholder="developer@example.test" autocomplete="email"')}${field('Password', 'password', '', 'password', `required minlength="10" maxlength="128" placeholder="Minimal 10 karakter" autocomplete="${authMode === 'register' ? 'new-password' : 'current-password'}"`)}<p class="field-error" id="formError" role="alert" hidden></p><button class="button full" type="submit">${authMode === 'register' ? 'Buat workspace & dapatkan kredensial' : 'Masuk ke workspace'} ↗</button></form><p class="muted hero-micro">Mode uji. Tidak ada uang nyata, verifikasi email, atau approval manual. Gunakan identitas contoh.</p></div></section></main><section class="feature-strip">${[
      [
        '01',
        'Dynamic QRIS',
        'QR unik, nominal terkunci, batas waktu, dan halaman payer sandbox yang bisa dipindai.',
      ],
      [
        '02',
        'Virtual account',
        'Nomor VA uji sekali pakai: BCA, BNI, BRI, Mandiri, Permata. Uji penerimaan bank.',
      ],
      [
        '03',
        'Webhook yang bisa ditelusuri',
        'HMAC signature, event ID stabil, retry otomatis, dan riwayat delivery untuk debugging.',
      ],
    ]
      .map(
        ([n, t, d]) =>
          `<article><span class="feature-number">${n}</span><b>${t}</b><p>${d}</p></article>`,
      )
      .join(
        '',
      )}</section><footer class="landing-footer"><span>Lumen Gateway · Sandbox API v2</span><span>Simulasi independen. Tidak terafiliasi bank atau penyedia pembayaran.</span></footer></div>`;
}
function shell() {
  const route = location.hash.slice(1).split('/')[0] || 'overview';
  $('#app').innerHTML =
    `<div class="workspace"><aside class="sidebar">${brand}<span class="workspace-label">WORKSPACE</span><nav class="workspace-nav">${[
      ['overview', '◫', 'Ringkasan'],
      ['payments', '↗', 'Transaksi'],
      ['credentials', '⌘', 'Kredensial API'],
      ['webhooks', '⇄', 'Webhook & event'],
      ['activity', '◷', 'Aktivitas'],
    ]
      .map(
        ([k, s, l]) =>
          `<a href="#${k}" class="${route === k ? 'active' : ''}"><span class="nav-symbol">${s}</span>${l}</a>`,
      )
      .join(
        '',
      )}<a href="/docs"><span class="nav-symbol">▤</span>Dokumentasi ↗</a></nav><div class="sidebar-bottom"><div class="sidebar-note"><strong>Test without the guesswork.</strong>Seluruh saldo, nomor VA, dan pembayaran di workspace ini adalah data sandbox.</div><div class="account-block"><b class="avatar">${esc(data.merchant.name.slice(0, 2).toUpperCase())}</b><span><strong>${esc(data.merchant.name)}</strong><small>Merchant workspace</small></span><button data-action="logout" aria-label="Keluar workspace">↪</button></div></div></aside><div class="workspace-main"><header class="topbar"><div><button class="mobile-menu" data-action="menu" aria-label="Buka navigasi">☰</button><span>Workspace / <strong>${{ overview: 'Ringkasan', payments: 'Transaksi', credentials: 'Kredensial', webhooks: 'Webhook', activity: 'Aktivitas' }[route] || 'Detail'}</strong></span></div><div><span class="test-pill">TEST MODE</span><a href="/guide.pdf" target="_blank">Panduan PDF ↗</a></div></header><main class="workspace-content" id="content"></main></div></div>`;
  renderContent();
}
function paymentTable(records) {
  return records.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>TRANSAKSI</th><th>CHANNEL</th><th>NOMINAL</th><th>STATUS</th><th>DIBUAT</th><th></th></tr></thead><tbody>${records.map((p) => `<tr><td><a href="#payments/${p.id}"><strong>${esc(p.external_id)}</strong></a><small>${esc(p.description || p.id.slice(0, 16) + '…')}</small></td><td>${p.payment_method === 'qris' ? 'QRIS Dynamic' : esc(p.bank_code) + ' Virtual Account'}<small>${p.account_number ? esc(p.account_number) : 'Single-use QR'}</small></td><td><strong>${money(p.amount)}</strong>${p.refunded_amount ? `<small>Refund ${money(p.refunded_amount)}</small>` : ''}</td><td>${badge(p.status)}</td><td>${when(p.created_at)}</td><td><a class="button secondary small" href="#payments/${p.id}">Detail ↗</a></td></tr>`).join('')}</tbody></table></div>`
    : empty(
        'Transaksi pertamamu dimulai di sini.',
        'Buat pembayaran contoh atau hubungkan aplikasi menggunakan API.',
        button('Buat pembayaran uji', 'new-payment', '', ''),
      );
}
function overview() {
  const paid = data.payments.filter((p) => p.status === 'paid'),
    pending = data.payments.filter((p) => p.status === 'pending'),
    net = paid.reduce((n, p) => n + p.paid_amount - p.refunded_amount, 0);
  return (
    heading(
      'MERCHANT OVERVIEW',
      'Semua alur, satu workspace.',
      'Pantau transaksi uji dan pastikan integrasi berjalan sesuai rencana.',
      button('Buat pembayaran uji', 'new-payment', '', ''),
    ) +
    `<div class="stats">${[
      ['Volume terselesaikan', money(net), 'Setelah refund selesai'],
      ['Transaksi berhasil', paid.length, 'Pembayaran tercatat simulator'],
      ['Menunggu pembayaran', pending.length, 'QR / VA masih aktif'],
      [
        'Webhook perlu perhatian',
        data.events.filter((e) => ['failed', 'unconfigured'].includes(e.status)).length,
        'Gagal atau belum dikonfigurasi',
      ],
    ]
      .map(
        ([l, v, n]) =>
          `<article class="stat"><span>${l}</span><strong>${v}</strong><small>${n}</small></article>`,
      )
      .join(
        '',
      )}</div><div class="overview-grid">${panel('Channel yang tersedia', 'Dua cara pembayaran dengan nominal yang terkunci.', `<div class="panel-body"><div class="channel-card"><span class="channel-logo">QR</span><div><h3>QRIS Dynamic</h3><p>QR per transaksi, sekali bayar, expiry otomatis. Pindai dengan kamera untuk membuka payer sandbox.</p><small>Rp1 - Rp10.000.000 · 1-60 menit</small></div></div><div class="channel-card"><span class="channel-logo">VA</span><div><h3>Virtual account</h3><p>Closed amount, nomor unik, dan simulasi notifikasi penerimaan bank.</p><small>BCA · BNI · BRI · MANDIRI · PERMATA</small></div></div></div>`)}${panel('Mulai mengintegrasikan', 'Tiga langkah dari kredensial hingga konfirmasi.', `<div class="panel-body"><ol class="steps"><li><div><b>Simpan secret key di backend.</b><p><a href="#credentials">Kelola kredensial API</a> untuk aplikasimu.</p></div></li><li><div><b>Hubungkan webhook.</b><p><a href="#webhooks">Atur URL receiver</a> dan verifikasi HMAC dari raw body.</p></div></li><li><div><b>Buat pembayaran dan uji hasilnya.</b><p>Gunakan checkout, pantau event, lalu cocokkan status melalui API.</p></div></li></ol></div>`)}</div>` +
    panel(
      'Transaksi terbaru',
      'Data hanya dari merchant workspace ini.',
      paymentTable(data.payments.slice(0, 5)),
      `<a href="#payments" class="button secondary small">Semua transaksi ↗</a>`,
    )
  );
}
function filtered() {
  return data.payments.filter(
    (p) =>
      (filter === 'all' || p.status === filter) &&
      `${p.external_id} ${p.amount} ${p.description}`.toLowerCase().includes(query.toLowerCase()),
  );
}
function payments() {
  return (
    heading(
      'PAYMENT EXPLORER',
      'Transaksi yang bisa ditelusuri.',
      'Satu external ID per pembayaran. Gunakan referensi baru jika pembayaran lama sudah ditutup.',
      button('Buat pembayaran uji', 'new-payment', '', ''),
    ) +
    panel(
      'Daftar pembayaran',
      'Status diperbarui dari server sandbox.',
      `<div class="list-toolbar"><div class="filters">${['all', 'pending', 'paid', 'expired', 'failed', 'cancelled'].map((x) => `<button type="button" data-filter="${x}" class="${filter === x ? 'active' : ''}">${x === 'all' ? 'Semua' : x}</button>`).join('')}</div><input class="search" type="search" id="paymentSearch" placeholder="Cari external ID / nominal" aria-label="Cari transaksi" value="${esc(query)}"></div><div id="paymentTable">${paymentTable(filtered())}</div>`,
    )
  );
}
function paymentDetail(p) {
  if (!p)
    return empty(
      'Transaksi tidak ditemukan.',
      'Pilih transaksi milik workspace ini.',
      `<a class="button secondary" href="#payments">Kembali</a>`,
    );
  const receipts = data.receipts.filter((x) => x.payment_id === p.id),
    refunds = data.refunds.filter((x) => x.payment_id === p.id);
  return (
    `<a class="back-link" href="#payments">← Semua transaksi</a>` +
    heading(
      'TRANSACTION DETAIL',
      esc(p.external_id),
      esc(p.description || 'Pembayaran sandbox'),
      badge(p.status),
    ) +
    `<div class="detail-grid"><div class="stack">${panel('Rincian pembayaran', esc(p.id), `<div class="detail-summary"><div><span>Nominal</span><strong class="payment-amount">${money(p.amount)}</strong></div><div><span>Channel</span><strong>${p.payment_method === 'qris' ? 'QRIS Dynamic' : esc(p.bank_code) + ' VA'}</strong></div><div><span>Dibuat</span><strong>${when(p.created_at)} WIB</strong></div><div><span>Kedaluwarsa</span><strong>${when(p.expires_at)} WIB</strong></div><div><span>Terbayar</span><strong>${money(p.paid_amount)}</strong></div><div><span>Refund selesai</span><strong>${money(p.refunded_amount)}</strong></div>${p.account_number ? `<div><span>Nomor VA uji</span><strong>${esc(p.account_number)}</strong></div>` : ''}<div><span>Pelanggan</span><strong>${esc(p.customer_name || 'Demo customer')}</strong></div></div><div class="detail-actions"><a class="button" href="${esc(p.checkout_url)}" target="_blank">Buka checkout ↗</a>${p.status === 'pending' ? button('Uji hasil pembayaran', 'simulate', p.id) : ''}${p.status === 'paid' && p.refunded_amount < p.paid_amount ? button('Ajukan refund uji', 'new-refund', p.id) : ''}${['expired', 'cancelled', 'failed'].includes(p.status) ? button('Uji dana terlambat', 'late', p.id) : ''}</div>`)}${panel('Receipt / penerimaan bank', 'Referensi yang sama tidak menghasilkan receipt kedua.', receipts.length ? `<ul class="audit-list">${receipts.map((r) => `<li><div><strong>${money(r.amount)}</strong><br><code>${esc(r.bank_reference)}</code>${r.needs_review ? '<br><span class="badge failed">Rekonsiliasi dana terlambat</span>' : ''}</div><small>${when(r.created_at)}</small></li>`).join('')}</ul>` : empty('Belum ada penerimaan.', 'Pembayaran belum diselesaikan.'))}${refunds.length ? panel('Refund', 'Penyelesaian terpisah dari permintaan.', `<ul class="delivery-list">${refunds.map((r) => `<li><div><strong>${money(r.amount)}</strong> ${badge(r.status)}<br><small>${esc(r.reason)}</small></div>${r.status === 'pending' ? button('Simulasikan hasil', 'refund-result', r.id, 'secondary small') : r.status === 'failed' ? button('Coba ulang', 'refund-retry', r.id, 'secondary small') : ''}</li>`).join('')}</ul>`) : ''}</div><aside class="stack">${panel('Timeline event', 'Provider state dan webhook delivery terpisah.', eventList(data.events.filter((e) => e.payment_id === p.id)))}${panel('Cara membaca hasil', 'Checkout redirect bukan bukti pembayaran.', `<div class="panel-body"><p class="muted">Gunakan event bertanda tangan dan GET status dari backend. Hanya <code>payment.paid</code> dengan nominal yang sesuai yang membuka pesanan.</p></div>`)}</aside></div>`
  );
}
function credentials() {
  return (
    heading(
      'DEVELOPER CREDENTIALS',
      'Kunci untuk setiap aplikasimu.',
      'Test credentials aktif segera. Secret ditampilkan sekali saat diterbitkan.',
      button('Terbitkan API key', 'new-key', '', ''),
    ) +
    `<div class="notice">Simpan secret API key dan webhook secret di environment backend. Key yang dicabut langsung menolak request baru; transaksi dan event lama tetap tersedia.</div>` +
    panel(
      'Secret API keys',
      'Maksimal 10 key aktif per merchant.',
      `<div class="key-list">${data.credentials.map((k) => `<article class="key-row"><div><h3>${esc(k.name)}</h3><code>${esc(k.prefix)}…${esc(k.last_four)}</code><small>Dibuat ${when(k.created_at)} · ${k.last_used_at ? 'Terakhir create payment ' + when(k.last_used_at) : 'Belum digunakan untuk create payment'}</small></div>${badge(k.revoked_at ? 'revoked' : 'active')}${!k.revoked_at ? button('Cabut', 'revoke-key', k.id, 'danger small') : ''}</article>`).join('')}</div>`,
    ) +
    `<div class="spaced integration-grid">${panel('Connection details', 'Base URL dari server yang sedang berjalan.', `<div class="panel-body"><div class="code-row"><span>API base URL</span><div class="code-box"><code>${esc(data.base_url)}/v1</code><button data-action="copy" data-value="${esc(data.base_url)}/v1">Salin</button></div></div><div class="code-row"><span>Authorization header</span><div class="code-box"><code>Authorization: Bearer sk_test_…</code></div></div><a href="/docs#quickstart">Buka quickstart integrasi ↗</a></div>`)}${panel('Webhook signing secret', 'Terpisah dari secret API key.', `<div class="panel-body"><p class="muted">Secret diberikan saat registrasi. Jika hilang, terbitkan yang baru dan perbarui receiver. Delivery berikutnya, termasuk replay, memakai secret terbaru.</p><div class="spaced">${button('Terbitkan webhook secret baru', 'rotate-webhook')}</div></div>`)}</div>`
  );
}
function eventList(events) {
  return events.length
    ? `<ul class="delivery-list">${events
        .slice(0, 20)
        .map(
          (e) =>
            `<li><div><a href="#webhooks/${e.id}"><strong>${esc(e.payload.type)}</strong></a><br><small>${when(e.payload.created_at)} · ${e.deliveries.length} delivery</small></div>${badge(e.status)}</li>`,
        )
        .join('')}</ul>`
    : empty('Event akan tampil di sini.', 'Buat pembayaran untuk mulai menguji delivery.');
}
function webhooks() {
  return (
    heading(
      'WEBHOOK DELIVERY',
      'Setiap event punya jejak.',
      'Terima konfirmasi di backend, verifikasi signature, dan proses secara idempoten.',
    ) +
    `<div class="integration-grid">${panel('Endpoint receiver', 'HTTPS untuk publik, HTTP loopback untuk pengujian lokal.', `<div class="panel-body"><form data-form="webhook">${field('Webhook URL', 'url', data.merchant.webhook_url || '', 'url', `placeholder="${data.allow_local_webhooks ? 'http://127.0.0.1:8000/webhooks/payments/simulator' : 'https://your-app.example/webhooks/lumen'}"`)}<p class="field-error" role="alert" hidden></p><button class="button" type="submit">Simpan endpoint</button></form><p class="muted spaced"><small>Event tanpa endpoint diantrekan setelah URL disimpan. Event lama tetap memakai snapshot URL; replay bisa diarahkan ke URL terbaru.</small></p></div>`)}${panel('Delivery contract', 'Initial delivery + maksimal 6 automatic retries.', `<div class="panel-body"><ol class="steps"><li><div><b>Signature HMAC-SHA256</b><p><code>timestamp.rawBody</code> dengan webhook secret merchant.</p></div></li><li><div><b>Respons 2xx = acknowledged</b><p>Timeout/non-2xx: retry setelah 5s, 30s, 2m, 10m, 30m, 2h.</p></div></li><li><div><b>ID tetap sama saat replay</b><p>Simpan ID yang sudah diproses. Timestamp/signature diperbarui tiap delivery.</p></div></li></ol></div>`)}</div><div class="spaced">${panel('Event stream', 'Klik event untuk payload dan riwayat respons.', eventList(data.events))}</div>`
  );
}
function eventDetail(e) {
  if (!e)
    return empty(
      'Event tidak ditemukan.',
      'Kembali ke event stream.',
      `<a class="button secondary" href="#webhooks">Semua event</a>`,
    );
  return (
    `<a class="back-link" href="#webhooks">← Semua event</a>` +
    heading(
      'WEBHOOK INSPECTOR',
      esc(e.payload.type),
      esc(e.id),
      button('Replay / kirim ulang', 'retry-event', e.id),
    ) +
    `<div class="detail-grid"><div class="stack">${panel('Event payload', 'Raw JSON ditandatangani saat dikirim.', `<pre class="event-payload">${esc(JSON.stringify(e.payload, null, 2))}</pre>`)}${panel('Riwayat delivery', 'Hanya HTTP status/error disimpan, bukan isi respons receiver.', e.deliveries.length ? `<ul class="delivery-list">${e.deliveries.map((d, i) => `<li><div><strong>#${i + 1} · ${d.http_status || 'Network error'}</strong><br><small>${when(d.at)} ${d.error ? '· ' + esc(d.error) : ''}</small></div>${badge(d.ok ? 'delivered' : 'failed')}</li>`).join('')}</ul>` : empty('Belum ada delivery.', 'Konfigurasikan receiver atau tunggu worker.'))}</div><aside>${panel('Status pengiriman', 'At-least-once delivery.', `<div class="detail-summary"><div><span>Status</span>${badge(e.status)}</div><div><span>Retry berikut</span><strong>${e.next_attempt_at ? when(e.next_attempt_at) : '-'}</strong></div><div><span>Endpoint snapshot</span><strong class="webhook-target">${esc(e.target_url || 'Belum dikonfigurasi')}</strong></div></div>`)}</aside></div>`
  );
}
function activity() {
  return (
    heading(
      'WORKSPACE ACTIVITY',
      'Perubahan yang tercatat.',
      'Riwayat kredensial, pembayaran, dan konfigurasi.',
    ) +
    panel(
      'Audit trail',
      '100 aktivitas terakhir milik merchant ini.',
      `<ul class="audit-list">${data.audit.map((a) => `<li><div><strong>${esc(a.action)}</strong><br><code>${esc(a.resource)}</code></div><small>${when(a.created_at)}</small></li>`).join('')}</ul>`,
    )
  );
}
function renderContent() {
  const [view = 'overview', key] = location.hash.slice(1).split('/');
  $('#content').innerHTML =
    (view === 'payments'
      ? key
        ? paymentDetail(data.payments.find((p) => p.id === key))
        : payments()
      : view === 'credentials'
        ? credentials()
        : view === 'webhooks'
          ? key
            ? eventDetail(data.events.find((e) => e.id === key))
            : webhooks()
          : view === 'activity'
            ? activity()
            : overview()) +
    `<footer class="workspace-footer"><span>Lumen Gateway Sandbox · API v2</span><span>All amounts are simulated · Asia/Jakarta</span></footer>`;
}
async function refresh(render = true) {
  data = await api('/portal/state');
  if (render) shell();
}
function secrets(result) {
  oneTime = result;
  dialog(
    'Workspace siap dihubungkan.',
    'Simpan nilai berikut sekarang. Secret tidak dapat dibaca kembali setelah dialog ditutup.',
    `${result.credential ? `<div class="secret-box"><span>Secret API key</span><code>${esc(result.credential.secret_key)}</code>${button('Salin secret key', 'copy-secret', 'api', 'secondary small')}</div>` : ''}${result.secret_key ? `<div class="secret-box"><span>Secret API key</span><code>${esc(result.secret_key)}</code>${button('Salin secret key', 'copy-secret', 'key', 'secondary small')}</div>` : ''}${result.webhook_secret ? `<div class="secret-box"><span>Webhook signing secret</span><code>${esc(result.webhook_secret)}</code>${button('Salin webhook secret', 'copy-secret', 'webhook', 'secondary small')}</div>` : ''}<div class="notice warning">Khusus test mode. Simpan secret pada environment backend, bukan source frontend atau repository publik.</div><div class="modal-actions">${button('Sudah disimpan, lanjutkan', 'close', '', '')}</div>`,
  );
}
function newPayment() {
  form(
    'Buat pembayaran uji.',
    'Gunakan dashboard atau POST /v1/payments dari backend aplikasi.',
    field(
      'External ID / referensi aplikasi',
      'external_id',
      'DEMO-' + Date.now(),
      'text',
      'required maxlength="100"',
    ) +
      `<div class="form-grid">${field('Nominal (IDR)', 'amount', 150000, 'number', 'required min="1" max="100000000" step="1"')}<label class="field"><span>Payment method</span><select name="payment_method" id="methodSelect"><option value="qris">QRIS Dynamic</option><option value="virtual_account">Virtual Account</option></select></label></div><label class="field bank-field" id="bankField" hidden><span>Bank</span><select name="bank_code">${data.banks.map((b) => `<option>${b}</option>`).join('')}</select></label><div class="form-grid">${field('Berlaku (detik)', 'expires_in', 900, 'number', 'required min="60" max="3600" id="expiryInput"')}${field('Nama pelanggan dummy', 'customer_name', 'Demo Customer', 'text', 'maxlength="100"')}</div>${field('Deskripsi', 'description', 'Pengujian pembayaran aplikasi', 'text', 'maxlength="300"')}`,
    'Buat pembayaran',
    'payment',
  );
}
function simulateForm(p, late = false) {
  form(
    late ? 'Uji dana terlambat.' : 'Simulasikan hasil pembayaran.',
    late
      ? 'Dana dicatat untuk rekonsiliasi. Status tidak menjadi paid.'
      : 'Exact amount menghasilkan satu receipt dan event payment.paid.',
    `${late ? '' : `<label class="field"><span>Hasil simulasi</span><select name="outcome"><option value="paid">Paid / bank menerima dana</option><option value="failed">Gagal</option><option value="expired">Kedaluwarsa</option><option value="cancelled">Dibatalkan</option><option value="pending">Masih menunggu</option></select></label>`}<div class="form-grid">${field('Nominal diterima (IDR)', 'amount', p.amount, 'number', 'required min="1" step="1"')}${field('Referensi bank uji', 'bank_reference', 'SIM-' + crypto.randomUUID().slice(0, 12), 'text', 'required minlength="4"')}</div>${late ? '<input type="hidden" name="late_payment" value="true">' : ''}`,
    'Kirim hasil simulasi',
    'simulate',
    p.id,
  );
}
async function action(a, key, el) {
  if (a === 'close') {
    close();
    return;
  }
  if (a === 'menu') {
    $('.sidebar').classList.toggle('open');
    return;
  }
  if (a === 'copy') {
    await navigator.clipboard.writeText(el.dataset.value);
    toast('Disalin.');
    return;
  }
  if (a === 'copy-secret') {
    await navigator.clipboard.writeText(
      key === 'webhook'
        ? oneTime.webhook_secret
        : key === 'api'
          ? oneTime.credential.secret_key
          : oneTime.secret_key,
    );
    toast('Secret disalin.');
    return;
  }
  if (a === 'logout') {
    await api('/portal/logout', {});
    data = null;
    location.hash = '';
    landing();
    return;
  }
  if (a === 'new-payment') {
    newPayment();
    return;
  }
  if (a === 'new-key') {
    form(
      'Terbitkan kredensial aplikasi.',
      'Key langsung aktif tanpa approval. Secret ditampilkan sekali.',
      field(
        'Nama aplikasi / key',
        'name',
        '',
        'text',
        'required maxlength="60" placeholder="Laravel booking staging"',
      ),
      'Terbitkan API key',
      'key',
    );
    return;
  }
  if (a === 'revoke-key') {
    form(
      'Cabut akses key ini?',
      'Request berikutnya akan ditolak. Transaksi lama dan webhook tetap berjalan.',
      '',
      'Cabut key',
      'revoke',
      key,
    );
    return;
  }
  if (a === 'rotate-webhook') {
    form(
      'Terbitkan signing secret baru?',
      'Perbarui receiver. Delivery berikutnya, termasuk event lama, memakai secret baru.',
      '',
      'Terbitkan secret baru',
      'rotate',
    );
    return;
  }
  if (a === 'simulate' || a === 'late') {
    simulateForm(
      data.payments.find((p) => p.id === key),
      a === 'late',
    );
    return;
  }
  if (a === 'new-refund') {
    const p = data.payments.find((p) => p.id === key);
    form(
      'Ajukan refund uji.',
      'Dana direservasi saat permintaan dibuat. Simulasikan hasil setelah itu.',
      field(
        'Nominal refund (IDR)',
        'amount',
        p.paid_amount - p.refunded_amount,
        'number',
        `required min="1" max="${p.paid_amount - p.refunded_amount}" step="1"`,
      ) + field('Alasan refund', 'reason', '', 'text', 'required minlength="3" maxlength="300"'),
      'Ajukan refund',
      'refund',
      key,
    );
    return;
  }
  if (a === 'refund-result') {
    form(
      'Simulasikan proses refund.',
      'Refund selesai menambah refunded_amount tanpa menghapus receipt.',
      '<label class="field"><span>Hasil proses</span><select name="outcome"><option value="succeeded">Selesai</option><option value="failed">Gagal</option></select></label>',
      'Simpan hasil',
      'refund-result',
      key,
    );
    return;
  }
  if (a === 'refund-retry') {
    await api(`/portal/refunds/${key}/retry`, {});
    await refresh();
    toast('Refund kembali pending.');
    return;
  }
  if (a === 'retry-event') {
    form(
      'Antrekan ulang event.',
      'ID dan payload tetap. Timestamp/signature diperbarui saat delivery.',
      '<label class="field"><span>Endpoint tujuan</span><select name="use_current_url"><option value="false">Snapshot URL pada event</option><option value="true">URL terbaru merchant</option></select></label>',
      'Antrekan replay',
      'retry-event',
      key,
    );
    return;
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-auth]');
  if (a) {
    authMode = a.dataset.auth;
    landing();
    return;
  }
  const f = e.target.closest('[data-filter]');
  if (f) {
    filter = f.dataset.filter;
    renderContent();
    return;
  }
  const b = e.target.closest('[data-action]');
  if (b) action(b.dataset.action, b.dataset.id, b).catch((e) => toast(e.message));
  if (data && innerWidth <= 700 && !e.target.closest('.sidebar,.mobile-menu'))
    $('.sidebar')?.classList.remove('open');
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'paymentSearch') {
    query = e.target.value;
    $('#paymentTable').innerHTML = paymentTable(filtered());
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'methodSelect') {
    const va = e.target.value === 'virtual_account';
    $('#bankField').hidden = !va;
    $('#expiryInput').max = va ? 604800 : 3600;
    $('#expiryInput').value = va ? 86400 : 900;
  }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form,
    v = Object.fromEntries(new FormData(f)),
    key = f.dataset.id,
    submit = e.submitter;
  submit.disabled = true;
  const error = $('.field-error', f);
  if (error) error.hidden = true;
  try {
    if (kind === 'register' || kind === 'login') {
      const result = await api('/portal/' + kind, v);
      f.reset();
      await refresh();
      location.hash = 'overview';
      if (kind === 'register') secrets(result);
    }
    if (kind === 'payment') {
      v.amount = Number(v.amount);
      v.expires_in = Number(v.expires_in);
      const p = await api('/portal/payments', v);
      close();
      await refresh();
      location.hash = 'payments/' + p.id;
    }
    if (kind === 'key') {
      const result = await api('/portal/credentials', v);
      close();
      await refresh();
      secrets(result);
    }
    if (kind === 'revoke') {
      await api(`/portal/credentials/${key}/revoke`, {});
      close();
      await refresh();
      toast('Kredensial dicabut.');
    }
    if (kind === 'rotate') {
      const result = await api('/portal/webhook/rotate', {});
      close();
      await refresh();
      secrets(result);
    }
    if (kind === 'webhook') {
      await api('/portal/webhook', v);
      await refresh();
      toast('Endpoint webhook disimpan.');
    }
    if (kind === 'simulate') {
      v.amount = Number(v.amount);
      v.late_payment = v.late_payment === 'true';
      v.outcome = v.outcome || 'paid';
      await api(`/portal/payments/${key}/simulate`, v);
      close();
      await refresh();
      toast('Hasil pembayaran dicatat.');
    }
    if (kind === 'refund') {
      v.amount = Number(v.amount);
      await api(`/portal/payments/${key}/refunds`, v);
      close();
      await refresh();
      toast('Refund pending. Simulasikan hasilnya di detail transaksi.');
    }
    if (kind === 'refund-result') {
      await api(`/portal/refunds/${key}/simulate`, v);
      close();
      await refresh();
      toast('Hasil refund diperbarui.');
    }
    if (kind === 'retry-event') {
      await api(`/portal/events/${key}/retry`, { use_current_url: v.use_current_url === 'true' });
      close();
      await refresh();
      toast('Event diantrekan untuk delivery.');
    }
  } catch (errorValue) {
    if (error) {
      error.textContent = errorValue.message;
      error.hidden = false;
    } else toast(errorValue.message);
  } finally {
    submit.disabled = false;
  }
});
$('#dialog').addEventListener('cancel', () => {
  oneTime = null;
});
window.addEventListener('hashchange', () => {
  if (data) {
    shell();
    window.scrollTo(0, 0);
  }
});
try {
  await refresh();
} catch {
  landing();
}
setInterval(async () => {
  if (
    !data ||
    $('#dialog').open ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  )
    return;
  try {
    await refresh();
  } catch (e) {
    if (e.status === 401) {
      data = null;
      landing();
    }
  }
}, 8000);
