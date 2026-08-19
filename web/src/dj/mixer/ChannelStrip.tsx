/**
 * Satu channel strip. Dirender DUA KALI, dan sengaja TIDAK dicerminkan —
 * di mixer sungguhan pun kedua strip identik; yang berbeda hanya labelnya.
 *
 * Urutan kontrolnya mengikuti jalur sinyal dari atas ke bawah: TRIM → EQ →
 * COLOR → CUE → fader. Itu bukan kebiasaan visual, itu supaya tangan bergerak
 * searah dengan sinyalnya saat mencari masalah gain.
 */

import { formatDb } from '../../studio/rail/fader';
import {
  DJ_EQ_BANDS,
  EQ_KILL_DB,
  EQ_MAX_DB,
  MAX_TRIM_DB,
  MIN_TRIM_DB,
  type ChannelState,
  type DeckId,
} from '../model';
import { djActions } from '../store';
import { Fader } from './Fader';
import { Knob } from './Knob';
import { LevelMeter } from './LevelMeter';

const BAND_LABEL: Readonly<Record<'hi' | 'mid' | 'low', string>> = {
  hi: 'HI',
  mid: 'MID',
  low: 'LOW',
};

export interface ChannelStripProps {
  readonly channel: ChannelState;
  readonly id: DeckId;
  readonly accent: string;
  readonly compact: boolean;
}

/**
 * Satu channel strip.
 *
 * TINGGINYA TIDAK DIHITUNG, ia dibagi: tumpukan knob memakai tinggi alaminya,
 * dan blok fader mengambil SISANYA lewat `flex: 1`. Versi sebelumnya memberi
 * fader panjang tetap, dan begitu jumlah knob melebihi ruang yang ada, yang
 * terpotong justru fader dan tombol CUE — kontrol yang paling sering dipakai,
 * hilang tanpa satu pun gejala selain "kok nggak kelihatan".
 */
export function ChannelStrip({ channel, id, accent, compact }: ChannelStripProps): JSX.Element {
  const knob = compact ? 30 : 36;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: compact ? '2px' : '4px',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
      }}
    >
      <div style={{ fontSize: '10px', letterSpacing: '.16em', color: accent, flexShrink: 0 }}>
        CH {id}
      </div>

      <Knob
        label="TRIM"
        value={channel.trimDb}
        min={MIN_TRIM_DB}
        max={MAX_TRIM_DB}
        center={0}
        size={knob}
        accent={accent}
        dense
        format={(v) => `${formatDb(v, 0)}`}
        onChange={(v) => djActions.setTrim(id, v)}
      />

      {DJ_EQ_BANDS.map((band) => (
        <Knob
          key={band}
          label={BAND_LABEL[band]}
          value={channel.eq[band]}
          min={EQ_KILL_DB}
          max={EQ_MAX_DB}
          center={0}
          size={knob}
          accent={accent}
          dense
          format={(v) => (channel.eqKill[band] ? 'KILL' : formatDb(v, 0))}
          onChange={(v) => djActions.setEqBand(id, band, v)}
          onLabelClick={() => djActions.toggleEqKill(id, band)}
          labelActive={channel.eqKill[band]}
          // "While they light up, each controller is not activated." Knob-nya
          // tetap menyimpan nilainya — ia hanya berhenti berpengaruh, dan itu
          // yang membuat menyalakan band lagi mengembalikan setelan semula.
          disabled={channel.eqKill[band]}
        />
      ))}

      <Knob
        label="COLOR"
        value={channel.filter}
        min={-1}
        max={1}
        center={0}
        size={knob}
        accent={accent}
        dense
        format={(v) => (Math.abs(v) < 0.03 ? 'OFF' : v < 0 ? `LPF ${Math.round(-v * 100)}` : `HPF ${Math.round(v * 100)}`)}
        onChange={(v) => djActions.setFilter(id, v)}
        title="COLOR — tengah = tidak ada filter; kiri lowpass, kanan highpass (gaya rekordbox)"
      />

      <button
        type="button"
        className="cy-btn-reset cy-focusable"
        onClick={() => djActions.toggleCue(id)}
        title="monitor headphone — jalur cue belum tersambung ke audio mana pun"
        style={{
          fontSize: '9px',
          letterSpacing: '.14em',
          padding: '2px 10px',
          fontFamily: 'var(--cy-font-mono)',
          color: channel.cue ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
          background: channel.cue ? accent : 'var(--cy-surface-2)',
          border: '1px solid var(--cy-border)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        CUE
      </button>

      {/* Blok fader mengambil SISA tinggi. Kalau ruangnya habis, yang menyusut
          adalah fader — bukan hilang, dan bukan mendorong yang lain keluar. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: '4px',
          flex: 1,
          minHeight: 0,
          paddingBottom: '2px',
        }}
      >
        <Fader
          orientation="vertical"
          value={channel.fader}
          onChange={(v) => djActions.setChannelFader(id, v)}
          accent={accent}
          label={`channel fader ${id}`}
          title="channel fader — unity di puncak, nol mutlak di dasar"
        />
        <LevelMeter source={id} height="fill" />
      </div>
    </div>
  );
}
