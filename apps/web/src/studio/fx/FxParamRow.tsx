/**
 * Satu baris parameter — dirakit sepenuhnya dari `ParamDesc`.
 *
 * Tidak ada satu pun nama efek atau nama parameter di berkas ini. Rentang,
 * default, taper, satuan, dan label semuanya datang dari katalog Rust, jadi
 * efek ke-20 muncul dengan kontrol yang benar tanpa satu baris TypeScript baru.
 * Itu bukan kerapian: alternatifnya adalah `switch (effect.kind)` yang harus
 * disunting tiap kali katalog bertambah, dan yang cabang terbarunya selalu
 * berbeda tipis dari yang pertama.
 */

import { formatParam, fromNorm, toNorm, type ParamDesc } from '../../audio/fx-catalog';
import { useDragFraction } from '../rail/useDragFraction';

export interface FxParamRowProps {
  readonly desc: ParamDesc;
  readonly value: number;
  readonly onChange: (value: number) => void;
}

export function FxParamRow({ desc, value, onChange }: FxParamRowProps): JSX.Element {
  const t = toNorm(desc, value);
  // Taper diterapkan di sini, memakai fungsi yang SAMA dengan Rust — dijamin
  // sama oleh `fx-catalog.test.ts`, yang membandingkannya dengan fixture yang
  // dicetak engine. Kalau keduanya menyimpang, knob menunjuk angka yang berbeda
  // dari yang benar-benar terdengar.
  const drag = useDragFraction((f) => onChange(fromNorm(desc, f)));
  const pct = `${Math.round(t * 100)}%`;

  return (
    <div style={{ display: 'grid', gap: '3px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '9px',
          letterSpacing: '.1em',
          color: 'var(--cy-text-dim)',
        }}
      >
        <span>{desc.name}</span>
        <span aria-hidden>{formatParam(desc, value)}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={desc.name}
        aria-valuemin={desc.min}
        aria-valuemax={desc.max}
        aria-valuenow={value}
        aria-valuetext={formatParam(desc, value)}
        {...drag}
        onKeyDown={(e) => {
          // Keyboard bergerak per LANGKAH POSISI, bukan per satuan: pada taper
          // logaritmik satu langkah Hz di ujung bawah tak terdengar sementara
          // di ujung atas melompati satu oktaf.
          const step = e.shiftKey ? 0.01 : 0.05;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(fromNorm(desc, t - step));
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(fromNorm(desc, t + step));
          } else if (e.key === 'Home') {
            e.preventDefault();
            onChange(desc.default);
          }
        }}
        style={{
          position: 'relative',
          height: '14px',
          border: '1px solid var(--cy-border)',
          background: 'var(--cy-surface, transparent)',
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '1px auto 1px 1px',
            width: `calc(${pct} - 2px)`,
            background: 'var(--cy-accent)',
            opacity: 0.55,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}
