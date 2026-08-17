/**
 * Readout strip — 5 sel angka di bawah header. Label kecil uppercase, nilai
 * besar ber-font sans, satuan kecil di kanan nilai. Warna per design.
 *
 * Sel COMPILE OUT membaca `contentEnd` dan `renderSpeed`, BUKAN `duration`.
 * `duration` adalah panjang kanvas timeline: ia selalu menyisakan ekor 30 detik
 * dan tidak pernah turun di bawah 2 menit, jadi memakainya di sini akan
 * menjanjikan file yang jauh lebih panjang dari yang benar-benar ditulis —
 * project kosong pun terbaca "02:00". Rumusnya dipinjam dari `RenderSpeedCard`
 * (`outputSeconds`), yang juga dipakai kartu Compile dan `buildExportPayload`;
 * angka yang sama tidak boleh punya tiga rumus.
 */

import { formatTime, samplesToSec, PITCH_LOCK_AVAILABLE } from '../model';
import { outputSeconds, semitoneShift } from '../rail/RenderSpeedCard';
import { selectClipCount, useStudio } from '../store';

interface Cell {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly color: string;
  /** Baris mikro di bawah nilai. Hanya diisi kalau ada yang perlu dikatakan. */
  readonly note?: string;
  readonly title?: string;
}

/** Kecepatan pemutaran yang membuat file terdengar seperti materi aslinya.
 *  Varispeed: di-render `renderSpeed` kali lebih cepat, jadi dikembalikan
 *  dengan kebalikannya. */
export function playbackFactor(renderSpeed: number): number {
  return renderSpeed > 0 ? 1 / renderSpeed : 1;
}

const formatSpeed = (v: number): string => `${v.toFixed(2)}×`;

/** Sama persis dengan `formatSemitones` di `RenderSpeedCard`. Disalin, bukan
 *  di-import, karena helper itu tidak diekspor dan file-nya bukan milik kita —
 *  tes di bawah yang menjaga keduanya tetap berbunyi sama. */
const formatSemitones = (st: number): string =>
  `${st > 0 ? '+' : st < 0 ? '−' : ''}${Math.abs(st).toFixed(1)} st`;

export function ReadoutStrip(): JSX.Element {
  const sampleRate = useStudio((s) => s.sampleRate);
  const duration = useStudio((s) => s.duration);
  const contentEnd = useStudio((s) => s.contentEnd);
  const renderSpeed = useStudio((s) => s.renderSpeed);
  const playhead = useStudio((s) => s.playhead);
  const laneCount = useStudio((s) => s.lanes.length);
  const clipCount = useStudio(selectClipCount);

  const totalSec = samplesToSec(duration, sampleRate);
  const hasMaterial = contentEnd > 0 && sampleRate > 0;
  const outSec = outputSeconds(contentEnd, sampleRate, renderSpeed);
  const st = semitoneShift(renderSpeed);
  // 1× tidak butuh keterangan apa-apa: file-nya memang materi apa adanya.
  const varispeed = !PITCH_LOCK_AVAILABLE && renderSpeed !== 1;

  const compile: Cell = hasMaterial
    ? {
        label: 'Compile out',
        value: formatTime(outSec),
        unit: 'wav',
        color: 'var(--cy-accent-alt)',
        note: varispeed
          ? `PUTAR ${formatSpeed(playbackFactor(renderSpeed))} · ${formatSemitones(st)}`
          : undefined,
        title: varispeed
          ? `Varispeed: file di-render ${formatSpeed(renderSpeed)} lebih cepat, jadi pitch hasil bergeser ${formatSemitones(st)}. Terdengar seperti materi aslinya hanya kalau diputar ${formatSpeed(playbackFactor(renderSpeed))}.`
          : undefined,
      }
    : {
        // "00:00" akan terbaca sebagai file kosong yang sah. Yang benar adalah
        // tidak ada file sama sekali — kata-katanya sama dengan kartu Render Speed.
        label: 'Compile out',
        value: '—',
        unit: '',
        color: 'var(--cy-accent-alt)',
        note: 'BELUM ADA MATERI',
        title: 'Belum ada clip yang bisa di-render, jadi belum ada file hasil.',
      };

  const cells: Cell[] = [
    { label: 'Timeline', value: formatTime(totalSec), unit: '', color: 'var(--cy-text)' },
    {
      label: 'Playhead',
      value: formatTime(samplesToSec(playhead, sampleRate)),
      unit: '',
      color: 'var(--cy-accent)',
    },
    { label: 'Lanes', value: String(laneCount), unit: 'ch', color: 'var(--cy-text)' },
    { label: 'Clips', value: String(clipCount), unit: '', color: 'var(--cy-text)' },
    compile,
  ];

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--cy-border)', background: '#000' }}>
      {cells.map((c) => (
        <div
          key={c.label}
          title={c.title}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '9px 16px',
            borderRight: '1px solid var(--cy-border)',
          }}
        >
          <div
            style={{
              fontSize: '9px',
              letterSpacing: '.2em',
              color: 'var(--cy-text-muted)',
              textTransform: 'uppercase',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '19px',
              fontWeight: 600,
              color: c.color,
              marginTop: '2px',
            }}
          >
            {c.value}
            <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)', marginLeft: '4px' }}>
              {c.unit}
            </span>
          </div>
          {c.note === undefined ? null : (
            <div
              style={{
                fontSize: '9px',
                letterSpacing: '.12em',
                color: 'var(--cy-text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.note}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
