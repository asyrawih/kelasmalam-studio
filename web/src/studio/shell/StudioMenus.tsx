/**
 * Isi tiap menu di toolbar.
 *
 * Berkas ini SENGAJA hanya merakit — semua isinya komponen yang sudah ada dan
 * dipakai apa adanya. Memindahkan panel ke dalam menu tidak boleh berarti
 * menulis ulang kontrolnya; kalau ditulis ulang, dua salinan akan berbeda
 * perilaku dan tidak ada yang menyadarinya.
 *
 * Pengelompokannya berdasarkan APA YANG DISENTUH:
 *   BEAT · LOOP · CLIP · STEM   → satu clip
 *   MIX · EQ · MASTER · EXPORT  → keseluruhan project
 *   TRANSPORT · HELP            → alat
 */

import { useState } from 'react';

import { AmplifyCard } from '../rail/AmplifyCard';
import { CompileCard } from '../rail/CompileCard';
import { EqCurveCard } from '../rail/EqCurveCard';
import { MixerCard } from '../rail/MixerCard';
import { RenderSpeedCard } from '../rail/RenderSpeedCard';
import { ShortcutsCard } from '../rail/ShortcutsCard';
import { TransportCard } from '../rail/TransportCard';
import { useStudio } from '../store';
import { BeatControls } from '../timeline/BeatSection';
import { ClipEditPanel, ClipHeader, ClipWavePanel } from '../timeline/ClipPanels';
import { StemSection } from '../timeline/StemSection';
import { useBeatShared } from '../timeline/beat-context';
import type { MenuDef } from './MenuBar';

/** Pembungkus kecil: tiap menu clip menyebut clip MANA yang sedang diubahnya. */
function ClipScoped({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <ClipHeader />
      {children}
    </div>
  );
}

function BeatMenu({ groups }: { readonly groups: readonly ('grid' | 'view' | 'loop' | 'cut')[] }): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const { shown, beat } = useBeatShared();
  const [note, setNote] = useState<string | null>(null);

  if (shown === null) {
    return <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>belum ada clip</span>;
  }
  return (
    <ClipScoped>
      {note === null ? null : (
        <span style={{ fontSize: '10px', color: 'var(--cy-accent)' }}>{note}</span>
      )}
      <BeatControls
        beat={beat}
        clip={shown.clip}
        asset={assets[shown.clip.assetId]}
        sampleRate={sampleRate}
        onCut={setNote}
        groups={groups}
      />
    </ClipScoped>
  );
}

function LoopMenu(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Waveform ikut ke dalam menu ini, bukan menempel permanen di layar:
          menarik loop adalah pekerjaan sesaat, dan 150 px yang menetap sepanjang
          sesi adalah harga yang mahal untuk sesuatu yang dipakai sebentar. */}
      <ClipHeader />
      <ClipWavePanel />
      <BeatMenuBody />
    </div>
  );
}

/** Bagian kontrol menu LOOP, dipisah supaya `ClipHeader` tidak dobel. */
function BeatMenuBody(): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const { shown, beat } = useBeatShared();
  const [note, setNote] = useState<string | null>(null);
  if (shown === null) return <span />;
  return (
    <>
      {note === null ? null : (
        <span style={{ fontSize: '10px', color: 'var(--cy-accent)' }}>{note}</span>
      )}
      <BeatControls
        beat={beat}
        clip={shown.clip}
        asset={assets[shown.clip.assetId]}
        sampleRate={sampleRate}
        onCut={setNote}
        groups={['view', 'loop', 'cut']}
      />
    </>
  );
}

function StemMenu(): JSX.Element {
  const { shown } = useBeatShared();
  const [note, setNote] = useState<string | null>(null);
  if (shown === null) {
    return <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>belum ada clip</span>;
  }
  return (
    <ClipScoped>
      {note === null ? null : (
        <span style={{ fontSize: '10px', color: 'var(--cy-accent)' }}>{note}</span>
      )}
      <StemSection clip={shown.clip} onNote={setNote} />
    </ClipScoped>
  );
}

export const STUDIO_MENUS: readonly MenuDef[] = [
  {
    id: 'beat',
    icon: '♩',
    label: 'BEAT',
    title: 'BPM, koreksi oktaf, dan posisi downbeat',
    width: 380,
    render: () => <BeatMenu groups={['grid']} />,
  },
  {
    id: 'loop',
    icon: '⟳',
    label: 'LOOP',
    title: 'waveform, zoom, panjang loop, LOOP PLAY, dan LOOP CUT',
    width: 1080,
    render: () => <LoopMenu />,
  },
  {
    id: 'clip',
    icon: '▤',
    label: 'CLIP',
    title: 'trim, normalize, split, dan fade',
    width: 620,
    render: () => (
      <ClipScoped>
        <ClipEditPanel />
      </ClipScoped>
    ),
  },
  {
    id: 'stem',
    icon: '⧉',
    label: 'STEM',
    title: 'buang vokal, bass, atau instrumen',
    width: 620,
    render: () => <StemMenu />,
  },
  {
    id: 'mix',
    icon: '⇅',
    label: 'MIX',
    title: 'fader, mute, dan solo tiap lane',
    width: 560,
    render: () => <MixerCard />,
  },
  {
    id: 'eq',
    icon: '∿',
    label: 'EQ',
    title: 'equalizer lane terpilih',
    width: 620,
    render: () => <EqCurveCard />,
  },
  {
    id: 'master',
    icon: '⬆',
    label: 'MASTER',
    title: 'amplify master dan kecepatan render',
    width: 620,
    render: () => (
      <div style={{ display: 'grid', gap: '12px' }}>
        <AmplifyCard />
        <RenderSpeedCard />
      </div>
    ),
  },
  {
    id: 'export',
    icon: '⤓',
    label: 'EXPORT',
    title: 'compile ke berkas audio',
    width: 560,
    render: () => <CompileCard />,
  },
  {
    id: 'transport',
    icon: '▶',
    label: 'TRANSPORT',
    title: 'skip, loop, dan kecepatan pemutaran',
    width: 560,
    render: () => <TransportCard />,
  },
  {
    id: 'help',
    icon: '?',
    label: 'HELP',
    title: 'daftar shortcut',
    width: 420,
    render: () => <ShortcutsCard />,
  },
];
