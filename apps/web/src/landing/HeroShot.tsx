/**
 * Mock timeline di hero — "screenshot" studio yang ada di kanan headline.
 *
 * Design memasang PNG statis (`uploads/pasted-1787056171154-0.png`) di slot
 * ini, tapi PNG itu tidak ikut ke repo: aset binernya hidup di project design,
 * dan sebuah tangkapan layar akan basi begitu studio berubah. Yang digambar di
 * sini adalah data yang SUDAH ada di script design file — `heroLanes`,
 * `heroClock`, `heroPlayhead`, beserta fungsi `rnd`/`bars`-nya — dirender
 * sebagai DOM. Hasilnya mengikuti tema, ikut bergerak, dan tidak pernah basi.
 *
 * Ticker-nya sengaja dikurung di komponen ini, bukan di halaman: kalau state
 * `t` hidup di LandingPage, seluruh halaman (harga, FAQ, 6 kartu fitur)
 * ter-render ulang 11× per detik hanya untuk menggeser satu garis playhead.
 */

import { useEffect, useMemo, useState } from 'react';
import { HERO_LANES, type HeroLane } from './content';

/** Periode tick — sama dengan `setInterval(..., 90)` di script design. */
const TICK_MS = 90;

/** Hash deterministik dari design: `sin(i*127.1+3.7) * 43758.5453`, ambil pecahannya. */
function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 3.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Tinggi tiap batang waveform (persen), dengan gate yang membuat celah senyap. */
function bars(n: number, seed: number): readonly number[] {
  return Array.from({ length: n }, (_, i) => {
    const gate = rnd(Math.floor(i / 2) * 5.3 + seed) > 0.15 ? 1 : 0.25;
    return Math.max(6, Math.round(gate * (0.45 + 0.55 * rnd(i * 3.1 + seed)) * 95));
  });
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Posisi playhead 0..100 yang berjalan; berhenti kalau user minta minim gerak. */
function usePlayhead(): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = setInterval(() => setT((v) => v + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (t * 0.6) % 100;
}

function LaneRow({ lane, waveform }: { lane: HeroLane; waveform: readonly number[] }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: '46px' }}>
      <div
        style={{
          width: '84px',
          flex: '0 0 84px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 8px',
          borderRight: '1px solid var(--cy-border)',
          background: 'var(--cy-surface-1)',
        }}
      >
        <span style={{ width: '5px', height: '5px', background: lane.color, flex: '0 0 5px' }} />
        <span
          style={{
            fontSize: '8px',
            letterSpacing: '.14em',
            color: 'var(--cy-text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lane.name}
        </span>
      </div>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <div
          style={{
            position: 'absolute',
            top: '5px',
            bottom: '5px',
            left: `${lane.l}%`,
            width: `${lane.w}%`,
            border: `1px solid ${lane.color}`,
            background: `${lane.color}14`,
            display: 'flex',
            alignItems: 'center',
            gap: '1px',
            padding: '0 3px',
            overflow: 'hidden',
          }}
        >
          {waveform.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                minWidth: 0,
                height: `${h}%`,
                background: lane.color,
                opacity: 0.75,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function HeroShot(): JSX.Element {
  const p = usePlayhead();
  // Bentuk gelombang tidak bergantung pada waktu — hitung sekali, jangan ikut
  // dihitung ulang setiap tick playhead.
  const waveforms = useMemo(() => HERO_LANES.map((l) => bars(l.barCount, l.seed)), []);
  const clock = `00:${String(Math.floor(p * 0.36)).padStart(2, '0')} / 01:40`;

  return (
    <div style={{ position: 'relative', perspective: '1400px' }}>
      <div
        className="km-shot-glow"
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: '-8% -6% -14%',
          background: 'radial-gradient(60% 55% at 50% 45%,#ffd40033,transparent 72%)',
          filter: 'blur(22px)',
          pointerEvents: 'none',
        }}
      />
      <div
        className="km-shot"
        style={{
          position: 'relative',
          border: '1px solid var(--cy-border-strong)',
          background: '#000',
          boxShadow: '0 30px 70px #000000cc, 0 0 0 1px #ffd4001f',
        }}
      >
        {/* Title bar jendela studio. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '9px 12px',
            borderBottom: '1px solid var(--cy-border)',
            background: 'var(--cy-surface-1)',
          }}
        >
          <span style={{ width: '8px', height: '8px', background: 'var(--cy-accent)' }} />
          <span style={{ width: '8px', height: '8px', background: 'var(--cy-border-strong)' }} />
          <span style={{ width: '8px', height: '8px', background: 'var(--cy-border-strong)' }} />
          <span
            style={{
              marginLeft: '8px',
              fontSize: '9px',
              letterSpacing: '.16em',
              color: 'var(--cy-text-muted)',
            }}
          >
            STUDIO — TIMELINE MIX
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              letterSpacing: '.14em',
              color: 'var(--cy-accent)',
            }}
          >
            {clock}
          </span>
        </div>

        <div style={{ position: 'relative', padding: '14px' }}>
          {/* Ruler. */}
          <div
            style={{
              display: 'flex',
              height: '18px',
              marginLeft: '84px',
              borderBottom: '1px solid var(--cy-border)',
            }}
          >
            {Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  borderLeft: i === 0 ? 'none' : '1px solid var(--cy-border)',
                  fontSize: '8px',
                  letterSpacing: '.1em',
                  color: 'var(--cy-text-muted)',
                  paddingLeft: '4px',
                }}
              >
                {`0:${String(i * 12).padStart(2, '0')}`}
              </div>
            ))}
          </div>

          <div style={{ border: '1px solid var(--cy-border)', borderTop: 'none' }}>
            {HERO_LANES.map((lane, i) => (
              <div
                key={lane.name}
                style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cy-border)' }}
              >
                <LaneRow lane={lane} waveform={waveforms[i] ?? []} />
              </div>
            ))}
          </div>

          {/* Playhead — `heroPlayhead` di design: 14px padding + sisa lebar. */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '14px',
              bottom: '14px',
              left: `calc(98px + (100% - 112px) * ${(p / 100).toFixed(3)})`,
              width: '1px',
              background: 'var(--cy-accent)',
              boxShadow: '0 0 8px #ffd40080',
              pointerEvents: 'none',
            }}
          />
        </div>
      </div>

      <div
        className="km-chip"
        style={{
          position: 'absolute',
          left: '-18px',
          bottom: '34px',
          border: '1px solid var(--cy-accent)',
          background: '#0b0904',
          padding: '9px 13px',
          boxShadow: '0 12px 30px #000000b3',
        }}
      >
        <div style={{ fontSize: '9px', letterSpacing: '.18em', color: 'var(--cy-text-muted)' }}>
          COMPILE OUT
        </div>
        <div
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '18px',
            fontWeight: 700,
            color: 'var(--cy-accent)',
            lineHeight: 1.2,
          }}
        >
          03:34 WAV
        </div>
      </div>
    </div>
  );
}
