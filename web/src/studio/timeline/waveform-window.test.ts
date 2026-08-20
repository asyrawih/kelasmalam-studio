/**
 * Virtualisasi hanya sah kalau ia tidak mengubah GAMBARNYA.
 *
 * Tes ini membandingkan geometri yang dikeluarkan penggambar saat ia menggambar
 * clip lebar penuh dengan saat ia hanya menggambar jendela di tengahnya. Kalau
 * pemetaan sample→pixel ikut menyempit bersama jendela — kesalahan yang paling
 * mudah dibuat di sini — waveform akan MEREGANG saat user menggulir, dan
 * perbandingan di bawah langsung gagal.
 */

import { describe, expect, it } from 'vitest';

import { buildEnvelope } from './envelope';
import { drawAssetWave, drawLoopedClipWave } from './waveform';
import type { StudioAsset } from '../store';

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Konteks canvas palsu yang hanya mencatat titik-titik path. */
function recorder(): { ctx: CanvasRenderingContext2D; pts: Pt[] } {
  const pts: Pt[] = [];
  let tx = 0;
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: (x: number, y: number) => pts.push({ x: x + tx, y }),
    fillRect: () => {},
    save: () => {},
    restore: () => {
      tx = 0;
    },
    // Ubin loop digeser lewat `translate`; catatannya harus ikut tergeser,
    // kalau tidak semua ubin akan tampak bertumpuk di x = 0.
    translate: (x: number) => {
      tx += x;
    },
    rect: () => {},
    clip: () => {},
    setLineDash: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pts };
}

const N = 96_000;

function testAsset(): StudioAsset {
  const data = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    data[i] = Math.sin(i * 0.003) * 0.6 + Math.sin(i * 0.21) * 0.25;
  }
  return {
    id: 1,
    name: 'uji',
    contentHash: '',
    envelope: buildEnvelope({
      numberOfChannels: 1,
      length: N,
      sampleRate: 48_000,
      getChannelData: () => data,
    }),
    frames: N,
    sampleRate: 48_000,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  };
}

const STYLE = {
  outline: '#fff',
  body: '#fff',
  outlineAlpha: 0.5,
  bodyAlpha: 0.85,
  centerLine: null,
} as const;

/** Titik di dalam `[from, to)`, digeser ke koordinat lokal jendela. Titik tepat
 *  di tepi dibuang di KEDUA sisi perbandingan: ia milik kolom tetangga yang
 *  memang tidak ikut tergambar. */
function inside(pts: readonly Pt[], from: number, to: number): Pt[] {
  return pts
    .filter((p) => p.x > from && p.x < to)
    .map((p) => ({ x: Math.round((p.x - from) * 1e6) / 1e6, y: p.y }));
}

/**
 * Bandingkan dua rangkaian titik. Tuntutannya kesamaan PERSIS, bukan toleransi.
 *
 * Ini sengaja seketat itu. Versi pertama perubahan ini lulus dengan toleransi
 * setengah piksel dan menyembunyikan cacat yang nyata: ubin loop yang terpotong
 * tepi jendela membuat `readEnvelope` menerima rentang yang secara matematis
 * sama tapi tiba satu ulp di bawah batas bucket, dan `floor` memundurkannya
 * satu bucket penuh — 64 sample milik kolom sebelumnya ikut terhitung, terukur
 * sampai 2 px beda tinggi. Setelah guard `EPS` di `envelope.ts`, kedua jalur
 * menghasilkan angka yang identik, dan menerima toleransi lagi berarti
 * membiarkan cacat yang sama kembali tanpa ketahuan.
 */
function expectSameShape(actual: readonly Pt[], expected: readonly Pt[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    expect(actual[i]!.x).toBe(expected[i]!.x);
    expect(actual[i]!.y).toBe(expected[i]!.y);
  }
}

describe('waveform berjendela', () => {
  const asset = testAsset();
  const WIDTH = 4000;
  const HEIGHT = 60;
  const WIN = { x: 1024, w: 512 };

  it('menggambar bentuk yang sama persis dengan versi lebar penuh', () => {
    const full = recorder();
    drawAssetWave(full.ctx, asset, 0, N, WIDTH, HEIGHT, 1, STYLE);

    const win = recorder();
    drawAssetWave(win.ctx, asset, 0, N, WIDTH, HEIGHT, 1, STYLE, WIN);

    expect(win.pts.length).toBeGreaterThan(0);
    expectSameShape(inside(win.pts, 0, WIN.w), inside(full.pts, WIN.x, WIN.x + WIN.w));
  });

  it('mengeluarkan jauh lebih sedikit titik daripada versi lebar penuh', () => {
    // Inilah seluruh alasan perubahan ini ada. Kalau angka ini tidak turun,
    // jendelanya tidak benar-benar memotong pekerjaan.
    const full = recorder();
    drawAssetWave(full.ctx, asset, 0, N, WIDTH, HEIGHT, 1, STYLE);
    const win = recorder();
    drawAssetWave(win.ctx, asset, 0, N, WIDTH, HEIGHT, 1, STYLE, WIN);

    expect(win.pts.length).toBeLessThan(full.pts.length / 5);
  });

  it('clip yang LOOP juga sama, dan hanya ubin yang tersentuh yang digambar', () => {
    const loopLen = Math.floor(N / 8);
    const full = recorder();
    drawLoopedClipWave(full.ctx, asset, 0, N, loopLen, WIDTH, HEIGHT, 1, STYLE);

    const win = recorder();
    drawLoopedClipWave(win.ctx, asset, 0, N, loopLen, WIDTH, HEIGHT, 1, STYLE, WIN);

    expect(win.pts.length).toBeGreaterThan(0);
    expectSameShape(inside(win.pts, 0, WIN.w), inside(full.pts, WIN.x, WIN.x + WIN.w));
    expect(win.pts.length).toBeLessThan(full.pts.length / 5);
  });

  it('jendela di luar bentangan tidak menggambar apa pun', () => {
    const r = recorder();
    drawAssetWave(r.ctx, asset, 0, N, WIDTH, HEIGHT, 1, STYLE, { x: 0, w: 0 });
    expect(r.pts).toHaveLength(0);
  });
});
