/**
 * Kolom tengah: dua channel strip, master, dan crossfader.
 *
 * Di screenshot referensi tempat ini berisi panel VIDEO — karena tab yang aktif
 * di sana memang VIDEO. Pada layar PERFORMANCE biasa, yang duduk di antara dua
 * deck adalah MIXER, dan itu yang dibangun di sini. Blok video tidak dibangun
 * sama sekali (lihat `recordbox/00-plan.md`).
 */

import {
  CROSSFADER_CURVES,
  DECK_ACCENT,
  MAX_MASTER_DB,
  MIN_MASTER_DB,
  crossfaderGains,
  type CrossfaderCurve,
} from '../model';
import { djActions, useDj } from '../store';
import { ChannelStrip } from './ChannelStrip';
import { Crossfader } from './Crossfader';
import { CueOutputPicker } from './CueOutputPicker';
import { Knob } from './Knob';
import { LevelMeter } from './LevelMeter';
import { formatDb } from '../../studio/rail/fader';

export interface MixerSectionProps {
  readonly compact: boolean;
}

export function MixerSection({ compact }: MixerSectionProps): JSX.Element {
  const chA = useDj((s) => s.mixer.channels.A);
  const chB = useDj((s) => s.mixer.channels.B);
  // PRIMITIF, bukan objek: `crossfaderGains` mengembalikan objek baru tiap
  // panggilan dan sebagai selector akan me-render tanpa henti.
  const xf = useDj((s) => s.mixer.crossfader);
  const curve = useDj((s) => s.mixer.curve);
  const masterDb = useDj((s) => s.mixer.masterDb);
  const cueMix = useDj((s) => s.mixer.cueMix);
  const cueDb = useDj((s) => s.mixer.cueDb);

  // Dipanggil DI DALAM render, dari dua primitif di atas — inilah bentuk yang
  // aman untuk fungsi yang mengembalikan objek.
  const gains = crossfaderGains(xf, curve);
  const faderH = compact ? 82 : 108;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '6px',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--cy-surface-1)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', gap: '6px', flex: 1, minHeight: 0, justifyContent: 'center' }}>
        <ChannelStrip
          channel={chA}
          id="A"
          accent={DECK_ACCENT.A}
          faderHeight={faderH}
          compact={compact}
        />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '5px',
            paddingTop: '18px',
          }}
        >
          <Knob
            label="MASTER"
            value={masterDb}
            min={MIN_MASTER_DB}
            max={MAX_MASTER_DB}
            center={0}
            size={compact ? 34 : 40}
            format={(v) => formatDb(v, 0)}
            onChange={(v) => djActions.setMasterDb(v)}
          />
          <Knob
            label="CUE MIX"
            value={cueMix}
            min={0}
            max={1}
            center={0.5}
            size={compact ? 30 : 34}
            format={(v) => (v < 0.02 ? 'CUE' : v > 0.98 ? 'MASTER' : `${Math.round(v * 100)}%`)}
            onChange={(v) => djActions.setCueMix(v)}
            title="campuran headphone: kiri CUE, kanan MASTER"
          />
          {/*
            CUE LEVEL — volume headphone. Terpisah dari CUE MIX (yang membagi
            antara bus CUE dan master) karena keduanya memang dua kontrol
            berbeda di alat yang ditiru, dan prosedur manualnya menyuruh
            menyetel MIX di tengah LEBIH DULU lalu menaikkan LEVEL.
          */}
          <Knob
            label="CUE LVL"
            value={cueDb}
            min={MIN_MASTER_DB}
            max={MAX_MASTER_DB}
            center={-12}
            size={compact ? 30 : 34}
            format={(v) => formatDb(v, 0)}
            onChange={(v) => djActions.setCueDb(v)}
          />
          <LevelMeter source="master" height={faderH} label="MASTER" />
          <CueOutputPicker />
        </div>

        <ChannelStrip
          channel={chB}
          id="B"
          accent={DECK_ACCENT.B}
          faderHeight={faderH}
          compact={compact}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
        <Crossfader value={xf} onChange={(v) => djActions.setCrossfader(v)} gains={gains} />
        <div style={{ display: 'flex', gap: '2px' }}>
          {CROSSFADER_CURVES.map((c: CrossfaderCurve) => (
            <button
              key={c}
              type="button"
              className="cy-btn-reset"
              onClick={() => djActions.setCrossfaderCurve(c)}
              title={
                c === 'smooth'
                  ? 'equal power — a² + b² = 1, tanpa lubang volume di tengah'
                  : c === 'sharp'
                    ? 'kedua sisi PENUH sampai tengah, lalu turun linear'
                    : 'praktis biner, dengan lereng 2% supaya tidak ada klik'
              }
              style={{
                fontSize: '8px',
                letterSpacing: '.1em',
                padding: '2px 8px',
                fontFamily: 'var(--cy-font-mono)',
                color: curve === c ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                background: curve === c ? 'var(--cy-accent)' : 'var(--cy-surface-2)',
                border: '1px solid var(--cy-border)',
                cursor: 'pointer',
              }}
            >
              {c.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
