/**
 * Equalizer parametrik 4 band — node yang bisa di-drag di atas kurva respons.
 *
 * Menggantikan tiga slider LOW/MID/HIGH. Alasannya bukan estetika: dengan
 * slider, frekuensi terkunci dan user tidak pernah melihat apa yang sebenarnya
 * terjadi pada spektrum. Di sini kurvanya adalah |H(e^jω)| SUNGGUHAN dari
 * koefisien biquad yang sama dengan yang dipasang ke `BiquadFilterNode`, jadi
 * yang digambar = yang terdengar, termasuk interaksi antar band.
 *
 * Yang TIDAK ada di sini: spectrum analyzer. Versi lama menggambar 48 bar dari
 * rumus statis — visual yang berpura-pura menampilkan audio padahal tidak
 * membaca data apa pun. Bar-nya baru boleh kembali kalau ada AnalyserNode asli.
 *
 * EQ berlaku untuk LANE TERPILIH; tanpa lane terpilih semuanya di-disable
 * (bukan diam-diam mengedit "sesuatu" yang tidak ada).
 */

import { useMemo, useRef, useState } from 'react';
import { Card } from '../../ui/cyber';
import { studioActions, useStudio } from '../store';
import { EqSliders } from './EqSlidersCard';
import { useCanvasDraw } from '../../ui/lib/canvas';
import { useDrag } from '../../ui/lib/drag';
import {
  EQ_PRESETS,
  defaultEq,
  type EqBand,
  type EqBandId,
  type EqPreset,
} from '../model';
import {
  clampHz,
  coeffs,
  dbToY,
  formatHz,
  hitTestBand,
  logX,
  totalDb,
  xToHz,
  yToDb,
  type Coeffs,
} from './eq-curve';
import { applyEqPreset, setEqBand, usePreset, useSampleRate, useSelectedLane } from './store-adapter';

const CANVAS_H = 160;
const PRESETS = Object.keys(EQ_PRESETS) as EqPreset[];
const AXIS_LABELS = ['30 Hz', '200', '1 k', '5 k', '18 kHz'];

/** Dipakai saat tidak ada lane terpilih: kurva rata, node di posisi default. */
const FLAT_BANDS = defaultEq().bands;

const fmtDb = (db: number): string => `${db > 0 ? '+' : ''}${db.toFixed(1)}`;

export function EqCurveCard(): JSX.Element {
  const preset = usePreset();
  const lane = useSelectedLane();
  const sampleRate = useSampleRate();
  const disabled = lane === null;
  const bands: readonly EqBand[] = lane?.eq.bands ?? FLAT_BANDS;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragIndex = useRef(-1);
  const [selectedBand, setSelectedBand] = useState<EqBandId>('low');
  const eqMode = useStudio((st) => st.eqMode);

  const curves: readonly Coeffs[] = useMemo(
    () => bands.map((b) => coeffs(b, sampleRate)),
    [bands, sampleRate],
  );

  const readout = bands.find((b) => b.id === selectedBand) ?? bands[0];

  useCanvasDraw(
    canvasRef,
    (ctx, size) => {
      const { width, height } = size;
      if (width <= 0 || height <= 0) return;

      // Grid: 25px × 32px seperti design, plus garis 0 dB yang lebih terang
      // supaya arah boost/cut terbaca tanpa label.
      ctx.fillStyle = '#161616';
      for (let x = 24; x < width; x += 25) ctx.fillRect(x, 0, 1, height);
      for (let y = 31; y < height; y += 32) ctx.fillRect(0, y, width, 1);
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(0, Math.round(height / 2), width, 1);

      // Kurva gabungan: kaskade filter = jumlah dB tiap band.
      ctx.beginPath();
      for (let px = 0; px <= width; px++) {
        const y = dbToY(totalDb(curves, xToHz(px / width), sampleRate), height);
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffd400aa';
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Satu node per band, di warna band-nya.
      for (const b of bands) {
        const x = logX(b.freq) * width;
        const y = dbToY(b.gainDb, height);
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        // Cincin penanda band yang sedang dibaca angkanya di bawah canvas.
        if (b.id === selectedBand && !disabled) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    },
    [bands, curves, sampleRate, selectedBand, disabled],
  );

  const drag = useDrag<void>({
    onStart: (c) => {
      if (disabled) return;
      // rect 0×0 (belum di-layout) akan membuat semua konversi jadi NaN.
      if (c.rect.width <= 0 || c.rect.height <= 0) return;
      const i = hitTestBand(bands, c.x, c.y, c.rect.width, c.rect.height);
      dragIndex.current = i;
      const band = bands[i];
      if (band !== undefined) setSelectedBand(band.id);
    },
    onMove: (c) => {
      const band = bands[dragIndex.current];
      if (lane === null || band === undefined) return;
      if (c.rect.width <= 0 || c.rect.height <= 0) return;
      // Vertikal = gain, mendatar = frekuensi (skala log). Clamp terakhirnya
      // ada di store — di sini hanya supaya angka readout langsung masuk akal.
      setEqBand(lane.id, band.id, {
        freq: clampHz(xToHz(c.x / c.rect.width)),
        gainDb: yToDb(c.y, c.rect.height),
      });
    },
    onEnd: () => {
      dragIndex.current = -1;
    },
  });

  /** Double-click node = kembalikan band itu ke 0 dB. Cara tercepat keluar dari
   *  setelan yang terlanjur ekstrem tanpa harus membidik garis tengah. */
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (lane === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const i = hitTestBand(bands, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    const band = bands[i];
    if (band === undefined) return;
    setEqBand(lane.id, band.id, { gainDb: 0 });
  };

  return (
    <Card title="Equalizer" subtitle="berlaku untuk lane terpilih" notched>
      <div style={{ display: 'grid', gap: '10px' }}>
        {/* Design tidak menampilkan nama lane; ditambahkan karena tanpa itu user
            tidak tahu lane mana yang sedang diubah. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '9px', letterSpacing: '.14em' }}>
          <span style={{ color: 'var(--cy-text-muted)' }}>LANE</span>
          <span
            style={{
              color: lane ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {lane ? lane.name : 'TIDAK ADA LANE TERPILIH'}
          </span>

          {/* Pilihan tampilan. Keduanya mengedit data yang sama — pindah mode
              tidak pernah mengubah suara, cuma apa yang bisa diatur. */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '3px' }} role="group" aria-label="Mode EQ">
            {(['curve', 'sliders'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={eqMode === m}
                onClick={() => studioActions.setEqMode(m)}
                title={
                  m === 'curve'
                    ? 'Kurva: geser node — gain (vertikal) dan frekuensi (mendatar)'
                    : 'Slider: gain saja, frekuensi tetap'
                }
                style={{
                  height: '20px',
                  padding: '0 8px',
                  border: `1px solid ${eqMode === m ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
                  background: eqMode === m ? 'var(--cy-accent)' : 'transparent',
                  color: eqMode === m ? 'var(--cy-text-on-accent)' : 'var(--cy-text-muted)',
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '9px',
                  letterSpacing: '.12em',
                  cursor: 'pointer',
                }}
              >
                {m === 'curve' ? 'CURVE' : 'SLIDER'}
              </button>
            ))}
          </div>
        </div>

        {eqMode === 'sliders' ? (
          <EqSliders
            bands={bands}
            disabled={disabled}
            onChange={(bandId, gainDb) => {
              if (lane) setEqBand(lane.id, bandId, { gainDb });
            }}
          />
        ) : (
        <div
          {...drag}
          onDoubleClick={onDoubleClick}
          aria-label="Kurva EQ parametrik"
          style={{
            position: 'relative',
            height: `${CANVAS_H}px`,
            background: '#000',
            border: '1px solid var(--cy-border)',
            overflow: 'hidden',
            touchAction: 'none',
            cursor: disabled ? 'not-allowed' : 'crosshair',
            opacity: disabled ? 0.4 : 1,
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: 'var(--cy-text-muted)',
            letterSpacing: '.12em',
          }}
        >
          {AXIS_LABELS.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>

        {/* Readout band terpilih — angka pastinya tidak bisa dibaca dari kurva. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '10px',
            letterSpacing: '.12em',
            opacity: disabled ? 0.4 : 1,
          }}
        >
          {bands.map((b) => (
            <button
              key={b.id}
              type="button"
              className="cy-btn-reset"
              disabled={disabled}
              aria-pressed={b.id === selectedBand}
              title={`Tampilkan angka band ${b.label}`}
              onClick={() => setSelectedBand(b.id)}
              style={{
                color: b.id === selectedBand ? b.color : 'var(--cy-text-muted)',
                borderBottom: `1px solid ${b.id === selectedBand ? b.color : 'transparent'}`,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--cy-font-mono)',
                fontSize: '9px',
              }}
            >
              {b.label}
            </button>
          ))}
          {readout !== undefined ? (
            <span style={{ marginLeft: 'auto', color: 'var(--cy-accent)', fontFamily: 'var(--cy-font-sans)', fontSize: '13px', fontWeight: 600 }}>
              {formatHz(readout.freq)} · {fmtDb(readout.gainDb)} dB
            </span>
          ) : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '4px' }}>
          {PRESETS.map((p) => {
            const active = preset === p;
            return (
              <button
                key={p}
                type="button"
                className="cy-btn-reset cy-hover-accent-border"
                disabled={disabled}
                aria-pressed={active}
                title={disabled ? 'Pilih lane dulu' : `Terapkan preset ${p} ke lane terpilih`}
                onClick={() => applyEqPreset(p)}
                style={{
                  height: '28px',
                  border: '1px solid var(--cy-border)',
                  background: active ? 'var(--cy-accent)' : 'transparent',
                  color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '9px',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
