/**
 * EQ mode SLIDER — satu slider gain per band, frekuensi tidak diutak-atik.
 *
 * Ini BUKAN EQ kedua: ia membaca dan menulis `EqSettings` yang sama persis
 * dengan mode kurva. Bedanya cuma apa yang boleh diubah — di sini hanya gain,
 * jadi tidak mungkin tanpa sengaja menggeser frekuensi saat cuma ingin
 * menambah bass. Pindah mode tidak pernah mengubah suara.
 *
 * Frekuensi tiap band tetap ditampilkan (sebagai keterangan) supaya user tahu
 * slider ini sedang bekerja di mana — dan supaya perubahan frekuensi yang
 * dibuat di mode kurva tidak "hilang" tanpa jejak saat pindah ke sini.
 */

import { EQ_MAX_GAIN_DB, type EqBand, type EqBandId } from '../model';
import { useDragFraction } from './useDragFraction';

const RANGE_DB = EQ_MAX_GAIN_DB;

const fractionToDb = (f: number): number => {
  const db = (f * 2 - 1) * RANGE_DB;
  // Snap 0.5 dB — sama dengan mode kurva, supaya angkanya konsisten.
  return Math.round(db * 2) / 2;
};
const dbToFraction = (db: number): number => (db / RANGE_DB + 1) / 2;

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

function BandSlider({
  band,
  disabled,
  onChange,
}: {
  readonly band: EqBand;
  readonly disabled: boolean;
  readonly onChange: (db: number) => void;
}): JSX.Element {
  const drag = useDragFraction((f) => onChange(fractionToDb(f)), disabled);
  const left = Math.max(0, Math.min(100, dbToFraction(band.gainDb) * 100));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
        <span style={{ width: '3px', height: '11px', background: band.color }} />
        <span style={{ fontSize: '11px', letterSpacing: '.14em', color: 'var(--cy-text)' }}>
          {band.label}
        </span>
        <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)' }}>{formatHz(band.freq)}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '16px',
            fontWeight: 600,
            color: disabled ? 'var(--cy-text-muted)' : 'var(--cy-accent)',
          }}
        >
          {band.gainDb > 0 ? '+' : ''}
          {band.gainDb.toFixed(1)} dB
        </span>
      </div>

      <div
        {...drag}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${band.label} gain`}
        aria-valuemin={-RANGE_DB}
        aria-valuemax={RANGE_DB}
        aria-valuenow={band.gainDb}
        aria-disabled={disabled}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowLeft') onChange(Math.max(-RANGE_DB, band.gainDb - 0.5));
          if (e.key === 'ArrowRight') onChange(Math.min(RANGE_DB, band.gainDb + 0.5));
        }}
        style={{
          height: '22px',
          position: 'relative',
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          opacity: disabled ? 0.4 : 1,
          touchAction: 'none',
        }}
      >
        <div style={{ height: '4px', width: '100%', background: '#000', border: '1px solid var(--cy-border)' }} />
        {/* Penanda 0 dB: tanpa ini posisi netral hanya bisa ditebak. */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '2px',
            bottom: '2px',
            width: '1px',
            background: 'var(--cy-border-strong)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: `${left}%`,
            width: '12px',
            height: '18px',
            background: 'var(--cy-accent)',
            marginLeft: '-6px',
          }}
        />
      </div>
    </div>
  );
}

export function EqSliders({
  bands,
  disabled,
  onChange,
}: {
  readonly bands: readonly EqBand[];
  readonly disabled: boolean;
  readonly onChange: (bandId: EqBandId, gainDb: number) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      {bands.map((b) => (
        <BandSlider key={b.id} band={b} disabled={disabled} onChange={(db) => onChange(b.id, db)} />
      ))}
    </div>
  );
}
