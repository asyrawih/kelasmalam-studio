/**
 * Piano Roll — `span 7` di design.
 *
 * ┌─ SHELL PRESENTASIONAL, FASE 2/3 ──────────────────────────────────────────┐
 * │ TODO(phase-3): panel ini tidak terhubung ke apa pun, dan itu disengaja.   │
 * │ Prasyaratnya (docs/08 §Piano Roll & Step Sequencer — DITUNDA):            │
 * │   1. Clip bertipe MIDI di `daw-timeline` — sekarang model hanya punya     │
 * │      clip audio (`Clip { assetId, sourceStart, … }`).                     │
 * │   2. Event MIDI di command ring (`NoteOn/NoteOff` belum punya opcode di   │
 * │      `audio/sab-layout.ts`).                                             │
 * │   3. Instrumen sintesis + voice allocator polifonik di engine.            │
 * │ Selama tiga hal itu belum ada, note di bawah adalah data statis dari      │
 * │ design. Menampilkannya sebagai shell — bukan menyembunyikannya — adalah   │
 * │ pilihan sadar: design menampilkannya, dan menghapusnya membuat            │
 * │ implementasi tidak match dengan design file.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Semua ukuran disalin persis: kolom keyboard 56px, baris 18px, area note
 * 216px dengan background dua lapis (garis baris 17/18px + grid vertikal
 * 6.25%), note tinggi 16px dengan opacity dari velocity dan glow #ffd40066.
 */

import { Button, Card } from '../cyber';

const KEYS = ['B4', 'A#4', 'A4', 'G#4', 'G4', 'F#4', 'F4', 'E4', 'D#4', 'D4', 'C#4', 'C4'] as const;

/** Disalin dari `notes` di design (row, l%, w%, velocity). */
const NOTES = [
  { id: 'n1', row: 11, l: 0, w: 12, v: 0.9 },
  { id: 'n2', row: 8, l: 12, w: 8, v: 0.7 },
  { id: 'n3', row: 6, l: 20, w: 16, v: 1 },
  { id: 'n4', row: 3, l: 36, w: 8, v: 0.6 },
  { id: 'n5', row: 11, l: 44, w: 12, v: 0.85 },
  { id: 'n6', row: 9, l: 56, w: 6, v: 0.5 },
  { id: 'n7', row: 6, l: 62, w: 14, v: 0.95 },
  { id: 'n8', row: 1, l: 76, w: 20, v: 0.8 },
] as const;

export function PianoRoll(): JSX.Element {
  return (
    <Card title="Piano Roll" subtitle="808 BASS · velocity shading" notched>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '56px minmax(0,1fr)',
          border: '1px solid var(--cy-border)',
          background: '#000',
        }}
      >
        <div>
          {KEYS.map((name) => {
            const black = name.includes('#');
            return (
              <div
                key={name}
                style={{
                  height: '18px',
                  borderBottom: '1px solid var(--cy-border)',
                  background: black ? '#0a0a0a' : '#141414',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: '6px',
                  fontSize: '8px',
                  letterSpacing: '.08em',
                  color: black ? 'var(--cy-text-muted)' : 'var(--cy-text-dim)',
                }}
              >
                {name}
              </div>
            );
          })}
        </div>
        <div
          style={{
            position: 'relative',
            height: '216px',
            background:
              'repeating-linear-gradient(0deg,#0a0a0a,#0a0a0a 17px,#161616 18px),repeating-linear-gradient(90deg,transparent,transparent calc(6.25% - 1px),var(--cy-grid-line) 6.25%)',
          }}
        >
          {NOTES.map((n) => (
            <div
              key={n.id}
              style={{
                position: 'absolute',
                left: `${n.l}%`,
                width: `${n.w}%`,
                top: `${n.row * 18}px`,
                height: '16px',
                background: '#ffd400',
                opacity: 0.35 + 0.65 * n.v,
                border: '1px solid #050505',
                boxShadow: '0 0 8px #ffd40066',
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center' }}>
        <Button size="sm" variant="outline" disabled title="Fase 3 — belum ada model MIDI.">
          DRAW
        </Button>
        <Button size="sm" variant="ghost" disabled title="Fase 3 — belum ada model MIDI.">
          QUANTIZE 1/16
        </Button>
        <Button size="sm" variant="ghost" disabled title="Fase 3 — belum ada model MIDI.">
          LEGATO
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--cy-text-dim)' }}>
          8 notes · scale lock F min
        </span>
      </div>
    </Card>
  );
}
