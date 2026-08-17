/**
 * Step Sequencer — `span 5` di design, dengan `glow`.
 *
 * ┌─ SHELL PRESENTASIONAL, FASE 3 ────────────────────────────────────────────┐
 * │ TODO(phase-3): sel bisa di-toggle dan state-nya lokal, tapi TIDAK ADA     │
 * │ yang dikirim ke engine. Prasyaratnya sama dengan Piano Roll (docs/08      │
 * │ §Piano Roll & Step Sequencer — DITUNDA): clip MIDI di model, opcode       │
 * │ NoteOn/NoteOff di command ring, instrumen + voice allocator polifonik.    │
 * │ Kolom "step yang sedang main" juga menunggu itu — playhead audio tidak    │
 * │ tahu apa-apa tentang step selama tidak ada sequencer di engine.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Layout disalin persis: 5 baris pad, label 64px, 16 sel `height:22px` dengan
 * gap 3px, warna sel = warna pad saat aktif dan #0b0b0b saat mati, lalu baris
 * angka 1/5/9/13 di bawah.
 */

import { useState } from 'react';
import { Card } from '../cyber';

/** Disalin dari `padData()` di design. */
const PADS = [
  { id: 'kick', name: 'KICK', color: '#ffd400', def: [0, 4, 8, 10, 14] },
  { id: 'snare', name: 'SNARE', color: '#ffb020', def: [4, 12] },
  { id: 'hat', name: 'HAT', color: '#6ee7ff', def: [2, 6, 10, 14] },
  { id: 'clap', name: 'CLAP', color: '#ff7ad9', def: [7, 15] },
  { id: 'perc', name: 'PERC', color: '#a78bfa', def: [3, 11] },
] as const;

export function StepSequencer(): JSX.Element {
  const [steps, setSteps] = useState<Record<string, boolean>>({});

  const isOn = (padId: string, i: number, def: readonly number[]): boolean =>
    steps[`${padId}:${i}`] ?? def.includes(i);

  return (
    <Card title="Step Sequencer" subtitle="click cells to program · 16 steps" notched glow>
      <div style={{ display: 'grid', gap: '8px' }}>
        {PADS.map((pad) => (
          <div
            key={pad.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '64px minmax(0,1fr)',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            <div style={{ fontSize: '10px', letterSpacing: '.14em', color: 'var(--cy-text-dim)' }}>
              {pad.name}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(16,minmax(0,1fr))', gap: '3px' }}>
              {Array.from({ length: 16 }, (_, i) => {
                const on = isOn(pad.id, i, pad.def);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`${pad.name} step ${i + 1}`}
                    aria-pressed={on}
                    className="cy-btn-reset cy-focusable cy-hover-step"
                    onClick={() =>
                      setSteps((prev) => ({ ...prev, [`${pad.id}:${i}`]: !on }))
                    }
                    style={{
                      height: '22px',
                      background: on ? pad.color : '#0b0b0b',
                      border: `1px solid ${on ? pad.color : 'var(--cy-border)'}`,
                      cursor: 'pointer',
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: '10px', marginTop: '2px' }}>
          <span />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(16,minmax(0,1fr))',
              gap: '3px',
              fontSize: '8px',
              color: 'var(--cy-text-muted)',
              textAlign: 'center',
            }}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i}>{i % 4 === 0 ? i + 1 : ''}</span>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
