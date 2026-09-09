/**
 * Beat grid & loop cut di Clip Detail, lewat jalur nyatanya: klik di waveform →
 * region berpindah → LOOP CUT benar-benar mengubah lane.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore, useStudio, type StudioAsset } from '../store';
import { ClipEditPanel, ClipWavePanel } from './ClipPanels';
import { BeatProvider, useBeatShared } from './beat-context';
import { BeatControls } from './BeatSection';
import { buildEnvelope } from './envelope';

const SR = 48_000;
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 400,
  bottom: 150,
  width: 400,
  height: 150,
  toJSON: () => ({}),
};
Element.prototype.getBoundingClientRect = () => RECT as DOMRect;

const ASSET_ID = 4242;

/** Envelope SUNGGUHAN (bukan objek kosong): `drawClipWave` membacanya saat
 *  render, dan piramida palsu membuat tesnya gagal karena alasan yang tidak ada
 *  hubungannya dengan beat. Materinya sendiri tidak penting. */
const ENVELOPE = buildEnvelope({
  numberOfChannels: 1,
  length: 16 * SR,
  getChannelData: () => new Float32Array(16 * SR),
});

function asset(over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id: ASSET_ID,
    name: 'lagu',
    contentHash: '',
    envelope: ENVELOPE,
    frames: 16 * SR,
    sampleRate: SR,
    // 120 BPM, downbeat di 0 → satu bar = 2 detik.
    tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
    ...over,
  };
}

function lanes() {
  return studioStore.getState().lanes;
}

function clips() {
  const id = studioStore.getState().selectedLaneId;
  return lanes().find((l) => l.id === id)!.clips;
}

/**
 * Kontrol beat sekarang hidup di popup menu (BEAT & LOOP) dan waveform-nya di
 * `ClipWavePanel`; keduanya mengambil clip yang dipajang dari `BeatProvider`.
 * Harness ini merender semuanya sekaligus supaya tes tidak perlu membuka menu
 * lebih dulu — yang diuji di sini adalah kontrolnya, bukan cara membukanya.
 */
function AllBeatControls(): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const { shown, beat } = useBeatShared();
  if (shown === null) return <span />;
  return (
    <BeatControls
      beat={beat}
      clip={shown.clip}
      asset={assets[shown.clip.assetId]}
      sampleRate={sampleRate}
      onCut={() => undefined}
    />
  );
}

function Studio(): JSX.Element {
  return (
    <BeatProvider>
      <AllBeatControls />
      <ClipWavePanel />
      <ClipEditPanel />
    </BeatProvider>
  );
}

beforeEach(() => {
  studioActions.__resetForTest();
  studioActions.registerAsset(asset());
  const lane = studioStore.getState().lanes[0]!;
  const clip = lane.clips[0]!;
  // Clip 16 detik = 8 bar pada 120 BPM.
  studioActions.updateClip(clip.id, {
    assetId: ASSET_ID,
    start: 0,
    len: 16 * SR,
    sourceStart: 0,
    sourceLen: 16 * SR,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
  studioActions.selectClip(clip.id, lane.id);
});

afterEach(cleanup);

function picker(): HTMLElement {
  const el = document.querySelector('[data-loop-picker]');
  if (el === null) throw new Error('picker loop tidak ada');
  return el as HTMLElement;
}

describe('kontrol beat di topbar', () => {
  it('menampilkan BPM hasil deteksi dan menandainya sebagai grid otomatis', () => {
    render(<Studio />);
    expect((screen.getByLabelText('BPM') as HTMLInputElement).value).toBe('120');
    expect(screen.getByText('grid dari deteksi')).toBeTruthy();
  });

  it('mengetik BPM mengunci grid jadi manual dan bisa dikembalikan ke AUTO', () => {
    render(<Studio />);
    const field = screen.getByLabelText('BPM');
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.blur(field);
    expect(studioStore.getState().assets[ASSET_ID]!.bpmOverride).toBe(90);
    expect(screen.getByText('grid manual')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'AUTO' }));
    expect(studioStore.getState().assets[ASSET_ID]!.bpmOverride).toBeNull();
  });

  it('menggeser downbeat menyimpan offset di asset', () => {
    render(<Studio />);
    fireEvent.click(screen.getByTitle('geser grid ke kanan (Shift = 1 ms)'));
    expect(studioStore.getState().assets[ASSET_ID]!.beatOffsetOverride).toBeCloseTo(0.01, 6);
  });

  it('LOOP CUT memotong clip jadi region 4 bar dan mengulanginya', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '2 BAR' }));
    const repeat = screen.getByLabelText('Jumlah pengulangan');
    fireEvent.change(repeat, { target: { value: '3' } });
    fireEvent.blur(repeat);
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CUT' }));

    const after = clips();
    expect(after).toHaveLength(3);
    // 2 bar @120 BPM = 4 detik.
    for (const c of after) {
      expect(c.len).toBe(4 * SR);
      expect(c.sourceLen).toBe(4 * SR);
    }
    expect(after.map((c) => c.start)).toEqual([0, 4, 8].map((s) => s * SR));
  });

  it('LOOP CLIP memasang region ke clip TANPA memotong: jumlah clip tetap satu', () => {
    render(<Studio />);
    // 125px ≈ 5 detik → bar terdekat 6 detik; 2 bar @120 BPM = 4 detik.
    fireEvent.pointerDown(picker(), { pointerId: 1, button: 0, clientX: 125 });
    fireEvent.pointerUp(picker(), { pointerId: 1, clientX: 125 });
    fireEvent.click(screen.getByRole('button', { name: '2 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CLIP' }));

    const after = clips();
    expect(after).toHaveLength(1);
    const c = after[0]!;
    // Yang berubah HANYA cara materinya dibaca — bukan tempat dan panjangnya.
    expect(c.start).toBe(0);
    expect(c.len).toBe(16 * SR);
    expect(c.sourceStart).toBe(6 * SR);
    expect(c.loopLen).toBe(4 * SR);
  });

  it('tombolnya berbalik jadi LEPAS LOOP, dan melepaskannya membuang field loop', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '2 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CLIP' }));
    fireEvent.click(screen.getByRole('button', { name: 'LEPAS LOOP' }));
    expect(clips()).toHaveLength(1);
    expect(clips()[0]!.loopLen).toBeUndefined();
  });

  it('klik di waveform memindahkan awal loop ke BAR terdekat', () => {
    render(<Studio />);
    // 400px = 16 detik → 125px ≈ 5 detik, bar terdekat = 6 detik.
    fireEvent.pointerDown(picker(), { pointerId: 1, button: 0, clientX: 125 });
    fireEvent.pointerUp(picker(), { pointerId: 1, clientX: 125 });
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CUT' }));
    expect(clips()[0]!.sourceStart).toBe(6 * SR);
  });

  it('Shift saat klik menempel ke KETUKAN, bukan bar', () => {
    render(<Studio />);
    // 130px = 5,2 detik → ketukan terdekat 5,0 detik (bar terdekat 6,0).
    fireEvent.pointerDown(picker(), { pointerId: 1, button: 0, clientX: 130, shiftKey: true });
    fireEvent.pointerUp(picker(), { pointerId: 1, clientX: 130 });
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CUT' }));
    expect(clips()[0]!.sourceStart).toBe(5 * SR);
  });

  it('tanpa BPM, LOOP CUT dinonaktifkan dan alasannya terbaca', () => {
    studioActions.setAssetTempo(ASSET_ID, null);
    render(<Studio />);
    expect(screen.getByRole('button', { name: 'LOOP CUT' })).toHaveProperty('disabled', true);
    expect(document.querySelector('[data-loop-picker]')).toBeNull();
    expect(screen.getByText(/BPM belum terdeteksi/)).toBeTruthy();
  });

  it('LOOP PLAY mengulang region itu tanpa menyentuh transport, dan meng-zoom waveform', () => {
    const before = studioStore.getState().playhead;
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '2 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));

    const s = studioStore.getState();
    // Transport tidak ikut: lagu di lane lain harus bisa terus berjalan (atau
    // terus diam) tanpa terpengaruh audisi satu clip.
    expect(s.playing).toBe(false);
    expect(s.playhead).toBe(before);
    expect(s.clipLoop).toMatchObject({ sourceLen: 4 * SR }); // 2 bar @120 BPM
    // Waveform sekarang menampilkan region-nya, bukan seluruh clip.
    expect(screen.getByText('LOOP 2 BAR')).toBeTruthy();
    // Gagang fade TIDAK ada di jendela geser: permukaannya berjalan saat play,
    // jadi menyetel kurva di atasnya berarti sasaran yang kabur dari bawah
    // tangan. Untuk itu ada tombol FADE + editor tersendiri yang diam.
    expect(document.querySelector('[data-fade-handle="in"]')).toBeNull();
    expect(document.querySelector('[data-loop-picker]')).toBeNull();
  });

  it('STOP LOOP menghentikan bunyi tapi TIDAK melompat balik ke clip utuh', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));
    fireEvent.click(screen.getByRole('button', { name: 'STOP LOOP' }));
    expect(studioStore.getState().clipLoop).toBeNull();
    // Jendela geser tetap di posisi terakhir — pause tidak boleh mengubah
    // apa yang sedang dilihat.
    expect(document.querySelector('[data-scrolling-wave]')).not.toBeNull();
    // FULL adalah jalan kembalinya, dan di sanalah fade bisa disentuh lagi.
    fireEvent.click(screen.getByRole('button', { name: 'FULL' }));
    expect(document.querySelector('[data-scrolling-wave]')).toBeNull();
    expect(document.querySelector('[data-fade-handle="in"]')).not.toBeNull();
  });

  it('menekan PLAY memindahkan tampilan ke jendela geser', () => {
    render(<Studio />);
    expect(document.querySelector('[data-scrolling-wave]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'FULL' }));
    act(() => studioActions.togglePlay());
    expect(document.querySelector('[data-scrolling-wave]')).not.toBeNull();
  });

  it('zoom bisa dipilih sendiri, dan lebarnya mengikuti BPM', () => {
    render(<Studio />);
    fireEvent.click(screen.getByTitle('jendela 2 bar yang bergeser mengikuti playhead'));
    // 2 bar @120 BPM = 4 detik.
    expect(screen.getAllByText('jendela 4.00 s').length).toBeGreaterThan(0);
  });

  it('menggeser region saat berbunyi ikut memindahkan loop', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));
    fireEvent.click(screen.getByTitle('loop berikutnya — geser sepanjang region itu sendiri'));
    expect(studioStore.getState().clipLoop!.sourceStart).toBe(2 * SR);
  });

  it('mengubah panjang bar saat berbunyi langsung mengubah loop', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));
    expect(studioStore.getState().clipLoop!.sourceLen).toBe(2 * SR);
    fireEvent.click(screen.getByRole('button', { name: '4 BAR' }));
    expect(studioStore.getState().clipLoop!.sourceLen).toBe(8 * SR);
  });

});

describe('panjang loop pecahan', () => {
  /** Awal region yang berlaku, dibaca lewat hasil LOOP CUT. */
  function cut(): { start: number; len: number } {
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CUT' }));
    const c = clips()[0]!;
    return { start: c.sourceStart, len: c.sourceLen };
  }

  it('1/4 BAR = satu ketukan @120 BPM', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1/4 BAR' }));
    expect(cut().len).toBe(0.5 * SR);
  });

  it('1/2 BAR tidak runtuh jadi 1 bar', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1/2 BAR' }));
    expect(cut().len).toBe(1 * SR);
  });

  it('1/8 BAR = setengah ketukan', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1/8 BAR' }));
    expect(cut().len).toBe(0.25 * SR);
  });

  it('loop pecahan boleh mendarat di ketukan, bukan hanya di awal bar', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1/4 BAR' }));
    // 400 px = 16 detik. 130 px = 5,2 s → ketukan terdekat 5,0 s.
    // Kalau langkah tempelnya masih sebar penuh, ia akan mendarat di 6,0 s.
    fireEvent.pointerDown(picker(), { pointerId: 1, button: 0, clientX: 130 });
    fireEvent.pointerUp(picker(), { pointerId: 1, clientX: 130 });
    expect(cut().start).toBe(5 * SR);
  });

  it('loop 1 bar tetap menempel ke awal bar', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.pointerDown(picker(), { pointerId: 1, button: 0, clientX: 130 });
    fireEvent.pointerUp(picker(), { pointerId: 1, clientX: 130 });
    expect(cut().start).toBe(6 * SR);
  });

  it('◀ ▶ menggeser sepanjang REGION, bukan sebar penuh', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1/4 BAR' }));
    fireEvent.click(screen.getByTitle('loop berikutnya — geser sepanjang region itu sendiri'));
    // Satu ketukan, bukan satu bar.
    expect(cut().start).toBe(0.5 * SR);
  });
});

describe('menarik waveform di jendela geser', () => {
  // Posisi awal dipatok: jendela geser dipusatkan pada PLAYHEAD, jadi angka
  // yang dites bergantung padanya. State demo memulainya di tempat lain.
  beforeEach(() => studioActions.setPlayhead(0));

  /** 4 bar @120 BPM = 8 detik; kotaknya 400 px, jadi 1 px = 20 ms. */
  function zoomTo4Bar(): HTMLElement {
    fireEvent.click(screen.getByTitle('jendela 4 bar yang bergeser mengikuti playhead'));
    const el = document.querySelector('[data-scrolling-wave]');
    if (el === null) throw new Error('jendela geser tidak ada');
    return el as HTMLElement;
  }

  function drag(el: HTMLElement, dx: number, shiftKey = false): void {
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, shiftKey });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: dx, shiftKey });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: dx, shiftKey });
  }

  /** Awal region yang berlaku, dibaca lewat hasil LOOP CUT. */
  function regionStart(): number {
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP CUT' }));
    return clips()[0]!.sourceStart;
  }

  it('menarik ke KIRI memajukan posisi, dan awal loop menempel ke bar', () => {
    render(<Studio />);
    const wave = zoomTo4Bar();
    drag(wave, -100); // 100 px = 2 detik pada jendela 8 detik
    expect(regionStart()).toBe(2 * SR);
  });

  it('menarik ke KANAN memundurkan posisi — materinya yang ikut tangan', () => {
    studioActions.setPlayhead(6 * SR);
    render(<Studio />);
    const wave = zoomTo4Bar();
    drag(wave, 100); // mundur 2 detik dari 6 s
    expect(regionStart()).toBe(4 * SR);
  });

  it('Shift menempelkan awal loop ke KETUKAN, bukan bar', () => {
    render(<Studio />);
    const wave = zoomTo4Bar();
    drag(wave, -130, true); // 2,6 s → ketukan terdekat 2,5 s (bar terdekat 2 s)
    expect(regionStart()).toBe(2.5 * SR);
  });

  it('menarik waveform TIDAK menggeser playhead timeline', () => {
    studioActions.setPlayhead(6 * SR);
    render(<Studio />);
    const wave = zoomTo4Bar();
    drag(wave, -100);
    // Inti perbaikannya: Clip Detail punya posisinya sendiri. Menyetel loop di
    // satu clip tidak boleh menggeser tempat lagu di lane lain sedang berbunyi.
    expect(studioStore.getState().playhead).toBe(6 * SR);
    expect(studioStore.getState().scrubbing).toBe(false);
  });

  it('tidak bisa ditarik melewati ujung materi', () => {
    render(<Studio />);
    const wave = zoomTo4Bar();
    drag(wave, -5000); // jauh melewati clip 16 detik
    expect(studioStore.getState().playhead).toBeLessThanOrEqual(16 * SR);
  });

  it('perpindahan region baru sampai ke pemutar audisi saat jari DILEPAS', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '1 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));
    const wave = document.querySelector('[data-scrolling-wave]') as HTMLElement;
    const from = studioStore.getState().clipLoop!.sourceStart;

    fireEvent.pointerDown(wave, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerMove(wave, { pointerId: 1, clientX: -100 });
    // Masih ditahan: tiap pointermove yang membangun ulang voice audisi
    // terdengar sebagai deretan klik.
    expect(studioStore.getState().clipLoop!.sourceStart).toBe(from);

    fireEvent.pointerUp(wave, { pointerId: 1, clientX: -100 });
    expect(studioStore.getState().clipLoop!.sourceStart).not.toBe(from);
  });

  it('loop yang sedang berbunyi ikut pindah saat waveform ditarik', () => {
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: '2 BAR' }));
    fireEvent.click(screen.getByRole('button', { name: 'LOOP PLAY' }));
    const wave = document.querySelector('[data-scrolling-wave]') as HTMLElement;
    drag(wave, -100);
    expect(studioStore.getState().clipLoop!.sourceStart).toBe(2 * SR);
  });
});

describe('kontrol beat di topbar (lanjutan)', () => {
  it('SPLIT menempel ke ketukan saat SNAP menyala', () => {
    // Dipasang SEBELUM render: `setPlayhead` di luar `act` tidak menjamin
    // komponen sudah membaca nilai barunya saat tombol ditekan.
    studioActions.setPlayhead(5.2 * SR);
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'SPLIT AT PLAYHEAD' }));
    const after = clips();
    expect(after).toHaveLength(2);
    expect(after[1]!.start).toBe(5 * SR); // ketukan terdekat, bukan 5,2
  });
});


describe('editor fade', () => {
  function fadeButton(): HTMLElement {
    return screen.getByRole('button', { name: 'buka editor fade' });
  }
  function editor(): Element | null {
    return document.querySelector('[data-fade-editor]');
  }

  it('gagang fade TIDAK ada di jendela geser — permukaannya berjalan saat play', () => {
    studioActions.updateClip(clips()[0]!.id, { fadeInMs: 1000, fadeOutMs: 1000 });
    render(<Studio />);
    fireEvent.click(screen.getByTitle('jendela 4 bar yang bergeser mengikuti playhead'));
    // Menarik gagang di atas gambar yang bergeser berarti sasarannya kabur dari
    // bawah tangan; untuk itulah editor tersendiri ada.
    expect(document.querySelector('[data-fade-handle="in"]')).toBeNull();
  });

  it('gagang fade tetap ada di tampilan FULL yang diam', () => {
    studioActions.updateClip(clips()[0]!.id, { fadeInMs: 1000, fadeOutMs: 1000 });
    render(<Studio />);
    fireEvent.click(screen.getByRole('button', { name: 'FULL' }));
    expect(document.querySelector('[data-fade-handle="in"]')).not.toBeNull();
  });

  it('tombol FADE membuka dan menutup editornya', () => {
    render(<Studio />);
    expect(editor()).toBeNull();
    fireEvent.click(fadeButton());
    expect(editor()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'tutup editor fade' }));
    expect(editor()).toBeNull();
  });

  it('editornya tersedia JUGA saat jendela geser aktif', () => {
    render(<Studio />);
    fireEvent.click(screen.getByTitle('jendela 4 bar yang bergeser mengikuti playhead'));
    fireEvent.click(fadeButton());
    expect(editor()).not.toBeNull();
    // Dan di dalamnya gagangnya kembali ada — permukaan ini tidak bergerak.
    expect(editor()!.querySelector('[data-fade-handle="in"]')).not.toBeNull();
  });

  it('menyeret gagang di editor mengubah fade clip', () => {
    studioActions.updateClip(clips()[0]!.id, { fadeInMs: 0, fadeOutMs: 0 });
    render(<Studio />);
    fireEvent.click(fadeButton());
    const h = editor()!.querySelector('[data-fade-handle="in"]') as HTMLElement;
    // Kotaknya SELALU seluruh clip di sini: 400 px = 16 detik, x=100 → 4 detik.
    fireEvent.pointerDown(h, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 100 });
    expect(clips()[0]!.fadeInMs).toBe(4000);
  });

  it('bentuk kurva bisa diganti dari dalam editor', () => {
    render(<Studio />);
    fireEvent.click(fadeButton());
    const ed = editor()!;
    const linear = [...ed.querySelectorAll('button')].find((b) => b.textContent === 'LINEAR')!;
    fireEvent.click(linear);
    expect(clips()[0]!.fadeCurve).toBe('linear');
  });
});

describe('susunan bar BEAT & LOOP', () => {
  function group(label: string): HTMLElement {
    const el = document.querySelector(`[data-beat-group="${label}"]`);
    if (el === null) throw new Error(`kelompok ${label} tidak ada`);
    return el as HTMLElement;
  }

  it('kontrolnya dikelompokkan, bukan empat baris penuh-lebar', () => {
    render(<Studio />);
    for (const label of ['GRID', 'VIEW', 'LOOP', 'CUT']) group(label);
  });

  it('setiap angka duduk di dalam kelompoknya sendiri', () => {
    render(<Studio />);
    // Dulu semua pembacaan didorong ke ujung kanan bar pakai `marginLeft: auto`,
    // jadi mata harus melintasi lubang kosong ratusan piksel untuk
    // menghubungkan tombol dengan angkanya.
    expect(group('VIEW').textContent).toContain('jendela');
    expect(group('LOOP').textContent).toContain('region');
    expect(group('CUT').textContent).toContain('hasil:');
    expect(group('GRID').textContent).toContain('grid dari deteksi');
  });

  it('tombol tiap kelompok memang berada di kelompoknya', () => {
    render(<Studio />);
    expect(group('GRID').contains(screen.getByRole('button', { name: 'AUTO' }))).toBe(true);
    expect(group('VIEW').contains(screen.getByRole('button', { name: 'FULL' }))).toBe(true);
    expect(group('LOOP').contains(screen.getByRole('button', { name: 'LOOP PLAY' }))).toBe(true);
    expect(group('CUT').contains(screen.getByRole('button', { name: 'LOOP CUT' }))).toBe(true);
  });

  it('kelompok pertama tanpa pemisah, sisanya diberi jarak dari garis', () => {
    render(<Studio />);
    expect(group('GRID').style.paddingLeft).toBe('0px');
    expect(group('LOOP').style.paddingLeft).toBe('14px');
  });
});
