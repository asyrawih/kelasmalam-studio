/**
 * Plugin Knobs — `span 5` di design, di bawah Parametric EQ.
 *
 * Knob 62px: gradien radial `circle at 50% 30%, #1e1e1e, #050505 70%`, cincin
 * dashed di inset -5px, jarum 2×22px dengan glow, label 10px letterspacing
 * .16em, nilai persen berwarna aksen. Rotasi `val * 2.7 - 135` (yaitu
 * -135°…+135°) persis seperti design.
 *
 * Interaksi (docs/08 §Plugin Knobs): drag vertikal dengan pointer capture,
 * Shift = fine mode ÷10, double-click = reset ke default. Selama drag nilainya
 * ditulis ke param block; satu command di pointerup.
 */

import { useRef, useState } from 'react';
import { Card } from '../cyber';
import { DESIGN_KNOB_LABELS, useEngineCommands, useUiStore, type FxSlot } from '../../state';
import { useDrag } from '../lib/drag';

const DEFAULTS = [0.62, 0.38, 0.8, 0.45];

function Knob({
  label,
  value,
  onLive,
  onCommit,
  onReset,
}: {
  readonly label: string;
  readonly value: number;
  readonly onLive: (v: number) => void;
  readonly onCommit: (v: number) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const needleRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLDivElement>(null);

  const paint = (v: number): void => {
    const needle = needleRef.current;
    if (needle !== null) needle.style.transform = `rotate(${v * 270 - 135}deg)`;
    const pct = pctRef.current;
    if (pct !== null) pct.textContent = `${Math.round(v * 100)}%`;
  };

  const drag = useDrag<number>({
    onStart: () => value,
    onMove: (ctx, start) => {
      const v = Math.max(0, Math.min(1, start + (-ctx.dy / 150) * (ctx.shiftKey ? 0.1 : 1)));
      // Tulis langsung ke DOM: knob bergerak halus tanpa render React.
      paint(v);
      onLive(v);
    },
    onEnd: (ctx, start) => {
      onCommit(Math.max(0, Math.min(1, start + (-ctx.dy / 150) * (ctx.shiftKey ? 0.1 : 1))));
    },
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      <div
        {...drag}
        onDoubleClick={onReset}
        role="slider"
        aria-label={label}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        className="cy-focusable"
        style={{
          width: '62px',
          height: '62px',
          borderRadius: '50%',
          border: '1px solid var(--cy-border-strong)',
          background: 'radial-gradient(circle at 50% 30%,#1e1e1e,#050505 70%)',
          position: 'relative',
          filter: 'var(--cy-glow-filter-soft)',
          cursor: 'ns-resize',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '-5px',
            borderRadius: '50%',
            border: '1px dashed var(--cy-border)',
          }}
        />
        <div
          ref={needleRef}
          style={{
            position: 'absolute',
            left: '50%',
            top: '6px',
            width: '2px',
            height: '22px',
            background: 'var(--cy-accent)',
            transformOrigin: '50% 25px',
            transform: `rotate(${value * 270 - 135}deg)`,
            marginLeft: '-1px',
            boxShadow: '0 0 6px #ffd400',
          }}
        />
      </div>
      <div style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-dim)' }}>{label}</div>
      <div
        ref={pctRef}
        style={{ fontSize: '11px', color: 'var(--cy-accent)', fontVariantNumeric: 'tabular-nums' }}
      >
        {Math.round(value * 100)}%
      </div>
    </div>
  );
}

function KnobBank({ fx }: { readonly fx: FxSlot | undefined }): JSX.Element {
  const cmd = useEngineCommands();
  const [values, setValues] = useState<readonly number[]>(fx?.params ?? DEFAULTS);

  const paramSlot = (i: number): number => (fx?.paramBase ?? 512) + i;

  return (
      <div style={{ display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
        {DESIGN_KNOB_LABELS.map((label, i) => (
          <Knob
            key={label}
            label={label}
            value={values[i] ?? DEFAULTS[i]!}
            onLive={(v) => cmd.setFxParamLive(paramSlot(i), v)}
            onCommit={(v) => {
              cmd.setFxParamLive(paramSlot(i), v);
              setValues((prev) => prev.map((p, k) => (k === i ? v : p)));
            }}
            onReset={() => {
              cmd.setFxParamLive(paramSlot(i), DEFAULTS[i]!);
              setValues((prev) => prev.map((p, k) => (k === i ? DEFAULTS[i]! : p)));
            }}
          />
        ))}
      </div>
  );
}

export function PluginKnobs(): JSX.Element {
  const focusedTrackId = useUiStore((s) => s.focusedTrackId);
  const tracks = useUiStore((s) => s.project.tracks);
  const track = tracks.find((t) => t.id === focusedTrackId) ?? tracks[0];
  const fx = track?.insertChain[0];

  return (
    <Card title="Plugin Knobs" subtitle={fx?.kind.toLowerCase() ?? 'rotary controls'} notched>
      {/* `key` per efek: nilai knob adalah state lokal (belum ada opcode untuk
          membacanya balik dari engine). Tanpa remount, memilih track lain akan
          menampilkan angka & sudut jarum milik track SEBELUMNYA sambil menulis
          ke param slot track yang baru. */}
      <KnobBank key={fx?.id ?? 'none'} fx={fx} />
    </Card>
  );
}
