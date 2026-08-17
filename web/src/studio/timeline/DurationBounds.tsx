/**
 * Kotak input batas panjang timeline (detik) — tambahan di bawah overview.
 *
 * MIN  : timeline tidak pernah lebih pendek dari ini.
 * MAX  : timeline tidak pernah lebih panjang dari ini, KECUALI kalau ada clip
 *        yang melewatinya — konten selalu menang (lihat withDerived di store).
 *        Kosongkan untuk kembali otomatis mengikuti konten.
 *
 * Nilai diterapkan saat blur / Enter, bukan tiap ketikan: mengetik "1" dari
 * "120" akan sempat membuat timeline menjadi 1 detik dan menggulung seluruh
 * tampilan sebelum kamu sempat mengetik angka berikutnya.
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { formatTime } from '../model';
import { studioActions, useStudio } from '../store';

const boxStyle = {
  width: '72px',
  height: '26px',
  background: '#000',
  border: '1px solid var(--cy-border)',
  color: 'var(--cy-text)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '0 8px',
  outline: 'none',
} as const;

const labelStyle = {
  fontSize: '9px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
  textTransform: 'uppercase',
} as const;

export function DurationBounds(): JSX.Element {
  const minSec = useStudio((s) => s.minDurationSec);
  const maxSec = useStudio((s) => s.maxDurationSec);
  const durationSec = useStudio((s) => s.duration / s.sampleRate);

  const [minText, setMinText] = useState(String(minSec));
  const [maxText, setMaxText] = useState(maxSec === null ? '' : String(maxSec));

  // Sinkron kalau state berubah dari tempat lain.
  useEffect(() => setMinText(String(minSec)), [minSec]);
  useEffect(() => setMaxText(maxSec === null ? '' : String(maxSec)), [maxSec]);

  const commit = (): void => {
    const nextMin = Number.parseInt(minText, 10);
    const trimmed = maxText.trim();
    const nextMax = trimmed === '' ? null : Number.parseInt(trimmed, 10);
    studioActions.setDurationBounds(
      Number.isFinite(nextMin) ? nextMin : minSec,
      nextMax !== null && Number.isFinite(nextMax) ? nextMax : null,
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const capped = maxSec !== null && durationSec > maxSec;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginTop: '8px',
        flexWrap: 'wrap',
      }}
    >
      <span style={labelStyle}>Timeline</span>

      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={labelStyle}>Min</span>
        <input
          aria-label="Panjang minimum timeline (detik)"
          value={minText}
          inputMode="numeric"
          onChange={(e) => setMinText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          style={boxStyle}
        />
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={labelStyle}>Max</span>
        <input
          aria-label="Panjang maksimum timeline (detik), kosong = otomatis"
          value={maxText}
          placeholder="auto"
          inputMode="numeric"
          onChange={(e) => setMaxText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          style={boxStyle}
        />
      </label>

      <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>
        detik · aktif: {formatTime(durationSec)}
      </span>

      {capped ? (
        <span style={{ fontSize: '10px', color: 'var(--cy-accent-alt)' }}>
          MAX diabaikan — ada clip melewati batas
        </span>
      ) : null}
    </div>
  );
}
