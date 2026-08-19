/**
 * Meter level — peak sungguhan dari `AnalyserNode`, dengan penahan puncak.
 *
 * ## Kenapa canvas dan rAF bersama, bukan state React
 *
 * Meter bergerak 60×/detik. Menaruh levelnya di state berarti dua channel strip
 * dan master me-render ulang 60 kali per detik, dan di halaman ini setiap render
 * menyentuh dua waveform yang juga sedang berjalan. Pola yang sama sudah dipakai
 * `ui/panels/MixerStrips.tsx`, dan alasannya ditulis di sana.
 *
 * ## Kenapa `NO SIGNAL` masih ada
 *
 * Selama lapisan audio belum dibangun — yaitu sebelum gestur pertama user —
 * tidak ada apa pun untuk diukur. Meter yang menari tanpa audio adalah
 * kebohongan yang paling sering dimaafkan dan paling merusak kepercayaan pada
 * sisa layar, jadi yang digambar adalah skalanya saja beserta alasannya.
 *
 * ## Ballistics
 *
 * Peak naik SEKETIKA dan turun perlahan (docs/07 §7e). Naik yang dihaluskan
 * akan menyembunyikan transien — yaitu justru hal yang dipakai orang untuk
 * menyetel trim. Penahan puncak tinggal 800 ms supaya clip sesaat tetap
 * terlihat setelah kejadiannya lewat.
 */

import { useEffect, useRef, useState } from 'react';

import { djAudio } from '../audio/engine';
import type { DeckId } from '../model';

/** Dasar skala. −36 dB cukup untuk melihat isi mix tanpa membuang tinggi. */
const FLOOR_DB = -36;
/** Peluruhan peak, dB per detik. */
const DECAY_DB_PER_SEC = 60;
const HOLD_MS = 800;

const TICKS = [0, -3, -6, -12, -18, -30];

function toNorm(db: number): number {
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

export interface LevelMeterProps {
  readonly source: DeckId | 'master';
  readonly height: number;
  readonly width?: number;
  readonly label?: string;
}

export function LevelMeter({ source, height, width = 8, label }: LevelMeterProps): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let raf = 0;
    let db = FLOOR_DB;
    let holdDb = FLOOR_DB;
    let holdUntil = 0;
    let prevT = 0;
    let wasLive = false;

    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame);
      const audio = djAudio();
      const isLive = audio !== null;
      if (isLive !== wasLive) {
        wasLive = isLive;
        setLive(isLive);
      }
      if (audio === null) return;

      const dt = prevT === 0 ? 0 : (t - prevT) / 1000;
      prevT = t;

      const peak = audio.peak(source);
      const peakDb = peak > 0 ? 20 * Math.log10(peak) : FLOOR_DB;

      // Naik seketika, turun perlahan.
      db = peakDb > db ? peakDb : Math.max(FLOOR_DB, db - DECAY_DB_PER_SEC * dt);
      if (peakDb >= holdDb || t > holdUntil) {
        holdDb = peakDb;
        holdUntil = t + HOLD_MS;
      }

      const bar = barRef.current;
      if (bar !== null) bar.style.height = `${toNorm(db) * 100}%`;
      const hold = holdRef.current;
      if (hold !== null) hold.style.bottom = `${toNorm(holdDb) * 100}%`;
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [source]);

  return (
    <div
      title={
        live
          ? 'peak — naik seketika, turun 60 dB/detik, penahan puncak 800 ms'
          : 'audio belum dibangun; klik kontrol mana pun untuk menyalakannya'
      }
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}
    >
      <div
        style={{
          position: 'relative',
          width: `${width}px`,
          height: `${height}px`,
          background: '#000',
          border: '1px solid var(--cy-border)',
          overflow: 'hidden',
        }}
      >
        <div
          ref={barRef}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '0%',
            // Hijau → amber → merah. Merah hanya di 3 dB teratas: kalau seluruh
            // batang berwarna peringatan, tidak ada yang jadi peringatan.
            background:
              'linear-gradient(to top, #7ee787 0%, #ffd400 78%, #ffb020 92%, #ff4d4d 100%)',
          }}
        />
        <div
          ref={holdRef}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '0%',
            height: '1px',
            background: '#f2efe6',
            opacity: 0.9,
          }}
        />
        {TICKS.map((db) => (
          <div
            key={db}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `${toNorm(db) * 100}%`,
              height: '1px',
              background: db === 0 ? '#ff4d4d55' : '#28252088',
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: '7px',
          letterSpacing: '.08em',
          color: live ? 'var(--cy-text-dim)' : 'var(--cy-text-muted)',
          writingMode: 'vertical-rl',
          height: '52px',
        }}
      >
        {live ? (label ?? 'PEAK') : 'NO SIGNAL'}
      </div>
    </div>
  );
}
