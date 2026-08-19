/**
 * Delapan pad + pemilih mode, meniru baris pad rekordbox.
 *
 * SATU grid untuk empat mode, bukan empat komponen: yang berbeda hanya ISI tiap
 * pad dan apa yang terjadi saat ditekan. Empat komponen berarti empat tempat
 * yang harus sepakat soal ukuran, fokus, dan keadaan "deck kosong" — dan salah
 * satunya pasti terlupa.
 *
 * Pad KOSONG harus TERLIHAT kosong. Pad hot cue yang belum diisi digambar
 * dengan garis putus-putus dan tanpa warna; menampilkannya berisi-tapi-redup
 * membuat user mengira cue-nya hilang.
 */

import { useRef } from 'react';

import type { BeatGrid } from '../../studio/analysis/beat-grid';
import { quantized } from '../model';
import {
  BEAT_LOOP_PRESETS,
  HOT_CUE_SLOTS,
  PAD_MODES,
  PAD_MODE_LABEL,
  formatDeckTime,
  type DeckId,
  type DeckState,
  type PadMode,
  type QuantizeDiv,
  type TrackCues,
} from '../model';
import { djActions } from '../store';

/** Loncatan beat jump yang ditawarkan delapan pad, urut. */
const BEAT_JUMPS: readonly number[] = [-16, -8, -4, -1, 1, 4, 8, 16];
/** Loop roll: sama seperti beat loop tapi lebih pendek-pendek. */
const ROLLS: readonly number[] = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];

export interface DeckPadsProps {
  readonly deck: DeckState;
  readonly id: DeckId;
  readonly cues: TrackCues;
  readonly grid: BeatGrid | null;
  readonly accent: string;
  readonly quantizeDiv: QuantizeDiv;
}

interface PadFace {
  readonly top: string;
  readonly bottom: string;
  readonly color: string | null;
  readonly onPress: () => void;
  /**
   * Hanya untuk pad MOMENTARY (LOOP ROLL). Keberadaannya yang menentukan pad
   * dipasang lewat `pointerdown`/`pointerup` alih-alih `click` — `click` baru
   * terjadi SETELAH lepas, jadi perilaku tahan-lepas tidak bisa dinyatakan
   * dengannya sama sekali.
   */
  readonly onRelease?: () => void;
  readonly onClear?: () => void;
}

interface FaceDeps {
  /** Slip deck SEBELUM roll ditekan, supaya bisa dikembalikan saat dilepas. */
  readonly slipBefore: { current: boolean | null };
}

function facesFor(p: DeckPadsProps, deps: FaceDeps): readonly PadFace[] {
  const { deck, id, cues, grid } = p;
  const sr = deck.sampleRate;

  switch (deck.padMode) {
    case 'hotcue':
      return HOT_CUE_SLOTS.map((slot) => {
        const cue = cues.hotCues[slot];
        return {
          top: slot,
          bottom: cue === null ? '' : formatDeckTime(cue.at / sr),
          color: cue?.color ?? null,
          onPress: () => djActions.triggerHotCue(id, slot, grid),
          onClear: cue === null ? undefined : () => djActions.clearHotCue(id, slot),
        };
      });

    case 'loop':
      return BEAT_LOOP_PRESETS.map((beats) => {
        const active = deck.loop.active && deck.loop.beats === beats;
        return {
          top: beats < 1 ? `1/${Math.round(1 / beats)}` : String(beats),
          bottom: 'BEAT',
          color: active ? p.accent : null,
          /*
           * Menekan pad yang SEDANG menyala mematikan loop-nya.
           *
           * Tanpa ini pad beat-loop hanya bisa dinyalakan, tidak pernah
           * dimatikan — satu-satunya jalan keluar adalah tombol EXIT di baris
           * lain, dan pad yang menyala tapi tidak merespons dirinya sendiri
           * terbaca sebagai kerusakan.
           *
           * `exitLoop`, bukan `clearLoop`: batas loop TETAP tersimpan supaya
           * RELOOP masih mungkin. Itu seluruh guna pemisahan `active` dari
           * `in`/`out` di model.
           */
          onPress: () =>
            active ? djActions.exitLoop(id) : djActions.setBeatLoop(id, beats, grid),
        };
      });

    case 'beatjump':
      return BEAT_JUMPS.map((beats) => ({
        top: `${beats > 0 ? '+' : ''}${beats}`,
        bottom: 'BEAT',
        color: null,
        onPress: () => djActions.beatJump(id, beats, grid),
      }));

    case 'roll':
      /*
       * LOOP ROLL adalah MOMENTARY, dan itulah satu-satunya yang membedakannya
       * dari BEAT LOOP.
       *
       * Ditahan: loop berbunyi sambil SLIP menyala, jadi posisi bayangan terus
       * berjalan di belakangnya. Dilepas: loop keluar dan deck mendarat di
       * posisi seolah roll tidak pernah terjadi — lagunya "tidak kehilangan
       * tempat". Tanpa bagian slip itu, roll hanyalah beat loop dengan angka
       * yang berbeda, dan dua pad mode yang melakukan hal yang sama persis
       * bukan dua fitur.
       *
       * `slipBefore` mengingat keadaan SLIP milik user supaya melepas roll
       * tidak diam-diam mematikan slip yang memang sengaja ia nyalakan.
       */
      return ROLLS.map((beats) => ({
        top: beats < 1 ? `1/${Math.round(1 / beats)}` : String(beats),
        bottom: 'ROLL',
        color: deck.loop.active && deck.loop.beats === beats ? p.accent : null,
        onPress: () => {
          deps.slipBefore.current = deck.slip;
          if (!deck.slip) djActions.toggleSlip(id);
          djActions.setBeatLoop(id, beats, grid);
        },
        onRelease: () => {
          djActions.exitLoop(id);
          if (deps.slipBefore.current === false) djActions.toggleSlip(id);
          deps.slipBefore.current = null;
        },
      }));
  }
}

export function DeckPads(props: DeckPadsProps): JSX.Element {
  const { deck, id, accent, cues, grid, quantizeDiv } = props;
  // Keadaan SLIP sebelum roll ditekan. Ref, bukan state: nilainya hanya berarti
  // selama satu tekanan, dan menaruhnya di store berarti satu field lagi yang
  // harus diinvalidasi setiap kali slip diubah dari tempat lain.
  const slipBefore = useRef<boolean | null>(null);
  /**
   * Indeks pad yang SEDANG ditahan.
   *
   * Ada karena `onPointerLeave` menyala juga saat kursor cuma LEWAT di atas pad
   * tanpa pernah menekannya — tanpa penjaga ini, menggeser kursor melintasi
   * baris pad akan mengakhiri roll yang bahkan tidak pernah dimulai, atau lebih
   * buruk, mematikan loop yang sedang dipakai.
   */
  const held = useRef<number | null>(null);
  const faces = facesFor(props, { slipBefore });
  const disabled = deck.assetId === null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        {PAD_MODES.map((mode: PadMode) => (
          <button
            key={mode}
            type="button"
            className="cy-btn-reset"
            onClick={() => djActions.setPadMode(id, mode)}
            style={{
              flex: 1,
              fontSize: '8px',
              letterSpacing: '.1em',
              padding: '3px 0',
              fontFamily: 'var(--cy-font-mono)',
              color: deck.padMode === mode ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
              background: deck.padMode === mode ? accent : 'var(--cy-surface-2)',
              border: '1px solid var(--cy-border)',
              cursor: 'pointer',
            }}
          >
            {PAD_MODE_LABEL[mode]}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0,1fr))',
          gridTemplateRows: 'repeat(2, minmax(0,1fr))',
          gap: '3px',
        }}
      >
        {faces.map((f, i) => (
          <button
            key={`${deck.padMode}-${i}`}
            data-dj-pad={i}
            type="button"
            className="cy-btn-reset cy-focusable"
            disabled={disabled}
            {...(f.onRelease === undefined
              ? {
                  onClick: (e: React.MouseEvent) => {
                    // SHIFT-klik menghapus. Itu gerakan rekordbox, dan ia ada
                    // di samping klik-kanan bukan menggantikannya: klik-kanan
                    // tidak tersedia di trackpad tanpa konfigurasi, dan SHIFT
                    // tidak tersedia di sentuh. Dua jalan ke satu perbuatan
                    // lebih murah daripada satu jalan yang tidak bisa dicapai
                    // sebagian orang.
                    if (e.shiftKey && f.onClear !== undefined) {
                      f.onClear();
                      return;
                    }
                    f.onPress();
                  },
                }
              : {
                  onPointerDown: () => {
                    held.current = i;
                    f.onPress();
                  },
                  // Melepas DI LUAR tombol tetap harus mengakhiri roll — kalau
                  // tidak, deck tertinggal di dalam loop selamanya.
                  onPointerUp: () => {
                    if (held.current !== i) return;
                    held.current = null;
                    f.onRelease?.();
                  },
                  onPointerLeave: () => {
                    if (held.current !== i) return;
                    held.current = null;
                    f.onRelease?.();
                  },
                })}
            onContextMenu={(e) => {
              if (f.onClear === undefined) return;
              e.preventDefault();
              f.onClear();
            }}
            title={
              f.onClear === undefined
                ? undefined
                : 'SHIFT-klik atau klik kanan untuk menghapus cue ini'
            }
            style={{
              minHeight: '34px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1px',
              fontFamily: 'var(--cy-font-mono)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.35 : 1,
              // Pad kosong: garis putus-putus, tanpa isian. Ia HARUS terlihat
              // kosong — pad redup-tapi-berisi membuat user mengira cue hilang.
              background: f.color === null ? 'var(--cy-surface-2)' : `${f.color}22`,
              border:
                f.color === null
                  ? '1px dashed var(--cy-border)'
                  : `1px solid ${f.color}`,
              boxShadow: f.color === null ? 'none' : `0 0 10px ${f.color}33`,
            }}
          >
            <span
              style={{
                fontSize: '12px',
                color: f.color ?? 'var(--cy-text-dim)',
                lineHeight: 1,
              }}
            >
              {f.top}
            </span>
            <span
              style={{
                fontSize: '8px',
                letterSpacing: '.08em',
                color: 'var(--cy-text-muted)',
                fontVariantNumeric: 'tabular-nums',
                minHeight: '9px',
              }}
            >
              {f.bottom}
            </span>
          </button>
        ))}
      </div>

      {/*
        MEMORY CUE ◀ CALL ▶ — persis baris yang ada di bawah pad rekordbox.
        Memory cue adalah penanda NAVIGASI: ia tidak memicu apa pun saat lagu
        lewat, hanya jadi tujuan lompatan. Karena itu ia hidup di daftar yang
        terpisah dari delapan hot cue, dan bukan mengambil salah satu slotnya.
      */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
        <button
          type="button"
          className="cy-btn-reset"
          disabled={disabled}
          onClick={() => {
            const at = quantized(deck.playhead, grid, deck.sampleRate, deck.quantize, quantizeDiv);
            // Toggle, bukan hanya tambah. Tanpa ini memory cue bisa dipasang
            // tapi tidak pernah dilepas, dan satu salah tekan tinggal permanen
            // di lagu itu selamanya.
            if (cues.memoryCues.includes(at)) djActions.removeMemoryCue(id, at);
            else djActions.addMemoryCue(id, at);
          }}
          title="simpan memory cue di posisi sekarang — tekan lagi di posisi yang sama untuk menghapusnya"
          style={{
            fontSize: '8px',
            letterSpacing: '.1em',
            padding: '2px 6px',
            fontFamily: 'var(--cy-font-mono)',
            color: 'var(--cy-text-dim)',
            background: 'var(--cy-surface-2)',
            border: '1px solid var(--cy-border)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.35 : 1,
          }}
        >
          {cues.memoryCues.includes(
            quantized(deck.playhead, grid, deck.sampleRate, deck.quantize, quantizeDiv),
          )
            ? 'HAPUS CUE'
            : 'MEMORY CUE'}
        </button>
        {([-1, 1] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            className="cy-btn-reset"
            disabled={disabled || cues.memoryCues.length === 0}
            onClick={() => djActions.callMemoryCue(id, dir)}
            title={dir === -1 ? 'memory cue sebelumnya' : 'memory cue berikutnya'}
            style={{
              fontSize: '9px',
              padding: '2px 7px',
              fontFamily: 'var(--cy-font-mono)',
              color: 'var(--cy-accent)',
              background: 'var(--cy-surface-2)',
              border: '1px solid var(--cy-border)',
              cursor: 'pointer',
            }}
          >
            {dir === -1 ? '◀' : '▶'}
          </button>
        ))}
        <span
          style={{ fontSize: '8px', color: 'var(--cy-text-muted)', marginLeft: 'auto' }}
          title="jumlah memory cue tersimpan untuk lagu ini"
        >
          {cues.memoryCues.length}
        </span>
      </div>
    </div>
  );
}
