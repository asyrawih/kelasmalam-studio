/**
 * REMOVE VOCAL / BASS / INSTRUMENT di Clip Detail.
 *
 * Tiga tombol besar untuk kasus yang 95% dipakai (buang habis), dan sebuah
 * disclosure untuk sisanya (buang sebagian, geser crossover). Slider tidak
 * dipajang di baris utama karena keputusan yang sebenarnya diambil user adalah
 * ya/tidak — jumlahnya baru relevan setelah ia mendengar hasilnya.
 *
 * KEJUJURAN. Ini pemisahan mid/side, bukan model ML. Dua hal yang bisa membuat
 * hasilnya mengecewakan diberi tahu DI TEMPAT tombolnya, bukan disembunyikan di
 * dokumentasi: materi mono tidak punya kanal sisi sama sekali, dan vokal yang
 * lebar/ber-reverb tidak duduk di tengah sehingga tidak ikut terbuang.
 */

import { useState } from 'react';

import { Button } from '../../ui/cyber';
import {
  STEM_BYPASS,
  STEM_MAX_BASS_HZ,
  STEM_MAX_VOICE_TOP_HZ,
  STEM_MIN_BASS_HZ,
  STEM_MIN_VOICE_TOP_HZ,
  isStemBypass,
  type StemId,
  type StudioClip,
} from '../model';
import { getBuffer } from '../preview/audio-preview';
import { studioActions } from '../store';
import { STEM_LABELS, stemOf, stemSummary } from './stem';
import { bakeClipStem } from './stem-bake';

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
};
const LABEL: React.CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.16em',
  color: 'var(--cy-text-muted)',
  width: '62px',
};

const STEM_ORDER: readonly StemId[] = ['vocal', 'bass', 'other'];

const HINTS: Record<StemId, string> = {
  vocal: 'buang isi TENGAH di pita suara — trik karaoke klasik',
  bass: 'buang isi tengah di bawah frekuensi pisah bass',
  other: 'buang kanal sisi + treble tengah — menyisakan yang di tengah',
};

/** Slider berlabel dengan pembacaan angka. Angkanya selalu terlihat: nilai yang
 *  hanya muncul saat drag tidak bisa dibandingkan dengan yang sebelumnya. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (v: number) => string;
  readonly onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)', width: '96px' }}>
        {label}
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        style={{ width: '140px', accentColor: '#ffd400' }}
      />
      <span
        style={{
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '10px',
          color: 'var(--cy-text-dim)',
          width: '58px',
          textAlign: 'right',
        }}
      >
        {format(value)}
      </span>
    </label>
  );
}

export function StemSection({
  clip,
  onNote,
}: {
  readonly clip: StudioClip;
  readonly onNote: (note: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [baking, setBaking] = useState(false);
  const stem = stemOf(clip);
  const active = !isStemBypass(clip.stem);

  // Mono dibaca dari PCM yang benar-benar dipakai playback, bukan ditebak dari
  // nama berkas. `undefined` = clip demo tanpa audio; tidak diklaim apa-apa.
  const channels = getBuffer(clip.assetId)?.numberOfChannels;
  const mono = channels === 1;

  const set = (patch: Parameters<typeof studioActions.setClipStem>[1]): void =>
    studioActions.setClipStem(clip.id, patch);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={ROW}>
        <span style={LABEL}>REMOVE</span>
        {STEM_ORDER.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={stem[id] < 1 ? 'outline' : 'ghost'}
            title={HINTS[id]}
            onClick={() => set({ [id]: stem[id] < 1 ? 1 : 0 })}
            style={{ padding: '0 10px' }}
          >
            {STEM_LABELS[id]}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={!active}
          title="kembalikan semua bagian"
          onClick={() => {
            set(STEM_BYPASS);
            onNote('stem kembali utuh');
          }}
        >
          RESET
        </Button>
        <Button
          size="sm"
          variant={open ? 'outline' : 'ghost'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ padding: '0 8px' }}
        >
          {open ? '▴' : '▾'} HALUS
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          {stemSummary(stem) ?? 'clip utuh'}
        </span>
      </div>

      {mono ? (
        <div style={{ fontSize: '10px', color: '#ffb020', paddingLeft: '70px' }}>
          clip ini MONO — tidak ada kanal sisi, jadi &quot;buang vokal&quot; ikut membuang
          instrumen di pita yang sama, dan &quot;buang instrumen&quot; hampir menyenyapkan
          semuanya.
        </div>
      ) : null}

      {open ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            paddingLeft: '70px',
          }}
        >
          {STEM_ORDER.map((id) => (
            <Slider
              key={id}
              label={`BUANG ${STEM_LABELS[id]}`}
              value={1 - stem[id]}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)} %`}
              onChange={(v) => set({ [id]: 1 - v })}
            />
          ))}
          <Slider
            label="PISAH BASS"
            value={stem.bassSplitHz}
            min={STEM_MIN_BASS_HZ}
            max={STEM_MAX_BASS_HZ}
            step={5}
            format={(v) => `${Math.round(v)} Hz`}
            onChange={(v) => set({ bassSplitHz: v })}
          />
          <Slider
            label="BATAS SUARA"
            value={stem.voiceTopHz}
            min={STEM_MIN_VOICE_TOP_HZ}
            max={STEM_MAX_VOICE_TOP_HZ}
            step={100}
            format={(v) => `${(v / 1000).toFixed(1)} kHz`}
            onChange={(v) => set({ voiceTopHz: v })}
          />
          <div style={{ ...ROW, gap: '10px', marginTop: '2px' }}>
            <Button
              size="sm"
              variant="outline"
              disabled={!active || baking}
              title={
                active
                  ? 'render hasilnya jadi materi baru — waveform ikut berubah, dan prosesnya berhenti berjalan tiap play'
                  : 'tidak ada yang dibuang'
              }
              onClick={() => {
                setBaking(true);
                void bakeClipStem(clip.id)
                  .then((r) => {
                    onNote(
                      r.ok
                        ? (r.reason ?? 'stem dibekukan jadi materi baru')
                        : `bake gagal: ${r.reason ?? 'tidak diketahui'}`,
                    );
                  })
                  .finally(() => setBaking(false));
              }}
            >
              {baking ? 'BAKING…' : 'BAKE'}
            </Button>
            <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>
              pemisahan mid/side — bukan model AI. vokal ber-reverb lebar tidak duduk di
              tengah dan tidak ikut terbuang.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
