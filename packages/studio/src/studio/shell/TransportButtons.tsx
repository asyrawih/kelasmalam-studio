/**
 * Transport ringkas di toolbar — SELALU terlihat, bukan di balik menu.
 *
 * Semua kontrol lain boleh bersembunyi di popup; ini tidak. PLAY ditekan setiap
 * beberapa detik sepanjang sesi, dan perintah sesering itu tidak boleh butuh
 * dua klik. Sisanya (skip ±5 s yang lebih presisi, loop, preset kecepatan) tetap
 * ada di menu TRANSPORT — yang di sini hanyalah yang dipakai terus-menerus.
 */

import { formatTime, samplesToSec } from '../model';
import { studioActions, useStudio } from '../store';

const BTN: React.CSSProperties = {
  height: '30px',
  minWidth: '30px',
  padding: '0 8px',
  background: 'transparent',
  border: '1px solid var(--cy-border)',
  color: 'var(--cy-text-dim)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  cursor: 'pointer',
};

export function TransportButtons(): JSX.Element {
  const playing = useStudio((s) => s.playing);
  const playhead = useStudio((s) => s.playhead);
  const sampleRate = useStudio((s) => s.sampleRate);
  const loop = useStudio((s) => s.loop);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <button
        type="button"
        aria-label="kembali ke awal"
        title="Kembali ke awal (Backspace)"
        className="cy-btn-reset cy-focusable cy-hover-accent-border"
        onClick={() => studioActions.setPlayhead(0)}
        style={BTN}
      >
        ⏮
      </button>
      <button
        type="button"
        aria-label={playing ? 'pause' : 'play'}
        title="Play / pause (ketuk Spasi)"
        className="cy-btn-reset cy-focusable"
        onClick={() => studioActions.togglePlay()}
        style={{
          ...BTN,
          minWidth: '58px',
          background: playing ? 'var(--cy-accent)' : 'transparent',
          color: playing ? 'var(--cy-text-on-accent)' : 'var(--cy-accent)',
          borderColor: 'var(--cy-accent)',
          fontSize: '10px',
          letterSpacing: '.12em',
        }}
      >
        {playing ? '❚❚' : '▶ PLAY'}
      </button>
      <button
        type="button"
        aria-label="ulangi dari awal saat habis"
        aria-pressed={loop}
        title="Ulangi dari awal saat mencapai akhir materi"
        className="cy-btn-reset cy-focusable cy-hover-accent-border"
        onClick={() => studioActions.toggleLoop()}
        style={{
          ...BTN,
          color: loop ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
          borderColor: loop ? 'var(--cy-accent)' : 'var(--cy-border)',
        }}
      >
        ⟲
      </button>
      <span
        style={{
          marginLeft: '4px',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '12px',
          color: 'var(--cy-accent)',
          minWidth: '48px',
        }}
      >
        {formatTime(samplesToSec(playhead, sampleRate))}
      </span>
    </div>
  );
}
