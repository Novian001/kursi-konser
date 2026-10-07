import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { api } from './api.js';

// Gate: phone camera scans the signed QR, hits /gate/scan.
// native BarcodeDetector first; jsQR fallback (Safari/Firefox lack it).
// 409 'already used' on a second terminal is the expected double-scan answer, not a crash.
export default function Gate() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [gate, setGate] = useState(() => localStorage.getItem('kk_gate') || 'gate-A');
  const [camOn, setCamOn] = useState(false);
  const [result, setResult] = useState(null); // {ok, seat} | {error}
  const [manual, setManual] = useState('');
  const busyRef = useRef(false);
  const streamRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('kk_gate', gate);
  }, [gate]);

  useEffect(() => () => stopCam(), []);

  async function startCam() {
    setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
      });
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      setCamOn(true);
      tick();
    } catch (e) {
      setResult({ error: `Kamera tidak bisa dibuka (${e.name}) — pakai input manual.` });
    }
  }

  function stopCam() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCamOn(false);
  }

  async function submit(code) {
    if (busyRef.current || !code) return;
    busyRef.current = true;
    try {
      const r = await api.scan(code, gate);
      setResult({ ok: true, ...r });
    } catch (e) {
      setResult({ error: e.message });
    } finally {
      busyRef.current = false;
    }
  }

  // scan loop: decode → submit once → keep camera running for the next visitor
  async function tick() {
    if (!streamRef.current) return;
    const v = videoRef.current, c = canvasRef.current;
    if (v && v.readyState === v.HAVE_ENOUGH_DATA) {
      const w = v.videoWidth, h = v.videoHeight;
      if (w && h) {
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, w, h);
        let code = null;
        if ('BarcodeDetector' in window) {
          try {
            const det = new window.BarcodeDetector({ formats: ['qr_code'] });
            const found = await det.detect(c);
            if (found.length) code = found[0].rawValue;
          } catch { /* fall through to jsQR */ }
        }
        if (!code) {
          const img = ctx.getImageData(0, 0, w, h);
          const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
          if (r) code = r.data;
        }
        if (code) await submit(code);
      }
    }
    if (streamRef.current) requestAnimationFrame(() => tick());
  }

  return (
    <section className="card gate">
      <h2>Gate Scan</h2>
      <label htmlFor="gate-name">Nama gate</label>
      <input id="gate-name" value={gate} onChange={(e) => setGate(e.target.value)} />

      <div className="cam-wrap">
        <video ref={videoRef} muted playsInline aria-label="Kamera pemindai QR" />
        <canvas ref={canvasRef} hidden />
        {!camOn && (
          <button className="primary" onClick={startCam}>Nyalakan kamera</button>
        )}
        {camOn && <button className="ghost" onClick={stopCam}>Matikan kamera</button>}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); submit(manual.trim()); setManual(''); }} className="row">
        <input value={manual} onChange={(e) => setManual(e.target.value)}
               placeholder="atau ketik kode tiket" aria-label="Kode tiket manual" autoComplete="off" />
        <button type="submit" disabled={!manual.trim()}>Cek</button>
      </form>

      {result && (
        <div className={`verdict ${result.ok ? 'in' : 'rej'}`} role="status" aria-live="polite">
          {result.ok
            ? <>✅ MASUK — Kursi <strong>{result.seat}</strong> ({result.section})</>
            : <>❌ {result.error}</>}
        </div>
      )}
      <p className="muted">Scan ganda = hanya 1 diterima; scan kedua ditolak + tercatat di log.</p>
    </section>
  );
}
