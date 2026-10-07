import React, { useEffect, useMemo, useState } from 'react';

// seat map canvas: sections laid out as blocks, seats colored by state.
// keyboard: every seat is a real <button> (44px min touch target) — canvas is visual only.
export default function SeatMap({ event, hold, onHold, onClear }) {
  const [picked, setPicked] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // countdown for the current hold (single rAF-free interval — cheap)
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);

  const seatsBySection = useMemo(() => {
    const m = new Map();
    for (const s of event.seats) {
      if (!m.has(s.section)) m.set(s.section, []);
      m.get(s.section).push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.row === b.row ? a.num - b.num : a.row.localeCompare(b.row)));
    return m;
  }, [event]);

  const stateOf = (s) => {
    if (s.blocked) return 'blocked';
    if (hold && picked.includes(s.id)) return 'picked';
    return s.state; // free | held | sold
  };

  function toggle(s) {
    if (s.blocked) return;
    if (s.state !== 'free' && !picked.includes(s.id)) return; // taken seats unclickable
    setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]));
  }

  async function confirmHold() {
    setBusy(true);
    try { await onHold(picked); setPicked([]); } finally { setBusy(false); }
  }

  const remaining = hold ? Math.max(0, Math.floor((hold.expires_at - now) / 1000)) : 0;

  return (
    <section>
      <div className="event-head">
        <h2>{event.event.name}</h2>
        <p className="muted">{event.event.venue} · {new Date(event.event.starts_at).toLocaleString('id-ID')}</p>
      </div>

      {hold && (
        <div className="hold-bar" role="status">
          <span>Hold aktif — {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} tersisa</span>
          <button onClick={onClear}>Batal hold</button>
        </div>
      )}

      {[...seatsBySection.entries()].map(([name, seats]) => (
        <div key={name} className="section-block">
          <h3>{name}</h3>
          <div className="seat-grid" role="group" aria-label={`Kursi ${name}`}>
            {seats.map((s) => {
              const st = stateOf(s);
              return (
                <button
                  key={s.id}
                  className={`seat ${st}`}
                  aria-pressed={picked.includes(s.id)}
                  aria-label={`${s.label} ${st === 'free' ? 'tersedia' : st}`}
                  disabled={st === 'blocked' || st === 'sold' || (st === 'held' && !picked.includes(s.id))}
                  onClick={() => toggle(s)}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="legend" aria-hidden="true">
        <span className="seat free" /> tersedia
        <span className="seat picked" /> pilihanmu
        <span className="seat held" /> ditahan
        <span className="seat sold" /> terjual
        <span className="seat blocked" /> diblokir
      </div>

      <div className="action-bar">
        <span>{picked.length ? `${picked.length} kursi dipilih` : 'Pilih kursi untuk lanjut'}</span>
        <button className="primary" disabled={!picked.length || busy || !!hold} onClick={confirmHold}>
          {busy ? 'Memproses…' : 'Tahan 10 menit'}
        </button>
      </div>
    </section>
  );
}
