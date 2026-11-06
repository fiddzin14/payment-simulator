const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const money = (v) => 'Rp' + Number(v).toLocaleString('id-ID'),
  token = location.pathname.split('/')[2],
  issuer = location.pathname.startsWith('/issuer/');
let payment, lastStatus, timer;
function toast(m) {
  $('#toast').textContent = m;
  $('#toast').classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}
async function api(body) {
  const r = await fetch(`/checkout-api/${token}${body ? '/simulate' : ''}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Checkout unavailable.');
  return d;
}
function expiry() {
  const el = $('#countdown');
  if (!el || !payment) return;
  const n = Math.max(0, Math.ceil((Date.parse(payment.expires_at) - Date.now()) / 1000));
  el.textContent = [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60]
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
}
function render() {
  const p = payment;
  let body = '';
  if (p.status !== 'pending') {
    const paid = p.status === 'paid';
    body = `<div class="payment-result"><span class="result-symbol">${paid ? '✓' : '↻'}</span><span class="eyebrow">${paid ? 'PAYMENT CONFIRMED' : 'PAYMENT ' + esc(p.status.toUpperCase())}</span><h2>${paid ? 'Pembayaran uji berhasil.' : p.status === 'expired' ? 'Waktu pembayaran berakhir.' : p.status === 'failed' ? 'Pembayaran belum berhasil.' : 'Pembayaran dibatalkan.'}</h2><p>${paid ? 'Provider telah mencatat pembayaran. Konfirmasi ke aplikasi dikirim melalui webhook terpisah.' : 'Instrumen ini ditutup. Minta aplikasi membuat transaksi baru dengan referensi berbeda.'}</p><span class="badge ${esc(p.status)}">${esc(p.status)}</span>${p.return_url ? `<a class="button" href="${esc(p.return_url)}">Kembali ke aplikasi ↗</a>` : '<a class="button secondary" href="/">Buka merchant workspace ↗</a>'}</div>`;
  } else if (issuer) {
    body = `<div class="issuer-tag">SANDBOX PAYER · Simulasi penerbit / bank, tanpa uang nyata.</div><span class="eyebrow">${p.payment_method === 'qris' ? 'SIMULATED QR SCAN' : 'SIMULATED BANK TRANSFER'}</span><h2>${p.payment_method === 'qris' ? 'Tinjau pembayaran.' : 'Kirim ke virtual account uji.'}</h2><p>Nominal harus sama persis dengan transaksi. Referensi bank yang sama dikenali sebagai duplikat.</p>${p.account_number ? `<div class="bank-number"><small>${esc(p.bank_code)} · VIRTUAL ACCOUNT UJI</small><strong>${esc(p.account_number)}</strong><span>${esc(p.account_name)}</span></div>` : ''}<form id="issuerForm" class="issuer-form"><label class="field"><span>Nominal pembayaran (IDR)</span><input name="amount" type="number" value="${p.amount}" min="1" step="1" required ${p.payment_method === 'qris' ? 'readonly' : ''}></label><label class="field"><span>Referensi bank uji</span><input name="bank_reference" value="SIM-${crypto.randomUUID().slice(0, 12)}" minlength="4" required></label><p id="payerError" class="field-error" role="alert" hidden></p><button class="button full" type="submit">Konfirmasi pembayaran uji ${money(p.amount)} →</button></form><div class="issuer-alternatives"><button class="text-button" data-scenario="failed">Simulasikan gagal</button><button class="text-button" data-scenario="pending">Tetap pending</button></div>`;
  } else if (p.payment_method === 'qris') {
    body = `<span class="eyebrow">QRIS DYNAMIC · SANDBOX</span><h2>Satu QR untuk transaksi ini.</h2><p>Pindai dengan kamera untuk membuka payer sandbox. Nominal dan batas waktu sudah ditentukan.</p><div class="qr-frame"><img src="${esc(p.qr_image_url)}" alt="QR pembayaran sandbox ${esc(p.external_id)}" width="245" height="245"></div><p class="qr-caption">QR uji ini tidak diproses aplikasi bank atau e-wallet.</p><div class="expiry">Selesaikan dalam <strong id="countdown"></strong></div><a class="button" href="/issuer/${token}">Buka payer simulator ↗</a>`;
  } else {
    body = `<span class="eyebrow">${esc(p.bank_code)} VIRTUAL ACCOUNT · SANDBOX</span><h2>Transfer sesuai nominal.</h2><p>Nomor unik, sekali pakai, dan hanya berlaku untuk pembayaran uji ini.</p><div class="bank-number"><small>${esc(p.bank_code)} · NOMOR VA SIMULASI</small><strong>${esc(p.account_number.match(/.{1,4}/g).join(' '))}</strong><span>${esc(p.account_name)}</span><button class="button secondary small" id="copyVa">Salin nomor VA</button></div><ol class="pay-instructions"><li>Buka bank simulator dan periksa nomor VA tujuan.</li><li>Masukkan tepat <strong>${money(p.amount)}</strong> dan referensi bank uji.</li><li>Konfirmasi untuk memicu payment event dan webhook.</li></ol><div class="expiry">Berlaku selama <strong id="countdown"></strong></div><a class="button" href="/issuer/${token}">Buka bank simulator ↗</a>`;
  }
  $('#checkout').innerHTML =
    `<div class="checkout-layout"><aside class="checkout-summary"><span class="eyebrow">${esc(p.merchant_name)}</span><h1>Pembayaran<br>yang terhubung.</h1><p>${esc(p.description || 'Pembayaran sandbox untuk aplikasi terhubung.')}</p><strong class="total">${money(p.amount)}</strong><div class="summary-lines"><div><span>Referensi</span><strong>${esc(p.external_id)}</strong></div><div><span>Metode</span><strong>${p.payment_method === 'qris' ? 'QRIS Dynamic' : esc(p.bank_code) + ' Virtual Account'}</strong></div><div><span>Status</span><strong>${esc(p.status)}</strong></div><div><span>Mata uang</span><strong>IDR / Rupiah</strong></div></div><p class="sandbox-note">TEST MODE ONLY. QR dan VA adalah instrumen simulasi. Tidak ada rekening, wallet, atau dana nyata terhubung.</p></aside><section class="checkout-panel">${body}${p.status === 'pending' && issuer ? `<div class="expiry">Berlaku selama <strong id="countdown"></strong></div><a class="checkout-return" href="/pay/${token}">← Kembali ke instruksi pembayaran</a>` : ''}</section></div>`;
  expiry();
  lastStatus = p.status;
}
async function refresh(force = false) {
  payment = await api();
  if (force || payment.status !== lastStatus) render();
}
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'issuerForm') return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target)),
    submit = e.submitter;
  submit.disabled = true;
  $('#payerError').hidden = true;
  try {
    await api({ outcome: 'paid', amount: Number(v.amount), bank_reference: v.bank_reference });
    await refresh(true);
  } catch (error) {
    $('#payerError').textContent = error.message;
    $('#payerError').hidden = false;
    submit.disabled = false;
  }
});
document.addEventListener('click', async (e) => {
  try {
    if (e.target.id === 'copyVa') {
      await navigator.clipboard.writeText(payment.account_number);
      toast('Nomor VA uji disalin.');
    }
    if (e.target.dataset.scenario) {
      const outcome = e.target.dataset.scenario;
      await api({ outcome });
      await refresh(true);
      if (outcome === 'pending') toast('Masih pending. Tidak ada dana tercatat.');
    }
  } catch (error) {
    toast(error.message);
  }
});
try {
  await refresh(true);
} catch (e) {
  $('#checkout').innerHTML =
    `<section class="checkout-panel"><h2>Checkout tidak tersedia.</h2><p>${esc(e.message)}</p><a class="checkout-return" href="/">Kembali ke workspace</a></section>`;
}
setInterval(expiry, 1000);
setInterval(() => {
  if (payment?.status === 'pending') refresh().catch((e) => toast(e.message));
}, 3000);
