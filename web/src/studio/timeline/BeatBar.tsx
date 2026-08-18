/**
 * Bar BEAT & LOOP yang menempel di atas halaman.
 *
 * Dulu ia satu blok di dalam Clip Detail. Masalahnya: ini kontrol yang dipakai
 * BERULANG-ULANG sambil melihat timeline — ganti panjang loop, geser satu loop,
 * LOOP PLAY, ×2 — dan Clip Detail bisa berada jauh di bawah layar. Menggulir
 * bolak-balik untuk menekan tombol yang sama setiap beberapa detik adalah biaya
 * yang tidak perlu dibayar.
 *
 * Karena `position: sticky` di sini, halaman ini TIDAK punya scroller sendiri —
 * dokumen yang menggulir (lihat `StudioLayout`), dan sticky bekerja terhadapnya.
 */

import { useState } from 'react';

import { useStudio } from '../store';
import { BeatControls } from './BeatSection';
import { useBeatShared } from './beat-context';

export function BeatBar(): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const { shown, isSelected, beat } = useBeatShared();
  const [note, setNote] = useState<string | null>(null);

  return (
    <div
      data-beat-bar
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        // Latar PEKAT, bukan transparan: bar ini melintas di atas waveform
        // timeline, dan tombol di atas gelombang kuning tidak terbaca.
        background: 'var(--cy-surface-1)',
        borderBottom: '1px solid var(--cy-border-strong)',
        boxShadow: '0 6px 18px #000000cc',
        padding: '8px 24px 10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <span style={{ fontSize: '9px', letterSpacing: '.18em', color: 'var(--cy-accent)' }}>
          BEAT &amp; LOOP
        </span>
        <span
          style={{
            fontSize: '10px',
            color: shown === null ? 'var(--cy-text-muted)' : isSelected ? 'var(--cy-text)' : 'var(--cy-text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '40ch',
          }}
        >
          {shown === null ? 'belum ada clip' : shown.clip.label}
        </span>
        {shown !== null && !isSelected ? (
          <span
            style={{
              fontSize: '9px',
              letterSpacing: '.14em',
              color: 'var(--cy-text-muted)',
              border: '1px solid var(--cy-border-strong)',
              padding: '1px 6px',
            }}
            title="clip ini tidak sedang tersorot di timeline, tapi kontrol di sini tetap berlaku untuknya"
          >
            TIDAK TERPILIH
          </span>
        ) : null}
        {note === null ? null : (
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-accent)' }}>
            {note}
          </span>
        )}
      </div>

      {shown === null ? (
        <div style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          jatuhkan audio ke timeline untuk mulai
        </div>
      ) : (
        <BeatControls
          beat={beat}
          clip={shown.clip}
          asset={assets[shown.clip.assetId]}
          sampleRate={sampleRate}
          onCut={setNote}
        />
      )}
    </div>
  );
}
