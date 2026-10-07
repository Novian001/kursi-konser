import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, rupiah } from './api.js';

// issued tickets: QR renders the signed opaque code (server HMAC) — not guessable seat ids.
export default function Tickets({ order, onBack }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.tickets(order.order_id).then(setList).catch((e) => setErr(e.message));
  }, [order.order_id]);

  return (
    <section className="card">
      <h2>Tiket kamu</h2>
      {err && <div className="err" role="alert">{err}</div>}
      {!list && !err && <p className="muted">Menerbitkan tiket…</p>}
      {list && !list.length && <p className="muted">Belum ada tiket (mungkin hold kedaluwarsa).</p>}
      <div className="tickets">
        {(list || []).map((t) => <Ticket key={t.id} t={t} />)}
      </div>
      <div className="action-bar">
        <span className="muted">{list?.length ? rupiah(list[0].total_cents) : ''}</span>
        <button className="primary" onClick={onBack}>Selesai</button>
      </div>
    </section>
  );
}

function Ticket({ t }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) QRCode.toDataURL(t.code, { margin: 1, width: 240, color: { dark: '#0f1115', light: '#ffffff' } })
      .then((u) => { ref.current.src = u; }).catch(() => {});
  }, [t.code]);
  return (
    <figure className="ticket">
      <img ref={ref} alt={`QR tiket kursi ${t.seat}`} width="240" height="240" />
      <figcaption>
        <strong>Kursi {t.seat}</strong>
        <span className={t.status}>{t.status === 'paid' ? 'LUNAS' : t.status}</span>
      </figcaption>
    </figure>
  );
}
