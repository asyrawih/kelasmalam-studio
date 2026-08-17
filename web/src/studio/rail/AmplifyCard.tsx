/**
 * AMPLIFY — gain master, satu-satunya kontrol level SESUDAH semua lane
 * dijumlahkan.
 *
 * Ia berlaku untuk preview DAN export: preview memasangnya sebagai satu
 * GainNode di ujung rantai (`preview/audio-preview.ts`), export mengirimnya
 * sebagai fader bus master ke engine (`crates/wasm-bridge/src/studio.rs`).
 * Dua jalur, satu angka — kalau hanya salah satu yang menerapkannya, file
 * hasilnya beda level dari yang barusan didengar, dan itu jenis bug yang baru
 * ketahuan setelah file-nya dikirim ke orang lain.
 *
 * KENAPA TIDAK MEMAKAI `faderToDb` (docs/07 §7b): taper fader ada untuk
 * menyelesaikan masalah rentang −∞…+6 dB, di mana setengah travel terbuang di
 * daerah yang tidak berguna secara musikal. Rentang di sini hanya 36 dB tanpa
 * titik mute sama sekali, jadi linear-dB sudah memberi ~0,1 dB per piksel di
 * seluruh travel. Menambahkan taper justru merusak satu-satunya hal yang
 * penting di kontrol ini: posisi 0 dB harus ada di tempat yang bisa ditemukan
 * mata, dan jaraknya ke tiap ujung harus sebanding dengan jumlah dB-nya.
 */

import { useEffect, useRef, useState } from 'react';

import { Badge, Card } from '../../ui/cyber';
import { MAX_MASTER_GAIN_DB, MIN_MASTER_GAIN_DB } from '../model';
import { readMasterPeak } from '../preview/audio-preview';
import { formatDb } from './fader';
import { studioActions, useStudio } from './store-adapter';
import { useDragFraction } from './useDragFraction';

const RANGE_DB = MAX_MASTER_GAIN_DB - MIN_MASTER_GAIN_DB;

/**
 * Lebar detent 0 dB, dalam dB.
 *
 * Bukan kosmetik: netral adalah nilai yang paling sering dituju dan
 * satu-satunya yang punya arti pasti ("jangan ubah apa-apa"). Tanpa detent,
 * mengembalikan slider ke 0,0 dari tangan bebas praktis mustahil pada 0,1 dB
 * per piksel, dan user akan berhenti di −0,3 dB tanpa tahu. 0,4 dB ≈ 4 piksel
 * pada kartu 360 px — cukup untuk terasa, terlalu sempit untuk menghalangi
 * setelan yang memang disengaja di sekitar unity.
 */
export const MASTER_DETENT_DB = 0.4;

/** Posisi 0 dB pada travel (0..1). Ditandai di trek supaya bisa dibidik. */
export const UNITY_FRACTION = (0 - MIN_MASTER_GAIN_DB) / RANGE_DB;

/** Sama persis dengan `studioActions.setMasterGain`: ±Infinity mendarat di
 *  ujungnya, hanya NaN (ketikan yang tidak terbaca) yang jatuh ke netral. */
export const clampMasterDb = (db: number): number =>
  Number.isNaN(db) ? 0 : Math.min(MAX_MASTER_GAIN_DB, Math.max(MIN_MASTER_GAIN_DB, db));

/** dB → travel 0..1. Nilai di luar rentang dijepit, bukan keluar dari trek. */
export const masterDbToFraction = (db: number): number =>
  (clampMasterDb(db) - MIN_MASTER_GAIN_DB) / RANGE_DB;

/**
 * travel 0..1 → dB, dengan detent di 0 dan pembulatan 0,1 dB.
 *
 * Pembulatannya penting: angka yang ditampilkan berdesimal satu, jadi menyimpan
 * −3,04871 berarti readout dan nilai sebenarnya berbeda, dan mengetik ulang
 * "−3.0" akan menggeser slider satu piksel tanpa sebab yang terlihat.
 */
export function fractionToMasterDb(fraction: number): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const db = MIN_MASTER_GAIN_DB + f * RANGE_DB;
  if (Math.abs(db) < MASTER_DETENT_DB) return 0;
  return Math.round(db * 10) / 10;
}

/** Linear (0..1+) → dBFS. `0` → −inf, bukan −Infinity yang bocor ke layout. */
export const linToDbfs = (lin: number): number => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

/**
 * Peak master hasil pengukuran, bukan perkiraan.
 *
 * Ballistics docs/07 §7e: attack instan (meter yang melewatkan transien satu
 * sample adalah meter yang berbohong soal clipping), release 20 dB/detik supaya
 * mata sempat membacanya. Flag clip di-LATCH sampai user meng-klik reset —
 * indikator clip yang hilang sendiri tidak ada gunanya.
 */
function useMasterPeak(active: boolean, resetKey: number): { peak: number | null; clipped: boolean } {
  const [peak, setPeak] = useState<number | null>(null);
  const [clipped, setClipped] = useState(false);
  const shown = useRef(0);

  useEffect(() => {
    shown.current = 0;
    setClipped(false);
    if (!active) {
      setPeak(null);
      return;
    }
    if (typeof requestAnimationFrame !== 'function') return;

    let raf = 0;
    let last = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const measured = readMasterPeak();
      if (measured === null) {
        setPeak(null);
        return;
      }
      const dt = last === 0 ? 0 : Math.min(0.25, (now - last) / 1000);
      last = now;
      // 20 dB/s → faktor 10^(-dt) per detik.
      const decayed = shown.current * 10 ** -dt;
      shown.current = Math.max(measured, decayed);
      if (measured >= 1) setClipped(true);
      setPeak(shown.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, resetKey]);

  return { peak, clipped };
}

/** Skala di bawah trek. 0 diberi label penuh karena itu yang dicari mata. */
const TICKS: readonly { db: number; label: string }[] = [
  { db: MIN_MASTER_GAIN_DB, label: '-24' },
  { db: -12, label: '-12' },
  { db: 0, label: '0 dB' },
  { db: 6, label: '+6' },
  { db: MAX_MASTER_GAIN_DB, label: '+12' },
];

export function AmplifyCard(): JSX.Element {
  const masterGainDb = useStudio((s) => s.masterGainDb);
  const playing = useStudio((s) => s.playing);
  const [resetKey, setResetKey] = useState(0);
  const { peak, clipped } = useMasterPeak(playing, resetKey);
  /** Nilai yang sedang diketik. `null` = tampilkan nilai store. */
  const [draft, setDraft] = useState<string | null>(null);

  const set = (db: number): void => studioActions.setMasterGain(clampMasterDb(db));
  const fraction = masterDbToFraction(masterGainDb);
  const drag = useDragFraction((f) => set(fractionToMasterDb(f)));

  const commitDraft = (): void => {
    if (draft === null) return;
    const parsed = Number.parseFloat(draft.replace(',', '.'));
    // Ketikan yang tidak terbaca dibuang tanpa mengubah apa pun — mengubah
    // level jadi 0 karena user salah ketik adalah kejutan yang mahal.
    if (Number.isFinite(parsed)) set(Math.round(parsed * 10) / 10);
    setDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    // Shift = halus (0,1 dB, satu langkah readout); tanpa Shift 0,5 dB.
    const step = e.shiftKey ? 0.1 : 0.5;
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir !== 0) {
      e.preventDefault();
      set(Math.round((masterGainDb + dir * step) * 10) / 10);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      set(0);
    }
  };

  const boost = masterGainDb > 0;
  const peakDb = peak === null ? null : linToDbfs(peak);
  const overs = peakDb !== null && peakDb > 0;

  return (
    <Card
      title="Amplify"
      subtitle="gain master"
      notched
      actions={
        masterGainDb === 0 ? (
          <Badge height={22} title="Master tidak mengubah level sama sekali">
            UNITY
          </Badge>
        ) : (
          <Badge tone="accent" height={22} title="Klik dua kali slider untuk kembali ke 0 dB">
            {boost ? 'BOOST' : 'CUT'}
          </Badge>
        )
      }
    >
      <div style={{ display: 'grid', gap: '12px' }}>
        {/* ── Readout + input. Satu elemen yang sama: yang dibaca adalah yang
            bisa diketik, jadi tidak ada dua angka yang bisa berselisih. ── */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <input
            aria-label="Amplify master dalam dB"
            value={draft ?? formatDb(masterGainDb)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              setDraft(formatDb(masterGainDb));
              e.target.select();
            }}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') setDraft(null);
            }}
            style={{
              width: '86px',
              padding: '2px 0',
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--cy-border)',
              color: 'var(--cy-accent)',
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '26px',
              fontWeight: 600,
              letterSpacing: '.04em',
              textShadow: 'var(--cy-text-glow)',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: '11px', letterSpacing: '.18em', color: 'var(--cy-text-muted)' }}>
            dB
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              letterSpacing: '.12em',
              color: 'var(--cy-text-muted)',
            }}
          >
            PREVIEW + EXPORT
          </span>
        </div>

        {/* ── Trek. Isian berangkat dari posisi 0 dB, bukan dari kiri: arah
            (naik/turun) harus terbaca tanpa membaca angka. ── */}
        <div
          role="slider"
          aria-label="Amplify master"
          aria-valuemin={MIN_MASTER_GAIN_DB}
          aria-valuemax={MAX_MASTER_GAIN_DB}
          aria-valuenow={Number(masterGainDb.toFixed(1))}
          aria-valuetext={`${formatDb(masterGainDb)} dB`}
          tabIndex={0}
          title="Seret untuk mengatur · klik dua kali = 0 dB · panah ±0,5 dB (Shift ±0,1)"
          onKeyDown={onKeyDown}
          onDoubleClick={() => set(0)}
          {...drag}
          style={{
            position: 'relative',
            height: '26px',
            background: '#000',
            border: '1px solid var(--cy-border)',
            cursor: 'ew-resize',
            touchAction: 'none',
            overflow: 'hidden',
          }}
        >
          {/* Detent 0 dB: garis penuh + kaki di atas/bawah, jauh lebih terang
              dari grid supaya bisa dibidik dari sudut mata. */}
          <div
            style={{
              position: 'absolute',
              left: `${UNITY_FRACTION * 100}%`,
              top: 0,
              bottom: 0,
              width: '1px',
              background: 'var(--cy-border-strong)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: `${Math.min(fraction, UNITY_FRACTION) * 100}%`,
              width: `${Math.abs(fraction - UNITY_FRACTION) * 100}%`,
              top: '7px',
              bottom: '7px',
              background: boost
                ? 'linear-gradient(90deg,#ffb020,#ffd400)'
                : 'linear-gradient(90deg,#ffd400,#ffb020)',
              opacity: 0.85,
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: `${fraction * 100}%`,
              top: 0,
              bottom: 0,
              width: '3px',
              marginLeft: '-1.5px',
              background: 'var(--cy-accent)',
              boxShadow: 'var(--cy-glow-magenta)',
            }}
          />
        </div>

        {/* Skala: label diposisikan pada dB-nya, bukan dibagi rata — kalau
            dibagi rata, "0 dB" akan berbohong tentang letak detent. */}
        <div style={{ position: 'relative', height: '11px' }}>
          {TICKS.map((t) => (
            <span
              key={t.db}
              style={{
                position: 'absolute',
                left: `${masterDbToFraction(t.db) * 100}%`,
                transform:
                  t.db === MIN_MASTER_GAIN_DB
                    ? 'none'
                    : t.db === MAX_MASTER_GAIN_DB
                      ? 'translateX(-100%)'
                      : 'translateX(-50%)',
                fontSize: '9px',
                letterSpacing: '.12em',
                color: t.db === 0 ? 'var(--cy-text-dim)' : 'var(--cy-text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </span>
          ))}
        </div>

        {/* ── Kejujuran clipping. Peak DIUKUR (tap sesudah amplify di preview),
            tidak diperkirakan; saat tidak berbunyi tidak ada angka yang
            ditampilkan sama sekali, karena meter yang menebak lebih buruk
            daripada meter yang mengaku tidak tahu. ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '9px', letterSpacing: '.16em', color: 'var(--cy-text-muted)' }}>
            PEAK MASTER
          </span>
          <span
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '13px',
              fontWeight: 600,
              color: overs ? '#ff4d4d' : 'var(--cy-accent)',
            }}
          >
            {peakDb === null
              ? '—'
              : `${peakDb === -Infinity ? '-inf' : formatDb(peakDb)} dBFS`}
          </span>
          {peakDb === null ? (
            <span style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}>
              {/* Dua sebab berbeda, dan user perlu tahu yang mana: belum ada
                  yang berbunyi, atau browser ini memang tidak bisa mengukur. */}
              {playing ? 'BROWSER INI TIDAK MENYEDIAKAN METER' : 'TEKAN PLAY UNTUK MENGUKUR'}
            </span>
          ) : null}
          {clipped ? (
            <button
              type="button"
              className="cy-btn-reset"
              onClick={() => setResetKey((k) => k + 1)}
              title="Sample mencapai atau melewati 0 dBFS sejak reset terakhir. Klik untuk mereset penanda."
              style={{ marginLeft: 'auto', cursor: 'pointer' }}
            >
              <Badge tone="danger" height={22} dot pulse>
                CLIP
              </Badge>
            </button>
          ) : null}
        </div>

        <div
          style={{
            fontSize: '9px',
            lineHeight: 1.5,
            letterSpacing: '.1em',
            color: 'var(--cy-text-muted)',
          }}
        >
          TANPA LIMITER &amp; TANPA SOFT-CLIP — di preview maupun di file hasil export.
          Sample di atas 0 dBFS lewat apa adanya dan akan terpotong oleh DAC serta
          encoder WAV/MP3. Turunkan amplify (atau fader lane) sampai peak di bawah 0.
        </div>
      </div>
    </Card>
  );
}
