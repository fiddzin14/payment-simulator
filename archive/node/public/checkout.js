const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search),
  id = params.get('session'),
  token = params.get('token');
const money = (value) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
async function load() {
  const response = await fetch(
    `/v1/checkout/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Checkout unavailable.');
  $('#checkoutDetails').replaceChildren();
  const section = document.createElement('div');
  section.className = 'checkout-amount';
  const label = document.createElement('span');
  label.textContent = 'Total checkout';
  const amount = document.createElement('strong');
  amount.textContent = money(data.amount);
  const reference = document.createElement('small');
  reference.textContent = `Reference ${data.merchant_reference}`;
  const expiry = document.createElement('small');
  expiry.textContent = `Status ${data.status} · Berlaku hingga ${new Date(data.expires_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;
  section.append(label, amount, reference, expiry);
  $('#checkoutDetails').append(section);
  $('#returnLink').href = data.return_url || '/';
  $('#checkoutForm button').disabled =
    data.status !== 'pending' || Date.now() > Date.parse(data.expires_at);
  return data;
}
function result(message, error = false) {
  $('#checkoutResult').className = `checkout-result ${error ? 'error' : ''}`;
  $('#checkoutResult').textContent = message;
}
$('#checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const response = await fetch(`/v1/checkout/${encodeURIComponent(id)}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, scenario: new FormData(event.target).get('scenario') }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Simulasi gagal.');
    result(
      `Status provider: ${data.attempt.provider_status}. Event webhook dibuat. Buka merchant untuk melihat hasil verifikasi.`,
    );
    await load();
  } catch (error) {
    result(error.message, true);
    button.disabled = false;
  }
});
try {
  await load();
} catch (error) {
  result(error.message, true);
  $('#checkoutForm').hidden = true;
}
