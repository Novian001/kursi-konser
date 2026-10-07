import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import SeatMap from './SeatMap.jsx';
import Checkout from './Checkout.jsx';
import Tickets from './Tickets.jsx';
import Gate from './Gate.jsx';

// stable per-browser buyer identity (no accounts in demo — keeps promo cap honest)
const buyerKey = () => {
  let k = localStorage.getItem('kk_buyer');
  if (!k) { k = 'b-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('kk_buyer', k); }
  return k;
};

export default function App() {
  const [view, setView] = useState('map'); // map | checkout | tickets | gate | admin
  const [event, setEvent] = useState(null);
  const [err, setErr] = useState(null);
  const [hold, setHold] = useState(null);
  const [order, setOrder] = useState(null);

  const load = () => api.event().then(setEvent).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function onHold(seatIds) {
    setErr(null);
    try {
      const h = await api.hold(seatIds, buyerKey());
      const seatsJson = JSON.stringify(seatIds);
      setHold({ ...h, seats_json: seatsJson });
      setView('checkout');
    } catch (e) { setErr(e.message); load(); }
  }

  return (
    <div className="app">
      <header>
        <h1>KursiKonser</h1>
        <nav>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>Pilih Kursi</button>
          <button className={view === 'gate' ? 'on' : ''} onClick={() => setView('gate')}>Gate Scan</button>
          <button className={view === 'admin' ? 'on' : ''} onClick={() => setView('admin')}>Admin</button>
        </nav>
      </header>
      {err && <div className="err" role="alert">{err}</div>}

      {view === 'map' && event && (
        <SeatMap event={event} hold={hold} onHold={onHold} onClear={() => setHold(null)} />
      )}
      {view === 'checkout' && hold && (
        <Checkout hold={hold} event={event} buyerKey={buyerKey()}
          onPaid={(o) => { setOrder(o); setView('tickets'); }}
          onCancel={() => { setHold(null); setView('map'); load(); }} />
      )}
      {view === 'tickets' && order && <Tickets order={order} onBack={() => { setHold(null); setView('map'); load(); }} />}
      {view === 'gate' && <Gate />}
      {view === 'admin' && <Admin />}
      {!event && !err && <p className="muted">Memuat event…</p>}
    </div>
  );
}

function Admin() {
  const [out, setOut] = useState(null);
  const [e, setE] = useState(null);
  return (
    <section className="card">
      <h2>Settlement</h2>
      <p className="muted">Rekonsiliasi: split + fee + tax + refund = gross. Tiket = kursi terjual.</p>
      <button onClick={() => api.settle().then(setOut).catch((x) => setE(x.message))}>
        Jalankan settlement
      </button>
      {e && <div className="err" role="alert">{e}</div>}
      {out && <pre>{JSON.stringify(out, null, 2)}</pre>}
    </section>
  );
}
