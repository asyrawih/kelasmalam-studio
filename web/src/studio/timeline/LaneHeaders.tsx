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

import { useState } from 'react';

import {
  isAudible,
  laneHeightPx,
  LANE_SPEEDS,
  formatTime,
  laneTotalSamples,
  samplesToSec,
  type StudioLane,
} from '../model';
import { studioActions, useStudio } from '../store';
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
          }}
        >
          <span
            style={{
              display: 'block',
              width: swatchHover ? '7px' : '3px',
              height: '44px',
              background: lane.color,
              boxShadow: swatchHover ? `0 0 8px ${lane.color}80` : 'none',
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

            {/*
              Speed lane. VARISPEED — pitch ikut berubah, jadi label-nya harus
              jujur; lihat catatan PITCH_LOCK_AVAILABLE di model.ts.
              `select` dipilih daripada tombol siklus: nilainya langsung terbaca
              tanpa harus menekan berkali-kali untuk tahu ada pilihan apa.
            */}
            <select
              aria-label={`kecepatan lane ${lane.name}`}
              title="Kecepatan lane (varispeed — pitch ikut berubah)"
              value={lane.speedRatio}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                studioActions.setLaneSpeed(lane.id, Number.parseFloat(e.target.value));
              }}
              style={{
                height: '18px',
                marginLeft: '2px',
                background: lane.speedRatio === 1 ? 'transparent' : 'var(--cy-accent)',
                color: lane.speedRatio === 1 ? 'var(--cy-text-muted)' : 'var(--cy-text-on-accent)',
                border: '1px solid var(--cy-border-strong)',
                fontFamily: 'var(--cy-font-mono)',
                fontSize: '8px',
                padding: '0 2px',
                cursor: 'pointer',
              }}
            >
              {LANE_SPEEDS.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
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

export function LaneHeaders(): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const selectedLaneId = useStudio((s) => s.selectedLaneId);
  const sampleRate = useStudio((s) => s.sampleRate);

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
