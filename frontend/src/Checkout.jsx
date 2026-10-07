import React, { useState } from 'react';
import { api, rupiah } from './api.js';

// checkout: promo applied server-side (cap enforced there — client never computes totals)
export default function Checkout({ hold, event, buyerKey, onPaid, onCancel }) {
  const [promo, setPromo] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function doCheckout(code) {
    setErr(null);
    setBusy(true);
    try {
      const c = await api.checkout(hold.hold_id, buyerKey, code || undefined);
      setPreview(c);
      return c;
    } catch (e) { setErr(e.message); return null; }
    finally { setBusy(false); }
  }

  async function pay() {
    setErr(null);
    setBusy(true);
    try {
      const c = preview || (await doCheckout(promo));
      if (!c) return;
      await api.payMock(c.order_id); // mock driver: instant settle; swap for Midtrans redirect when live
      onPaid(c);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card">
      <h2>Checkout</h2>
      {err && <div className="err" role="alert">{err}</div>}
      {!preview && (
        <>
          <label htmlFor="promo">Kode promo</label>
          <div className="row">
            <input id="promo" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())}
                   placeholder="HEMAT20" autoComplete="off" />
            <button onClick={() => doCheckout(promo)} disabled={busy || !promo}>Terapkan</button>
            <button className="ghost" onClick={() => doCheckout('')} disabled={busy}>Tanpa promo</button>
          </div>
        </>
      )}
      {preview && (
        <div className="summary">
          <ul>
            {preview.lines.map((l) => (
              <li key={l.seat_id}><span>{l.label}</span><span>{l.tier}</span><span>{rupiah(l.price_cents)}</span></li>
            ))}
          </ul>
          <div className="line"><span>Subtotal</span><span>{rupiah(preview.base_cents)}</span></div>
          {preview.discount_cents > 0 && (
            <div className="line discount"><span>Diskon {preview.promo_code}</span><span>−{rupiah(preview.discount_cents)}</span></div>
          )}
          <div className="line total"><span>Total</span><span>{rupiah(preview.total_cents)}</span></div>
          <p className="muted">Kursi ditahan sampai pembayaran selesai.</p>
        </div>
      )}
      <div className="action-bar">
        <button className="ghost" onClick={onCancel} disabled={busy}>Batal</button>
        {preview
          ? <button className="primary" onClick={pay} disabled={busy}>{busy ? 'Membayar…' : 'Bayar (mock)'}</button>
          : <button className="primary" onClick={() => doCheckout(promo)} disabled={busy}>{busy ? 'Memproses…' : 'Lanjut bayar'}</button>}
      </div>
    </section>
  );
}
