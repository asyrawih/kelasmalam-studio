/**
 * Render Speed — kecepatan pemutaran yang dipakai SAAT COMPILE.
 *
 * Sengaja BUKAN `speed` (transport). Mempercepat pemutaran untuk mencari titik
 * edit tidak boleh diam-diam mengubah kecepatan file yang dikirim ke orang lain,
 * dan sebaliknya. Dua angka terpisah di store, dan jalur export hanya membaca
 * yang ini (`export/payload.ts`).
 *
 * Kartu ini menampilkan AKIBATNYA, bukan cuma angkanya: panjang materi ditulis
 * berdampingan dengan panjang hasil, dan pergeseran pitch ditulis apa adanya.
 */

import type { CSSProperties } from 'react';
import { Card } from '../../ui/cyber';
import {
  MAX_RENDER_SPEED,
  MIN_RENDER_SPEED,
  PITCH_LOCK_AVAILABLE,
  formatTime,
} from '../model';
import { studioActions, useStudio } from './store-adapter';
import { useDragFraction } from './useDragFraction';

// ── Pemetaan posisi slider ↔ kecepatan ───────────────────────────────────────

/**
 * PEMETAAN LOGARITMIK (eksponensial terhadap travel), bukan linear.
 *
 *   speed(f) = MIN × (MAX/MIN)^f,  f = travel 0..1
 *
 * Alasannya kecepatan itu dirasakan secara MULTIPLIKATIF: 0.5× → 1× adalah
 * perubahan yang sama besarnya dengan 1× → 2× (sama-sama faktor dua), jadi
 * jaraknya di slider harus sama juga. Dengan pemetaan linear, seluruh separuh
 * kiri slider (0.25×..1×) hanya memuat satu penggandaan sementara separuh kanan
 * memuat dua — pelan jadi mustahil diatur halus, cepat jadi terlalu sensitif.
 *
 * Efek samping yang kebetulan berguna: karena MIN×MAX = 0.25×4 = 1, titik netral
 * 1× jatuh TEPAT di tengah travel (f = 0.5). Detent-nya jadi tidak perlu dicari.
 *
 * Ini juga ruang yang sama dengan pitch: satu jarak tetap di slider = satu
 * interval tetap dalam semitone (rentang penuh = ±2 oktaf).
 */
const SPAN = MAX_RENDER_SPEED / MIN_RENDER_SPEED;

/** Travel tempat 1× berada. Dihitung, bukan ditulis 0.5, supaya tetap benar
 *  kalau batas rentang di model berubah. */
export const NEUTRAL_FRACTION = Math.log(1 / MIN_RENDER_SPEED) / Math.log(SPAN);

export function fractionToSpeed(fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : NEUTRAL_FRACTION;
  return MIN_RENDER_SPEED * Math.pow(SPAN, f);
}

export function speedToFraction(speed: number): number {
  const v = Number.isFinite(speed) ? Math.min(MAX_RENDER_SPEED, Math.max(MIN_RENDER_SPEED, speed)) : 1;
  return Math.log(v / MIN_RENDER_SPEED) / Math.log(SPAN);
}

/** Resolusi yang disimpan: 0.01×. Sama dengan yang terbaca di readout — angka
 *  yang ditampilkan dan angka yang di-render tidak boleh berbeda diam-diam. */
export function quantizeSpeed(speed: number): number {
  const v = Math.min(MAX_RENDER_SPEED, Math.max(MIN_RENDER_SPEED, speed));
  return Math.round(v * 100) / 100;
}

/**
 * Lebar magnet 1× dalam satuan TRAVEL (bukan kecepatan) — di ruang log, lebar
 * yang sama terasa sama di kedua sisi detent.
 */
const DETENT_TRAVEL = 0.015;

/**
 * Kecepatan dari posisi pointer. Hanya jalur DRAG yang kena detent: dengan
 * langkah keyboard 1% travel, magnet selebar 1.5% akan menarik nilainya kembali
 * ke 1× setiap kali tombol panah ditekan — slider-nya macet di netral.
 */
export function speedFromDrag(fraction: number): number {
  if (Math.abs(fraction - NEUTRAL_FRACTION) <= DETENT_TRAVEL) return 1;
  return quantizeSpeed(fractionToSpeed(fraction));
}

/** Geser sejauh `deltaTravel` dari kecepatan sekarang, tetap di ruang log. */
export function nudgeSpeed(current: number, deltaTravel: number): number {
  return quantizeSpeed(fractionToSpeed(speedToFraction(current) + deltaTravel));
}

// ── Akibat yang ditampilkan ──────────────────────────────────────────────────

/** Panjang file hasil (detik). Materi yang sama, diputar `renderSpeed` kali
 *  lebih cepat, jadi durasinya dibagi — bukan dikali. */
export function outputSeconds(contentEnd: number, sampleRate: number, renderSpeed: number): number {
  if (!(contentEnd > 0) || !(sampleRate > 0)) return 0;
  const speed = renderSpeed > 0 ? renderSpeed : 1;
  return contentEnd / sampleRate / speed;
}

/** Pergeseran pitch dalam semitone. Varispeed = rasio kecepatan langsung jadi
 *  rasio frekuensi, jadi 12·log2(speed) — persis seperti tape. */
export function semitoneShift(renderSpeed: number): number {
  const v = renderSpeed > 0 ? renderSpeed : 1;
  return 12 * Math.log2(v);
}

const formatSpeed = (v: number): string => `${v.toFixed(2)}×`;

const formatSemitones = (st: number): string =>
  `${st > 0 ? '+' : st < 0 ? '−' : ''}${Math.abs(st).toFixed(1)} st`;

// ── Tampilan ─────────────────────────────────────────────────────────────────

/** Preset yang diminta design. Nilai ini dipakai APA ADANYA (bukan lewat
 *  pemetaan travel) supaya 1× benar-benar 1, bukan 0.999… hasil pembulatan. */
export const RENDER_SPEED_PRESETS = [0.5, 0.75, 1, 1.5, 2] as const;

/**
 * Sama seperti `TransportCard`: selama `PITCH_LOCK_AVAILABLE` masih false,
 * label TIDAK boleh menyiratkan pitch dipertahankan. Yang terjadi di export
 * adalah varispeed — pitch ikut bergeser seperti tape. Label kembali ke janji
 * design begitu time-stretch benar-benar ada.
 */
const HEAD_LABEL = PITCH_LOCK_AVAILABLE ? 'RENDER SPEED · PITCH LOCKED' : 'RENDER SPEED · VARISPEED';
const HEAD_TITLE = PITCH_LOCK_AVAILABLE
  ? 'Pitch file hasil dipertahankan saat kecepatan render berubah.'
  : 'Varispeed: pitch file hasil ikut berubah mengikuti kecepatan render, persis seperti tape. Time-stretch yang mempertahankan pitch belum ada.';

const MICRO_LABEL: CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.16em',
  color: 'var(--cy-text-muted)',
};

const PRESET_BTN: CSSProperties = {
  height: '26px',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '10px',
  cursor: 'pointer',
};

export function RenderSpeedCard(): JSX.Element {
  const renderSpeed = useStudio((s) => s.renderSpeed);
  const contentEnd = useStudio((s) => s.contentEnd);
  const sampleRate = useStudio((s) => s.sampleRate);

  const setSpeed = (v: number): void => studioActions.setRenderSpeed(v);
  const drag = useDragFraction((f) => setSpeed(speedFromDrag(f)));

  const travel = speedToFraction(renderSpeed);
  const sourceSec = contentEnd > 0 && sampleRate > 0 ? contentEnd / sampleRate : 0;
  const outSec = outputSeconds(contentEnd, sampleRate, renderSpeed);
  const st = semitoneShift(renderSpeed);
  const hasMaterial = sourceSec > 0;

  return (
    <Card title="Render Speed" subtitle="kecepatan saat compile" notched>
      <div style={{ display: 'grid', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span title={HEAD_TITLE} style={MICRO_LABEL}>
            {HEAD_LABEL}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--cy-accent)',
            }}
          >
            {formatSpeed(renderSpeed)}
          </span>
        </div>

        <div
          {...drag}
          role="slider"
          tabIndex={0}
          aria-label="Kecepatan render"
          aria-valuemin={MIN_RENDER_SPEED}
          aria-valuemax={MAX_RENDER_SPEED}
          aria-valuenow={renderSpeed}
          aria-valuetext={formatSpeed(renderSpeed)}
          title="Seret untuk mengubah. Panah = langkah halus, klik dua kali = kembali ke 1×."
          onDoubleClick={() => setSpeed(1)}
          onKeyDown={(e) => {
            // Langkah dalam TRAVEL, bukan dalam kecepatan: satu tekan = rasio
            // yang sama di mana pun posisinya, sesuai pemetaan log di atas.
            const step = e.shiftKey ? 0.05 : 0.01;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              setSpeed(nudgeSpeed(renderSpeed, -step));
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSpeed(nudgeSpeed(renderSpeed, step));
            } else if (e.key === 'Home') {
              e.preventDefault();
              setSpeed(MIN_RENDER_SPEED);
            } else if (e.key === 'End') {
              e.preventDefault();
              setSpeed(MAX_RENDER_SPEED);
            }
          }}
          style={{
            height: '24px',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              height: '4px',
              width: '100%',
              background: '#000',
              border: '1px solid var(--cy-border)',
            }}
          />
          {/* Tick preset — sekadar orientasi, tidak bisa diklik (targetnya
              terlalu kecil; tombol preset di bawah yang mengerjakannya). */}
          {RENDER_SPEED_PRESETS.filter((v) => v !== 1).map((v) => (
            <div
              key={v}
              style={{
                position: 'absolute',
                left: `${speedToFraction(v) * 100}%`,
                top: '6px',
                bottom: '6px',
                width: '1px',
                background: 'var(--cy-border-strong)',
              }}
            />
          ))}
          {/* Detent 1×: dibuat lebih tinggi dan beraksen supaya netral bisa
              ditemukan tanpa membaca angkanya. */}
          <div
            style={{
              position: 'absolute',
              left: `${NEUTRAL_FRACTION * 100}%`,
              top: '1px',
              bottom: '1px',
              width: '1px',
              marginLeft: '-0.5px',
              background: 'var(--cy-accent)',
              opacity: 0.65,
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: `${Math.min(100, Math.max(0, travel * 100))}%`,
              width: '12px',
              height: '18px',
              marginLeft: '-6px',
              background: 'var(--cy-accent)',
            }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: '4px' }}>
          {RENDER_SPEED_PRESETS.map((v) => {
            const active = renderSpeed === v;
            return (
              <button
                key={v}
                type="button"
                className="cy-btn-reset cy-hover-accent-border"
                aria-pressed={active}
                onClick={() => setSpeed(v)}
                style={{
                  ...PRESET_BTN,
                  background: active ? 'var(--cy-accent)' : 'transparent',
                  color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                }}
              >
                {v}×
              </button>
            );
          })}
        </div>

        {/* Akibatnya, bukan cuma angkanya: berapa panjang file yang keluar. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderTop: '1px solid var(--cy-border)',
            paddingTop: '10px',
          }}
        >
          <span style={MICRO_LABEL}>DURASI HASIL</span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '11px',
            }}
          >
            {hasMaterial ? (
              <>
                <span aria-label="Panjang materi" style={{ color: 'var(--cy-text-muted)' }}>
                  {formatTime(sourceSec)}
                </span>
                <span style={{ color: 'var(--cy-text-muted)' }}> → </span>
                <span aria-label="Panjang file hasil" style={{ color: 'var(--cy-accent)' }}>
                  {formatTime(outSec)}
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--cy-text-muted)' }}>BELUM ADA MATERI</span>
            )}
          </span>
        </div>

        {/* Pitch ditulis apa adanya. Diam soal ini = membiarkan user mengira
            2× cuma "lebih cepat", padahal hasilnya naik satu oktaf penuh. */}
        <div title={HEAD_TITLE} style={MICRO_LABEL}>
          {PITCH_LOCK_AVAILABLE
            ? 'PITCH DIPERTAHANKAN'
            : renderSpeed === 1
              ? 'VARISPEED · PITCH IKUT BERGESER DI SELAIN 1×'
              : `VARISPEED · PITCH HASIL BERGESER ${formatSemitones(st)}`}
        </div>
      </div>
    </Card>
  );
}
