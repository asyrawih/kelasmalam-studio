/**
 * Tombol REMOVE dan BAKE, lewat jalur nyatanya. Yang diuji bukan "komponen
 * render", melainkan apa yang berubah di store dan di asset setelah ditekan.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBuffer } from '../preview/audio-preview';
import { studioActions, studioStore, type StudioAsset } from '../store';
import { ClipWavePanel } from './ClipPanels';
import { BeatProvider, useBeatShared } from './beat-context';
import { StemSection } from './StemSection';
import { buildEnvelope } from './envelope';

const SR = 48_000;
const FRAMES = 4 * SR;
const ASSET_ID = 991;

Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 150, width: 400, height: 150, toJSON: () => ({}) }) as DOMRect;

/** AudioBuffer palsu yang cukup untuk `buildEnvelope` dan pembacaan kanal. */
function fakeBuffer(channels: number, frames = FRAMES): AudioBuffer {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = Math.sin(i / 50) * 0.5;
  return {
    numberOfChannels: channels,
    length: frames,
    sampleRate: SR,
    duration: frames / SR,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function asset(): StudioAsset {
  return {
    id: ASSET_ID,
    name: 'lagu',
    envelope: buildEnvelope(fakeBuffer(2)),
    frames: FRAMES,
    sampleRate: SR,
    tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  };
}

function selected() {
  const s = studioStore.getState();
  return s.lanes.flatMap((l) => l.clips).find((c) => c.id === s.selectedClipId)!;
}

function setup(channels = 2): void {
  studioActions.__resetForTest();
  studioActions.registerAsset(asset());
  registerBuffer(ASSET_ID, fakeBuffer(channels));
  const lane = studioStore.getState().lanes[0]!;
  const clip = lane.clips[0]!;
  studioActions.updateClip(clip.id, {
    assetId: ASSET_ID,
    start: 0,
    len: FRAMES,
    sourceStart: 0,
    sourceLen: FRAMES,
  });
  studioActions.selectClip(clip.id, lane.id);
}

/**
 * `StemSection` sekarang berdiri sendiri di dalam popup menu STEM; clip yang
 * dipajang datang dari `BeatProvider`. `ClipWavePanel` ikut dirender karena
 * BAKE mengganti asset clip dan waveform-nya harus ikut berubah.
 */
function StemHost(): JSX.Element {
  const { shown } = useBeatShared();
  const [note, setNote] = useState<string | null>(null);
  if (shown === null) return <span />;
  return (
    <>
      {note === null ? null : <span>{note}</span>}
      <StemSection clip={shown.clip} onNote={setNote} />
    </>
  );
}

function Studio(): JSX.Element {
  return (
    <BeatProvider>
      <ClipWavePanel />
      <StemHost />
    </BeatProvider>
  );
}

beforeEach(() => setup());
afterEach(cleanup);

describe('tombol REMOVE', () => {
  it('REMOVE VOCAL membuang bagian tengah dan bisa dimatikan lagi', () => {
    render(<Studio />);
    const btn = screen.getByRole('button', { name: 'VOCAL' });
    fireEvent.click(btn);
    expect(selected().stem?.vocal).toBe(0);
    fireEvent.click(btn);
    // Kembali utuh = field-nya HILANG, bukan tersimpan sebagai semua-1.
    expect(selected().stem).toBeUndefined();
  });

  it('tiga bagian bisa dibuang sendiri-sendiri', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'BASS' }));
    fireEvent.click(screen.getByRole('button', { name: 'INSTRUMENT' }));
    expect(selected().stem).toMatchObject({ vocal: 1, bass: 0, other: 0 });
  });

  it('RESET mengembalikan semuanya', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'VOCAL' }));
    fireEvent.click(screen.getByRole('button', { name: 'RESET' }));
    expect(selected().stem).toBeUndefined();
  });

  it('ringkasan menyebutkan apa yang dibuang', () => {
    render(<Studio />);
    expect(screen.getByText('clip utuh')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'VOCAL' }));
    expect(screen.getByText('−VOCAL')).toBeTruthy();
  });

  it('slider halus bisa membuang sebagian', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: /HALUS/ }));
    fireEvent.change(screen.getByLabelText('BUANG VOCAL'), { target: { value: '0.6' } });
    expect(selected().stem!.vocal).toBeCloseTo(0.4, 6);
  });

  it('clip MONO diberi peringatan, bukan dibiarkan menebak', () => {
    setup(1);
    render(<Studio />);
    expect(screen.getByText(/clip ini MONO/)).toBeTruthy();
  });

  it('clip stereo tidak diberi peringatan mono', () => {
    render(<Studio />);
    expect(screen.queryByText(/clip ini MONO/)).toBeNull();
  });
});

describe('BAKE', () => {
  afterEach(() => {
    delete (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext;
  });

  it('membekukan stem jadi asset baru dan menetralkan setelannya', async () => {
    const rendered = fakeBuffer(2);
    class FakeOffline {
      destination = { name: 'dest' };
      constructor(
        readonly channels: number,
        readonly length: number,
        readonly sampleRate: number,
      ) {}
      createGain() {
        return {
          gain: { value: 1, setTargetAtTime: vi.fn() },
          channelCount: 1,
          channelCountMode: 'max',
          channelInterpretation: 'speakers',
          connect: (n: unknown) => n,
        };
      }
      createBiquadFilter() {
        return {
          type: '',
          frequency: { value: 0, setTargetAtTime: vi.fn() },
          Q: { value: 1 },
          gain: { value: 0 },
          connect: (n: unknown) => n,
        };
      }
      createChannelSplitter() {
        return { connect: (n: unknown) => n };
      }
      createChannelMerger() {
        return { connect: (n: unknown) => n };
      }
      createBufferSource() {
        return { buffer: null as unknown, connect: (n: unknown) => n, start: vi.fn() };
      }
      startRendering() {
        return Promise.resolve(rendered);
      }
    }
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = FakeOffline;

    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'VOCAL' }));
    fireEvent.click(screen.getByRole('button', { name: /HALUS/ }));
    const before = selected().assetId;
    fireEvent.click(screen.getByRole('button', { name: 'BAKE' }));
    await vi.waitFor(() => expect(selected().assetId).not.toBe(before));

    const clip = selected();
    expect(clip.stem).toBeUndefined(); // tidak diterapkan dua kali
    expect(clip.sourceStart).toBe(0);
    const fresh = studioStore.getState().assets[clip.assetId]!;
    expect(fresh.name).toContain('[stem]');
    // Grid ikut pindah, bukan hilang: asset baru tidak akan dianalisis ulang.
    expect(fresh.bpmOverride).toBe(120);
  });

  it('tanpa OfflineAudioContext, BAKE gagal dengan alasan yang terbaca', async () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'VOCAL' }));
    fireEvent.click(screen.getByRole('button', { name: /HALUS/ }));
    fireEvent.click(screen.getByRole('button', { name: 'BAKE' }));
    await vi.waitFor(() => expect(screen.getByText(/bake gagal/)).toBeTruthy());
  });
});
