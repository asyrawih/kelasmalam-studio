/**
 * Mixer / Channel Strips — `grid-column: span 7` di design.
 *
 * Setiap strip disalin persis: nama 11px letterspacing .14em, baris FX 8px
 * setinggi 20px, knob pan 44px bulat dengan gradien radial
 * `circle at 50% 32%, #1c1c1c, #000` dan jarum 2×16px, lalu blok fader
 * setinggi 170px berisi track fader 22px + meter 8px, label dB 10px aksen,
 * dan tombol M/S 22×20. Strip MASTER di ujung memakai border aksen dan
 * background #0f0d05 seperti di design.
 *
 * Dua hal yang membedakannya dari design (dan alasannya):
 *
 * 1. Meter tidak lewat React. Design menghitung `ch.lv` dari state; di sini
 *    setiap strip punya `<canvas>` 8px yang digambar dari rAF bersama
 *    (docs/08 §Ringkasan arus state). Satu perubahan level tidak me-render
 *    satu strip pun.
 * 2. Fader di-drag dengan pointer capture, dan design `onClick` dipertahankan
 *    sebagai kasus khusus drag berdelta nol (docs/08 §Mixer). Selama drag,
 *    nilai ditulis ke param block; SATU command dikirim di pointerup.
 */

import { memo, useRef } from 'react';
import { Card } from '../cyber';
import {
  MASTER_METER_INDEX,
  useEngineCommands,
  useMeterFrame,
  useUiStore,
  type Track,
} from '../../state';
import { dbToFader, faderToDb, formatDb, formatPan, linToDb } from '../../state/gain';
import { dbToNorm } from '../../state/useMeterFrame';
import { useDrag } from '../lib/drag';
import { ToggleCell } from './ArrangementTimeline';

const FADER_H = 170;
const CAP_H = 14;

/** Meter vertikal 8px — canvas, digambar dari rAF bersama. */
function StripMeter({
  meterIndex,
  channel,
}: {
  readonly meterIndex: number;
  readonly channel: 0 | 1;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  // Gradien di-cache per tinggi canvas. Membuatnya ulang tiap frame berarti
  // ~33 meter × 60 fps = ~2000 objek gradien per detik yang harus dikumpulkan
  // GC — persis jenis alokasi per-frame yang dilarang `useMeterFrame`.
  const grad = useRef<{ h: number; value: CanvasGradient } | null>(null);

  useMeterFrame((frame) => {
    const canvas = ref.current;
    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      // Mengubah `width`/`height` me-reset SELURUH state konteks (transform,
      // fillStyle) — gradien lama juga harus dibuang.
      grad.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const db = frame.displayDb[meterIndex * 2 + channel] ?? -100;
    const fill = dbToNorm(db) * h;
    if (grad.current === null || grad.current.h !== h) {
      // Gradien vertikal design: linear-gradient(to top,#ffd400,#ffb020 70%,#ff4d4d)
      const g = ctx.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, '#ffd400');
      g.addColorStop(0.7, '#ffb020');
      g.addColorStop(1, '#ff4d4d');
      grad.current = { h, value: g };
    }
    ctx.fillStyle = grad.current.value;
    ctx.fillRect(0, h - fill, w, fill);
  });

  return (
    <canvas
      ref={ref}
      style={{
        width: '8px',
        height: '100%',
        background: '#000',
        border: '1px solid var(--cy-border)',
        boxSizing: 'border-box',
      }}
    />
  );
}

const ChannelStrip = memo(function ChannelStrip({ track }: { readonly track: Track }): JSX.Element {
  const cmd = useEngineCommands();
  const travel = dbToFader(linToDb(track.gain));
  const capRef = useRef<HTMLDivElement>(null);

  /** Konversi posisi Y pointer → travel 0..1, sama seperti `ch.onTrack` di design. */
  const travelFromY = (y: number, height: number): number =>
    Math.max(0, Math.min(1, 1 - y / height));

  const faderDrag = useDrag<void>({
    onMove: (ctx) => {
      const t = travelFromY(ctx.y, ctx.rect.height);
      // Jalur cepat: param block, tanpa command, tanpa React state.
      cmd.setFaderLive(track.id, t);
      const cap = capRef.current;
      if (cap !== null) cap.style.top = `${(1 - t) * 100}%`;
    },
    onEnd: (ctx) => {
      // Satu command undoable per gerakan (docs/08 §8a).
      cmd.setFaderCommit(track.id, travelFromY(ctx.y, ctx.rect.height));
    },
  });

  const panDrag = useDrag<number>({
    onStart: () => track.pan,
    onMove: (ctx, start) => {
      // Drag vertikal; Shift = fine mode ÷10 (docs/08 §Plugin Knobs).
      const delta = (-ctx.dy / 120) * (ctx.shiftKey ? 0.1 : 1);
      cmd.setPanLive(track.id, Math.max(-1, Math.min(1, start + delta)));
    },
    onEnd: (ctx, start) => {
      const delta = (-ctx.dy / 120) * (ctx.shiftKey ? 0.1 : 1);
      cmd.setPanCommit(track.id, Math.max(-1, Math.min(1, start + delta)));
    },
  });

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        border: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
        padding: '10px 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '10px',
      }}
    >
      <div style={{ fontSize: '11px', letterSpacing: '.14em', color: 'var(--cy-text)', whiteSpace: 'nowrap' }}>
        {track.name}
      </div>
      <div
        style={{
          fontSize: '8px',
          letterSpacing: '.1em',
          color: 'var(--cy-text-muted)',
          height: '20px',
          textAlign: 'center',
          lineHeight: 1.3,
        }}
      >
        {track.fxSummary}
      </div>

      <div
        {...panDrag}
        role="slider"
        aria-label={`${track.name} pan`}
        aria-valuenow={Math.round(track.pan * 100)}
        aria-valuemin={-100}
        aria-valuemax={100}
        tabIndex={0}
        className="cy-focusable"
        style={{
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          border: '1px solid var(--cy-border-strong)',
          background: 'radial-gradient(circle at 50% 32%,#1c1c1c,#000)',
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
          cursor: 'ns-resize',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: '2px',
            height: '16px',
            background: 'var(--cy-accent)',
            top: '4px',
            transformOrigin: '50% 18px',
            // design: rotate(pan * 1.35deg) dengan pan dalam -100..100
            transform: `rotate(${track.pan * 135}deg)`,
          }}
        />
        <span style={{ fontSize: '8px', color: 'var(--cy-text-muted)', marginTop: '12px' }}>
          {formatPan(track.pan)}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch', height: `${FADER_H}px` }}>
        <div
          {...faderDrag}
          role="slider"
          aria-label={`${track.name} fader`}
          aria-valuenow={Math.round(travel * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          className="cy-focusable"
          style={{
            position: 'relative',
            width: '22px',
            background: '#000',
            border: '1px solid var(--cy-border)',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '6px',
              bottom: '6px',
              width: '2px',
              background: 'var(--cy-border-strong)',
              transform: 'translateX(-50%)',
            }}
          />
          <div
            ref={capRef}
            style={{
              position: 'absolute',
              left: '2px',
              right: '2px',
              top: `${(1 - travel) * 100}%`,
              height: `${CAP_H}px`,
              background: 'linear-gradient(#3a3a3a,#111)',
              border: '1px solid var(--cy-accent)',
              marginTop: `-${CAP_H / 2}px`,
              filter: 'var(--cy-glow-filter-soft)',
            }}
          />
        </div>
        <StripMeter meterIndex={track.id} channel={0} />
      </div>

      <div style={{ fontSize: '10px', color: 'var(--cy-accent)', fontVariantNumeric: 'tabular-nums' }}>
        {formatDb(faderToDb(travel))} dB
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <ToggleCell
          label="M"
          on={track.mute}
          onColor="#ff4d4d"
          width={22}
          onClick={() => cmd.setMute(track.id, !track.mute)}
        />
        <ToggleCell
          label="S"
          on={track.solo}
          onColor="var(--cy-accent)"
          width={22}
          onClick={() => cmd.setSolo(track.id, !track.solo)}
        />
      </div>
    </div>
  );
});

function MasterStrip(): JSX.Element {
  const cmd = useEngineCommands();
  const masterGain = useUiStore((s) => s.project.masterGain);
  const travel = dbToFader(linToDb(masterGain));
  const capRef = useRef<HTMLDivElement>(null);
  const dbRef = useRef<HTMLDivElement>(null);

  useMeterFrame((frame) => {
    const node = dbRef.current;
    if (node === null) return;
    const db = Math.max(
      frame.displayDb[MASTER_METER_INDEX * 2] ?? -100,
      frame.displayDb[MASTER_METER_INDEX * 2 + 1] ?? -100,
    );
    const text = `${formatDb(db)} dB`;
    if (node.textContent !== text) node.textContent = text;
  });

  const faderDrag = useDrag<void>({
    onMove: (ctx) => {
      const t = Math.max(0, Math.min(1, 1 - ctx.y / ctx.rect.height));
      cmd.setMasterFaderLive(t);
      const cap = capRef.current;
      if (cap !== null) cap.style.top = `${(1 - t) * 100}%`;
    },
    onEnd: (ctx) => cmd.setMasterFaderCommit(Math.max(0, Math.min(1, 1 - ctx.y / ctx.rect.height))),
  });

  return (
    <div
      style={{
        width: '78px',
        border: '1px solid var(--cy-accent)',
        background: '#0f0d05',
        padding: '10px 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '10px',
      }}
    >
      <div style={{ fontSize: '11px', letterSpacing: '.14em', color: 'var(--cy-accent)' }}>MASTER</div>
      <div style={{ fontSize: '8px', letterSpacing: '.1em', color: 'var(--cy-text-muted)', height: '20px' }}>
        LIMITER
      </div>
      <div
        style={{
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          border: '1px solid var(--cy-accent)',
          background: 'radial-gradient(circle at 50% 32%,#241f08,#000)',
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: '2px',
            height: '16px',
            background: 'var(--cy-accent)',
            top: '4px',
            transformOrigin: '50% 18px',
          }}
        />
        <span style={{ fontSize: '8px', color: 'var(--cy-text-muted)', marginTop: '12px' }}>C</span>
      </div>

      <div style={{ display: 'flex', gap: '6px', height: `${FADER_H}px` }}>
        <div
          {...faderDrag}
          role="slider"
          aria-label="Master fader"
          aria-valuenow={Math.round(travel * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          className="cy-focusable"
          style={{
            position: 'relative',
            width: '22px',
            background: '#000',
            border: '1px solid var(--cy-border-strong)',
            touchAction: 'none',
            cursor: 'pointer',
          }}
        >
          <div
            ref={capRef}
            style={{
              position: 'absolute',
              left: '2px',
              right: '2px',
              top: `${(1 - travel) * 100}%`,
              height: `${CAP_H}px`,
              background: 'var(--cy-accent)',
              marginTop: `-${CAP_H / 2}px`,
            }}
          />
        </div>
        <StripMeter meterIndex={MASTER_METER_INDEX} channel={0} />
        <StripMeter meterIndex={MASTER_METER_INDEX} channel={1} />
      </div>

      <div ref={dbRef} style={{ fontSize: '10px', color: 'var(--cy-accent)' }}>
        -inf dB
      </div>
      {/* docs/08 §Mixer: LUFS terintegrasi adalah fase 3 — tampilkan em dash. */}
      <div style={{ fontSize: '9px', color: 'var(--cy-text-muted)', letterSpacing: '.1em' }}>LUFS —</div>
    </div>
  );
}

export function MixerStrips(): JSX.Element {
  const tracks = useUiStore((s) => s.project.tracks);
  return (
    <Card title="Mixer / Channel Strips" subtitle="drag a fader to set level" notched>
      <div style={{ display: 'flex', gap: '10px', overflow: 'hidden' }}>
        {tracks.map((track) => (
          <ChannelStrip key={track.id} track={track} />
        ))}
        <MasterStrip />
      </div>
    </Card>
  );
}
