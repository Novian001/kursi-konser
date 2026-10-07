// thin API client — /api prefix injected by vite proxy in dev; production is frontend-only
// (backend runs locally, not deployed), so /api answers 404/502 there.
const B = '/api';
async function req(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  // HTTP/2 has no statusText -> never fall back to '' (falsy err = infinite "Memuat event…")
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText || `HTTP ${r.status}`), { status: r.status });
  return j;
}
export const api = {
  event: () => req('GET', '/event'),
  hold: (seats, userKey) => req('POST', '/hold', { seats, user_key: userKey }),
  checkout: (holdId, userKey, promo) => req('POST', '/checkout', { hold_id: holdId, user_key: userKey, promo_code: promo }),
  payMock: (orderId) => req('POST', '/pay/mock/confirm', { order_id: orderId }),
  tickets: (orderId) => req('GET', `/tickets/${orderId}`),
  scan: (code, gate) => req('POST', '/gate/scan', { code, gate }),
  settle: () => req('POST', '/settle'),
};
export const rupiah = (cents) => 'Rp' + (cents / 100).toLocaleString('id-ID');
