/**
 * Kartu Transport — baris tombol skip/play + pemilih speed.
 * Ukuran, warna, dan clip-path mengikuti design (`Audio Studio.dc.html`).
 */

import type { CSSProperties } from 'react';
import { Card } from '../../ui/cyber';
import { PITCH_LOCK_AVAILABLE, SPEEDS, type Speed } from '../model';
import { useStudio } from '../store';
import { studioActions, usePlaying, useSpeed } from './store-adapter';

const SIDE_BTN: CSSProperties = {
  flex: 1,
  height: '40px',
  border: '1px solid var(--cy-border-strong)',
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text-dim)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  cursor: 'pointer',
};

const PLAY_BTN: CSSProperties = {
  flex: 2,
  height: '40px',
  border: '1px solid var(--cy-accent)',
  background: 'var(--cy-accent)',
  color: 'var(--cy-text-on-accent)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '12px',
  letterSpacing: '.1em',
  cursor: 'pointer',
  clipPath: 'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)',
};

/**
 * DEVIASI SADAR dari design. Design menulis "SPEED · PITCH LOCKED", tapi engine
 * saat ini varispeed (pitch ikut naik/turun bersama speed); time-stretch yang
 * mempertahankan pitch baru fase 2 (docs/07, `PITCH_LOCK_AVAILABLE`).
 * Menampilkan "PITCH LOCKED" sekarang = berbohong tentang apa yang terjadi ke
 * audio. Label kembali persis seperti design begitu flag-nya menyala.
 */
const SPEED_LABEL = PITCH_LOCK_AVAILABLE ? 'SPEED · PITCH LOCKED' : 'SPEED · VARISPEED';
const SPEED_TITLE = PITCH_LOCK_AVAILABLE
  ? 'Pitch dipertahankan saat kecepatan berubah.'
  : 'Varispeed: pitch ikut berubah mengikuti kecepatan. Time-stretch yang mempertahankan pitch belum ada.';

export function TransportCard(): JSX.Element {
  const playing = usePlaying();
  const loop = useStudio((st) => st.loop);
  const speed = useSpeed();

  return (
    <Card title="Transport" notched>
      <div style={{ display: 'grid', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="cy-btn-reset cy-hover-accent-border"
            style={SIDE_BTN}
            onClick={() => studioActions.nudgePlayhead(-5)}
          >
            « -5S
          </button>
          <button
            type="button"
            className="cy-btn-reset cy-hover-accent-bg"
            style={PLAY_BTN}
            aria-pressed={playing}
            onClick={() => studioActions.togglePlay()}
          >
            {playing ? '❚❚ PAUSE' : '▶ PLAY'}
          </button>
          <button
            type="button"
            className="cy-btn-reset cy-hover-accent-border"
            style={SIDE_BTN}
            onClick={() => studioActions.nudgePlayhead(5)}
          >
            +5S »
          </button>
          <button
            type="button"
            className="cy-btn-reset"
            aria-pressed={loop}
            title={
              loop
                ? 'Loop menyala: kembali ke awal saat materi habis'
                : 'Loop mati: berhenti di ujung materi'
            }
            onClick={() => studioActions.toggleLoop()}
            style={{
              ...SIDE_BTN,
              flex: '0 0 44px',
              border: `1px solid ${loop ? 'var(--cy-accent)' : 'var(--cy-border-strong)'}`,
              background: loop ? 'var(--cy-accent)' : 'var(--cy-surface-2)',
              color: loop ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
              fontSize: '14px',
            }}
          >
            ⟲
          </button>
        </div>

        <div>
          <div
            title={SPEED_TITLE}
            style={{
              fontSize: '9px',
              letterSpacing: '.16em',
              color: 'var(--cy-text-muted)',
              marginBottom: '6px',
            }}
          >
            {SPEED_LABEL}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5,minmax(0,1fr))',
              gap: '4px',
            }}
          >
            {SPEEDS.map((v: Speed) => {
              const active = speed === v;
              return (
                <button
                  key={v}
                  type="button"
                  className="cy-btn-reset cy-hover-accent-border"
                  aria-pressed={active}
                  onClick={() => studioActions.setSpeed(v)}
                  style={{
                    height: '28px',
                    border: '1px solid var(--cy-border)',
                    background: active ? 'var(--cy-accent)' : 'transparent',
                    color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                    fontFamily: 'var(--cy-font-mono)',
                    fontSize: '10px',
                    cursor: 'pointer',
                  }}
                >
                  {v}x
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
