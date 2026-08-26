/**
 * Kolom kiri timeline: satu baris 64px per lane — bar warna, nama yang bisa
 * diedit inline, meta, dan tombol M / S / ✕.
 *
 * Klik di baris memilih lane; tombol kecil memakai `stopPropagation` supaya
 * mute/solo/hapus tidak ikut memindahkan seleksi (perilaku design).
 *
 * Bar warna di kiri bukan hiasan: warnanya mengisi clip, garis tepinya, teks
 * label clip, dan waveform di arrangement. Karena itu ia bisa diubah — klik
 * dua kali (atau Enter/Space) membuka `LaneColorModal`.
 */

import { useEffect, useRef, useState } from 'react';

import {
  isAudible,
  laneHeightPx,
  MAX_LANE_SPEED,
  MIN_LANE_SPEED,
  LANE_SPEEDS,
  formatTime,
  laneTotalSamples,
  samplesToSec,
  type StudioLane,
} from '../model';
import { studioActions, studioStore, useStudio } from '../store';
import { auditionPositionSourceSec, previewPositionSec } from '../preview/audio-preview';
import { lanePulse } from './beat-pulse';
import { LaneColorModal } from './LaneColorModal';

interface LaneRowProps {
  readonly lane: StudioLane;
  readonly selected: boolean;
  readonly sampleRate: number;
  /** true kalau lane ini bisu HANYA karena lane lain sedang solo. */
  readonly silencedByOther: boolean;
}

const MICRO_BTN = {
  width: '20px',
  height: '18px',
  border: '1px solid var(--cy-border-strong)',
  display: 'grid',
  placeItems: 'center',
  fontSize: '8px',
  cursor: 'pointer',
} as const;

function formatLaneSpeed(value: number): string {
  return `${Number(value.toFixed(3))}x`;
}

function LaneSpeedControl({ lane }: { readonly lane: StudioLane }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(() => String(lane.speedRatio));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setManual(String(Number(lane.speedRatio.toFixed(3)))), [lane.speedRatio]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const closeEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const applyManual = (): void => {
    const parsed = Number(manual.replace(',', '.'));
    if (Number.isFinite(parsed)) studioActions.setLaneSpeed(lane.id, parsed);
    else setManual(String(Number(lane.speedRatio.toFixed(3))));
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', marginLeft: '2px' }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={`kecepatan lane ${lane.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Atur kecepatan lane"
        onClick={() => setOpen((value) => !value)}
        style={{
          height: '18px',
          minWidth: '40px',
          padding: '0 5px',
          background: lane.speedRatio === 1 ? 'transparent' : 'var(--cy-accent)',
          color: lane.speedRatio === 1 ? 'var(--cy-text-muted)' : 'var(--cy-text-on-accent)',
          border: '1px solid var(--cy-border-strong)',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '8px',
          cursor: 'pointer',
        }}
      >
        {formatLaneSpeed(lane.speedRatio)}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={`atur kecepatan ${lane.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            zIndex: 30,
            left: 0,
            top: '24px',
            width: '246px',
            padding: '14px',
            border: '1px solid var(--cy-accent)',
            background: 'var(--cy-surface-1)',
            boxShadow: '0 16px 42px #000c',
          }}
        >
          <div style={{ fontSize: '9px', letterSpacing: '.18em', color: 'var(--cy-accent)', marginBottom: '12px' }}>
            VARISPEED · {lane.name.toUpperCase()}
          </div>
          <label style={{ display: 'grid', gap: '6px', fontSize: '9px', color: 'var(--cy-text-muted)', letterSpacing: '.12em' }}>
            SPEED MANUAL
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                aria-label={`speed manual ${lane.name}`}
                inputMode="decimal"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onBlur={applyManual}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyManual();
                  if (e.key === 'Escape') setOpen(false);
                }}
                style={{ width: '100%', minWidth: 0, height: '30px', padding: '0 8px', border: '1px solid var(--cy-border-strong)', background: '#050505', color: 'var(--cy-text)', fontFamily: 'var(--cy-font-mono)' }}
              />
              <span style={{ alignSelf: 'center', color: 'var(--cy-text-muted)' }}>×</span>
            </div>
          </label>
          <input
            type="range"
            aria-label={`slider speed ${lane.name}`}
            min={MIN_LANE_SPEED}
            max={MAX_LANE_SPEED}
            step="0.01"
            value={lane.speedRatio}
            onChange={(e) => studioActions.setLaneSpeed(lane.id, Number(e.target.value))}
            style={{ width: '100%', margin: '14px 0 10px', accentColor: 'var(--cy-accent)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: 'var(--cy-text-muted)' }}>
            <span>{MIN_LANE_SPEED}×</span>
            <strong style={{ color: 'var(--cy-accent)' }}>{formatLaneSpeed(lane.speedRatio)}</strong>
            <span>{MAX_LANE_SPEED}×</span>
          </div>
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--cy-border)' }}>
            {LANE_SPEEDS.map((speed) => (
              <button key={speed} type="button" onClick={() => studioActions.setLaneSpeed(lane.id, speed)} style={{ height: '24px', padding: '0 7px', border: '1px solid var(--cy-border-strong)', background: speed === lane.speedRatio ? 'var(--cy-accent)' : 'transparent', color: speed === lane.speedRatio ? 'var(--cy-text-on-accent)' : 'var(--cy-text-muted)', fontFamily: 'var(--cy-font-mono)', fontSize: '8px', cursor: 'pointer' }}>
                {formatLaneSpeed(speed)}
              </button>
            ))}
          </div>
          <p style={{ margin: '10px 0 0', fontSize: '8px', lineHeight: 1.5, color: 'var(--cy-text-muted)' }}>
            VARISPEED — SPEED DAN PITCH BERUBAH BERSAMA.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LaneRow({ lane, selected, sampleRate, silencedByOther }: LaneRowProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [swatchHover, setSwatchHover] = useState(false);

  // Meta baris merangkap penjelasan KENAPA lane tidak terdengar. "MUTED" saja
  // membingungkan kalau penyebabnya lane lain yang solo — user tidak menekan
  // apa pun di lane ini.
  const meta = lane.mute
    ? 'MUTED'
    : silencedByOther
      ? 'SILENCED BY SOLO'
      : lane.clips.length === 0
        ? 'EMPTY'
        : `${lane.clips.length} CLIP · ${formatTime(samplesToSec(laneTotalSamples(lane), sampleRate))}`;

  const laneH = laneHeightPx(useStudio((st) => st.laneHeight));

  return (
    <>
      <div data-tl-lanes
        onClick={() => studioActions.selectLane(lane.id)}
        data-lane-header={lane.id}
        style={{
          height: `${laneH}px`,
          borderBottom: '1px solid var(--cy-border)',
          background: selected ? 'var(--cy-surface-2)' : 'var(--cy-surface-1)',
          padding: '8px 10px',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          cursor: 'pointer',
        }}
      >
        {/*
          Bar warna sekaligus pemicu pemilih warna.
          Sebuah <button>, bukan <div>: klik ganda saja tidak bisa ditemukan dan
          tidak bisa dicapai keyboard. Sebagai tombol ia masuk urutan Tab, punya
          nama aksesibel, dan Enter/Space membuka modal yang sama.
          Klik tunggal SENGAJA dibiarkan menggelembung ke baris — memilih lane
          adalah perilaku baris yang sudah ada dan tidak boleh hilang di sini.
        */}
        <button
          type="button"
          data-lane-swatch={lane.id}
          className="cy-btn-reset cy-focusable"
          aria-haspopup="dialog"
          aria-label={`warna lane ${lane.name}`}
          title="Klik dua kali (atau Enter) untuk mengubah warna lane"
          onMouseEnter={() => setSwatchHover(true)}
          onMouseLeave={() => setSwatchHover(false)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            // Fokus eksplisit: hanya sebagian browser memfokuskan tombol saat
            // mousedown, dan modal mengembalikan fokus ke elemen yang aktif saat
            // ia dibuka. Tanpa baris ini fokus pulang ke <body> setelah ditutup.
            e.currentTarget.focus();
            setPickerOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            // preventDefault menahan `click` sintetis dari tombol — kalau tidak,
            // menekan Enter ikut memicu jalur klik dan halaman ikut ter-scroll
            // pada Space.
            e.preventDefault();
            e.stopPropagation();
            setPickerOpen(true);
          }}
          style={{
            // Bar-nya tetap 3px seperti design; tombolnya lebih lebar supaya
            // target klik/tap tidak selebar sehelai rambut.
            width: '9px',
            height: '44px',
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            position: 'relative',
          }}
        >
          {/*
            Lapisan DENYUT, terpisah dari bar warnanya sendiri.
            Elemen sendiri karena gayanya ditulis 60×/detik langsung ke DOM
            (lihat `useLanePulses`): kalau ia menumpang bar di bawahnya, React
            akan menimpanya kembali setiap kali baris ini render — dan gejalanya
            bukan "error", melainkan kedipan yang kadang hilang.
          */}
          <span
            data-lane-pulse={lane.id}
            aria-hidden
            style={{
              position: 'absolute',
              width: '9px',
              height: '44px',
              background: lane.color,
              boxShadow: `0 0 12px ${lane.color}`,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
          <span
            style={{
              display: 'block',
              width: swatchHover ? '7px' : '3px',
              height: '44px',
              background: lane.color,
              boxShadow: swatchHover ? `0 0 8px ${lane.color}80` : 'none',
              position: 'relative',
            }}
          />
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <input
            data-lane-name
            value={lane.name}
            spellCheck={false}
            aria-label={`nama lane ${lane.name}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => studioActions.renameLane(lane.id, e.target.value)}
          />
          <div
            style={{
              fontSize: '9px',
              color: 'var(--cy-text-muted)',
              letterSpacing: '.14em',
              marginTop: '4px',
            }}
          >
            {meta}
          </div>
          <div style={{ display: 'flex', gap: '4px', marginTop: '5px' }}>
            <span
              role="button"
              aria-label="mute"
              onClick={(e) => {
                e.stopPropagation();
                studioActions.toggleMute(lane.id);
              }}
              style={{ ...MICRO_BTN, color: lane.mute ? '#ff4d4d' : 'var(--cy-text-muted)' }}
            >
              M
            </span>
            <span
              role="button"
              aria-label="solo"
              onClick={(e) => {
                e.stopPropagation();
                studioActions.toggleSolo(lane.id);
              }}
              style={{ ...MICRO_BTN, color: lane.solo ? 'var(--cy-accent)' : 'var(--cy-text-muted)' }}
            >
              S
            </span>
            <span
              role="button"
              aria-label="hapus lane"
              className="cy-hover-danger"
              onClick={(e) => {
                e.stopPropagation();
                studioActions.removeLane(lane.id);
              }}
              style={{ ...MICRO_BTN, color: 'var(--cy-text-muted)' }}
            >
              ✕
            </span>

            <LaneSpeedControl lane={lane} />
          </div>
        </div>
      </div>

      {/*
        Modal ditaruh DI LUAR <div> baris, bukan di dalamnya: portal React tetap
        menggelembungkan event lewat pohon React, jadi klik di dalam modal akan
        memanggil `selectLane` milik baris kalau ia bersarang di sana.
      */}
      {pickerOpen ? (
        <LaneColorModal
          laneName={lane.name}
          initialColor={lane.color}
          onCancel={() => setPickerOpen(false)}
          onApply={(color) => {
            studioActions.setLaneColor(lane.id, color);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Menyalakan strip lane mengikuti ketukan, 60×/detik, LANGSUNG KE DOM.
 *
 * Tidak lewat `setState`: satu render React per frame untuk delapan lane berarti
 * seluruh header (tombol, dropdown speed, teks meta) direkonsiliasi 60×/detik
 * demi satu angka opacity. Aturan yang sama sudah dipakai meter dan playhead —
 * data 60 Hz digambar langsung, tidak menyentuh state.
 *
 * Loop-nya HANYA hidup saat ada yang berbunyi. Layar diam tidak perlu digambar
 * ulang, dan rAF yang berjalan terus hanya membakar baterai untuk gambar yang
 * sama.
 */
function useLanePulses(active: boolean): void {
  useEffect(() => {
    const paint = (level: (laneId: string) => number): void => {
      const nodes = document.querySelectorAll<HTMLElement>('[data-lane-pulse]');
      for (const el of nodes) {
        const id = el.dataset.lanePulse;
        el.style.opacity = id === undefined ? '0' : String(level(id));
      }
    };

    if (!active || typeof requestAnimationFrame !== 'function') {
      paint(() => 0);
      return;
    }

    let raf = requestAnimationFrame(function frame(): void {
      const s = studioStore.getState();
      const heard = previewPositionSec();
      const timelineSec = heard ?? s.playhead / s.sampleRate;
      const auditionSec = auditionPositionSourceSec();
      const audition =
        s.clipLoop === null || auditionSec === null
          ? null
          : { clipId: s.clipLoop.clipId, sourceSec: auditionSec };

      paint((id) => {
        const lane = s.lanes.find((l) => l.id === id);
        if (lane === undefined) return 0;
        return lanePulse(lane, s.lanes, s.assets, s.sampleRate, timelineSec, audition);
      });
      raf = requestAnimationFrame(frame);
    });
    return () => {
      cancelAnimationFrame(raf);
      paint(() => 0);
    };
  }, [active]);
}

export function LaneHeaders(): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const selectedLaneId = useStudio((s) => s.selectedLaneId);
  const sampleRate = useStudio((s) => s.sampleRate);
  // Audisi loop ikut menyalakan denyut: ia berbunyi walau transport berhenti.
  //
  // DUA hook terpisah, digabung SETELAHNYA — bukan `useStudio(a) || useStudio(b)`.
  // `||` men-short-circuit, jadi hook kedua tidak selalu dipanggil dan urutan
  // hook berubah antar render. React menangkapnya sebagai crash, bukan sebagai
  // gejala halus; itu pun hanya kalau ada tes yang menekan PLAY.
  const playing = useStudio((s) => s.playing);
  const auditioning = useStudio((s) => s.clipLoop !== null);
  useLanePulses(playing || auditioning);

  return (
    <div style={{ borderRight: '1px solid var(--cy-border)', minWidth: 0 }}>
      {lanes.map((lane) => (
        <LaneRow
          key={lane.id}
          lane={lane}
          selected={lane.id === selectedLaneId}
          sampleRate={sampleRate}
          silencedByOther={!lane.mute && !isAudible(lane, lanes)}
        />
      ))}
    </div>
  );
}
