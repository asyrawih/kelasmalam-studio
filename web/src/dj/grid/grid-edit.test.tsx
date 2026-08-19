/**
 * GRID EDIT di halaman `/dj` — panel, tarikan waveform, riwayat, dan kunci.
 *
 * Empat hal di berkas ini adalah SATU-SATUNYA penjaga klaim yang tidak bisa
 * dilihat dari kode:
 *
 *  1. **Tanda tarikan.** Menarik waveform ke kiri harus menggeser grid ke kiri
 *     dan TIDAK menggerakkan playhead. Salah tanda menghasilkan kontrol yang
 *     bergerak terbalik, dan yang disalahkan akan trackpad-nya.
 *  2. **Loop yang berputar tidak melompat saat BPM diubah.** Ini janji yang
 *     ditulis di `grid-ops.ts` dan dibaca user sebagai kalimat peringatan di
 *     layar; kalau ia tidak benar, kalimatnya jadi kebohongan.
 *  3. **Satu entri undo per gestur**, bukan per `pointermove`.
 *  4. **Kunci analisis benar-benar menolak**, di store, bukan hanya meredupkan
 *     tombol.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions, djStore } from '../store';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';
import { resolveBeatGrid, BEATS_PER_BAR } from '../../studio/analysis/beat-grid';
import { rawAnchorSec } from '../../studio/analysis/grid-edit';
import { __resetGridHistoryForTest } from './grid-history';
import { setDownbeatHere, toggleGridEditFor } from './grid-ops';

const SR = 48_000;
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

const FRAMES = SR * 8;
const pcm = {
  numberOfChannels: 1,
  length: FRAMES,
  getChannelData: () => {
    const out = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) out[i] = Math.sin(i / 40) * 0.5;
    return out;
  },
};

const TRACK_FRAMES = SR * 300;

const fakeAsset = (id: number, over: Partial<StudioAsset> = {}): StudioAsset =>
  ({
    id,
    name: `LAGU ${id}`,
    envelope: buildEnvelope(pcm),
    frames: TRACK_FRAMES,
    sampleRate: SR,
    tempo: { bpm: 128, confidence: 0.9, beatOffsetSec: 0.15 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
    ...over,
  }) as unknown as StudioAsset;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  __resetGridHistoryForTest();
  studioActions.registerAsset(fakeAsset(1));
  djActions.loadDeck('A', {
    assetId: 1,
    frames: TRACK_FRAMES,
    name: 'LAGU 1',
    sampleRate: SR,
  });
});

afterEach(cleanup);

const run = (fn: () => void): void => {
  act(() => {
    fn();
  });
};

const asset = (): StudioAsset => studioStore.getState().assets[1] as StudioAsset;
const anchor = (): number => rawAnchorSec(asset());
const bpm = (): number => resolveBeatGrid(asset())!.bpm;
const playhead = (): number => djStore.getState().decks.A.playhead;

/** Canvas waveform deck A — anak pertama baris waveform. */
function waveCanvas(): HTMLCanvasElement {
  const list = document.querySelectorAll('canvas');
  const found = list[0];
  if (found === undefined) throw new Error('canvas waveform tidak ditemukan');
  return found as HTMLCanvasElement;
}

function openGrid(): void {
  run(() => toggleGridEditFor('A'));
}

function button(re: RegExp): HTMLElement {
  const bar = document.querySelector('[data-grid-edit]');
  if (bar === null) throw new Error('panel grid tidak terbuka');
  const b = [...bar.querySelectorAll('button')].find((x) => re.test(x.textContent ?? ''));
  if (b === undefined) throw new Error(`tombol ${String(re)} tidak ada di panel`);
  return b as HTMLElement;
}

describe('membuka panel', () => {
  it('popup muncul DI DALAM deck yang disunting, bukan di deck sebelahnya', () => {
    render(<DjPage />);
    expect(document.querySelector('[data-grid-edit]')).toBeNull();

    openGrid();
    expect(document.querySelector('[data-dj-deck="A"] [data-grid-edit]')).not.toBeNull();
    expect(document.querySelector('[data-dj-deck="B"] [data-grid-edit]')).toBeNull();

    openGrid();
    expect(document.querySelector('[data-grid-edit]')).toBeNull();
  });

  it('Beat FX TIDAK ikut hilang — baris 4 bukan lagi slot rebutan', () => {
    render(<DjPage />);
    expect(screen.queryByText('BEAT FX')).not.toBeNull();
    openGrid();
    expect(screen.queryByText('BEAT FX')).not.toBeNull();
  });

  it('strip lagu-penuh tetap ada dan tetap bisa memindahkan playhead saat panel terbuka', () => {
    // Ini syarat alur kerjanya, bukan detail tata letak: di dalam mode grid,
    // menarik waveform besar menggeser GRID, jadi strip inilah satu-satunya
    // cara berpindah posisi tanpa menutup panel lebih dulu.
    render(<DjPage />);
    openGrid();

    const deckA = document.querySelector('[data-dj-deck="A"]');
    const strip = deckA?.querySelector('[title*="melompat ke posisi"]');
    expect(strip).not.toBeNull();

    const before = playhead();
    run(() => {
      fireEvent.pointerDown(strip as Element, { clientX: 700, clientY: 5, pointerId: 1, button: 0 });
    });
    expect(playhead()).not.toBe(before);
    // Dan panelnya tidak ikut tertutup.
    expect(document.querySelector('[data-grid-edit]')).not.toBeNull();
  });

  it('Esc menutup panel', () => {
    render(<DjPage />);
    openGrid();
    run(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(djStore.getState().gridEdit.deck).toBeNull();
  });

  it('Esc DI DALAM kotak BPM membatalkan ketikan, bukan menutup panel', () => {
    // Dua arti untuk satu tombol; kalau keduanya jalan, satu tekan membuang
    // ketikannya DAN panelnya.
    render(<DjPage />);
    openGrid();
    const input = screen.getByLabelText('BPM grid');
    run(() => fireEvent.keyDown(input, { key: 'Escape' }));
    expect(djStore.getState().gridEdit.deck).toBe('A');
  });

  it('memperingatkan — bukan menolak — kalau decknya sedang berbunyi', () => {
    render(<DjPage />);
    run(() => djActions.play('A'));
    openGrid();

    expect(djStore.getState().notice).toMatch(/sedang berbunyi/);
    expect(djStore.getState().gridEdit.deck).toBe('A');
  });
});

describe('menarik waveform saat mode grid', () => {
  /** Satu tarikan penuh, dari `x0` ke `x1` piksel. */
  function drag(x0: number, x1: number): void {
    const c = waveCanvas();
    run(() => {
      fireEvent.pointerDown(c, { clientX: x0, clientY: 10, pointerId: 1, button: 0 });
      fireEvent.pointerMove(c, { clientX: x1, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(c, { clientX: x1, clientY: 10, pointerId: 1 });
    });
  }

  it('menggeser GRID dan TIDAK menggerakkan playhead', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', SR * 60));
    openGrid();

    const before = anchor();
    const pos = playhead();
    drag(450, 350);

    expect(anchor()).not.toBeCloseTo(before, 6);
    expect(playhead()).toBe(pos);
  });

  it('menarik ke KIRI menggeser grid ke kiri — tandanya, dan ini satu-satunya penjaganya', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', SR * 60));
    openGrid();

    const before = anchor();
    drag(450, 350);
    expect(anchor()).toBeLessThan(before);
  });

  it('menarik ke KANAN menggeser grid ke kanan', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', SR * 60));
    openGrid();

    const before = anchor();
    drag(450, 550);
    expect(anchor()).toBeGreaterThan(before);
  });

  it('di luar mode grid, tarikan tetap mencari posisi dan grid tidak bergerak', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', SR * 60));

    const before = anchor();
    const pos = playhead();
    drag(450, 350);

    expect(anchor()).toBe(before);
    expect(playhead()).not.toBe(pos);
  });

  it('satu tarikan = SATU entri undo, bukan satu per pointermove', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', SR * 60));
    openGrid();
    const start = anchor();

    const c = waveCanvas();
    run(() => {
      fireEvent.pointerDown(c, { clientX: 450, clientY: 10, pointerId: 1, button: 0 });
      for (const x of [440, 430, 420, 410, 400]) {
        fireEvent.pointerMove(c, { clientX: x, clientY: 10, pointerId: 1 });
      }
      fireEvent.pointerUp(c, { clientX: 400, clientY: 10, pointerId: 1 });
    });

    expect(anchor()).not.toBeCloseTo(start, 6);
    run(() => fireEvent.click(button(/UNDO/)));
    expect(anchor()).toBeCloseTo(start, 9);
    // Satu UNDO sudah cukup: tombolnya kini redup lagi.
    expect((button(/UNDO/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('tombol panel', () => {
  it('SET DI SINI menaruh downbeat di posisi playhead', () => {
    render(<DjPage />);
    run(() => djActions.seek('A', Math.round(SR * 93.7)));
    openGrid();
    run(() => fireEvent.click(button(/SET DI SINI/)));

    // Yang diperiksa BUKAN nilai `offsetSec` mentahnya — grid itu periodik,
    // jadi yang berarti adalah apakah titik itu jatuh di garis bar.
    const g = resolveBeatGrid(asset())!;
    const barSec = (60 / g.bpm) * g.beatsPerBar;
    const phase = (((93.7 - g.offsetSec) % barSec) + barSec) % barSec;
    expect(Math.min(phase, barSec - phase)).toBeLessThan(1e-6);
  });

  it('×2 dan ÷2 menulis ke bpmOverride, sehingga AUTO bisa mengembalikan semuanya', () => {
    render(<DjPage />);
    openGrid();
    run(() => fireEvent.click(button(/÷2/)));

    expect(bpm()).toBeCloseTo(64, 6);
    expect(asset().bpmOverride).toBeCloseTo(64, 6);

    run(() => fireEvent.click(button(/AUTO/)));
    expect(asset().bpmOverride).toBeNull();
    expect(asset().tempoOctave).toBe(0);
    expect(bpm()).toBeCloseTo(128, 6);
  });

  it('AUTO juga membersihkan koreksi oktaf yang dibuat dari tempat lain', () => {
    render(<DjPage />);
    // Tombol ×2 di DeckReadout menulis `tempoOctave`, bukan `bpmOverride`.
    run(() => studioActions.shiftAssetTempoOctave(1, -1));
    expect(bpm()).toBeCloseTo(64, 6);

    openGrid();
    run(() => fireEvent.click(button(/AUTO/)));
    expect(bpm()).toBeCloseTo(128, 6);
  });

  it('PAS DI SINI menolak dengan kalimat kalau terlalu dekat ke anchor', () => {
    render(<DjPage />);
    const barSec = (60 / 128) * BEATS_PER_BAR;
    run(() => djActions.seek('A', Math.round(SR * (0.15 + barSec * 2))));
    openGrid();

    const before = bpm();
    run(() => fireEvent.click(button(/PAS DI SINI/)));
    expect(bpm()).toBe(before);
    expect(djStore.getState().notice).toMatch(/terlalu dekat/);
  });

  it('PAS DI SINI mengunci BPM sehingga kedua ujung lagu duduk di garis bar', () => {
    // Grid sengaja dirusak: 128.3 BPM pada lagu yang sebenarnya 128.000.
    render(<DjPage />);
    run(() => studioActions.setAssetBeatGrid(1, { bpm: 128.3, offsetSec: 0.15 }));

    const trueBar = (60 / 128) * BEATS_PER_BAR;
    const t2 = 0.15 + trueBar * 64;
    run(() => djActions.seek('A', Math.round(SR * t2)));
    openGrid();
    run(() => fireEvent.click(button(/PAS DI SINI/)));

    expect(bpm()).toBeCloseTo(128, 3);
    const g = resolveBeatGrid(asset())!;
    const barSec = (60 / g.bpm) * g.beatsPerBar;
    for (const t of [0.15, t2]) {
      const phase = (((t - g.offsetSec) % barSec) + barSec) % barSec;
      expect(Math.min(phase, barSec - phase)).toBeLessThan(1e-3);
    }
  });
});

describe('keselamatan saat mengudara', () => {
  it('mengubah BPM TIDAK memindahkan loop yang sedang berputar', () => {
    render(<DjPage />);
    run(() => {
      djActions.seek('A', SR * 30);
      djActions.setBeatLoop('A', 8, resolveBeatGrid(asset()));
      djActions.play('A');
    });

    const { inAt, outAt } = djStore.getState().decks.A.loop;
    expect(inAt).not.toBeNull();

    openGrid();
    run(() => fireEvent.click(button(/÷2/)));

    // Batas loop disimpan sebagai SAMPLE — suara tidak melompat.
    expect(djStore.getState().decks.A.loop.inAt).toBe(inAt);
    expect(djStore.getState().decks.A.loop.outAt).toBe(outAt);
  });
});

describe('kunci analisis', () => {
  it('menolak suntingan di STORE, bukan hanya meredupkan tombol', () => {
    render(<DjPage />);
    run(() => studioActions.setAnalysisLock(1, true));

    const before = anchor();
    run(() => djActions.seek('A', SR * 90));
    let ok = true;
    run(() => {
      ok = setDownbeatHere('A');
    });

    expect(ok).toBe(false);
    expect(anchor()).toBe(before);
    expect(djStore.getState().notice).toMatch(/terkunci/);
  });

  it('menolak AUTO — satu klik yang bisa membuang sepuluh menit kerja', () => {
    render(<DjPage />);
    run(() => studioActions.setAssetBeatGrid(1, { bpm: 131.5, offsetSec: 12 }));
    run(() => studioActions.setAnalysisLock(1, true));

    openGrid();
    run(() => fireEvent.click(button(/AUTO/)));
    expect(asset().bpmOverride).toBeCloseTo(131.5, 6);
  });

  it('lagu terkunci dilewati analisis batch', () => {
    studioActions.setAnalysisLock(1, true);
    studioActions.markAssetTempoPending(1);
    expect(asset().tempoPending).toBe(false);
  });

  it('membuka kunci selalu boleh', () => {
    render(<DjPage />);
    run(() => studioActions.setAnalysisLock(1, true));
    openGrid();
    run(() => fireEvent.click(button(/🔒/)));
    expect(asset().analysisLock).toBe(false);
    // Dan suntingan langsung diterima lagi.
    run(() => djActions.seek('A', SR * 90));
    let ok = false;
    run(() => {
      ok = setDownbeatHere('A');
    });
    expect(ok).toBe(true);
  });
});
