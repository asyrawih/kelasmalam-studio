import { describe, expect, it } from 'vitest';

import { MIN_TAPS, TAP_RESET_MS, tapTempo, trimTapRun } from './tap-tempo';

/** Deretan cap waktu yang rapi pada BPM tertentu. */
function taps(bpm: number, count: number, startMs = 1000): number[] {
  const gap = 60_000 / bpm;
  return Array.from({ length: count }, (_, i) => startMs + i * gap);
}

describe('tapTempo', () => {
  it('menolak sebelum MIN_TAPS', () => {
    expect(tapTempo(taps(128, MIN_TAPS - 1))).toBeNull();
    expect(tapTempo(taps(128, MIN_TAPS))).not.toBeNull();
  });

  it('mengukur BPM dari ketukan yang rapi', () => {
    expect(tapTempo(taps(128, 8))!.bpm).toBeCloseTo(128, 6);
  });

  it('MEDIAN: tap terakhir yang telat tidak menggeser hasilnya', () => {
    // Tap TERAKHIR yang telat adalah kasus yang benar-benar membedakan median
    // dari rata-rata: tidak ada interval penyeimbang sesudahnya, jadi rata-rata
    // ikut tertarik sementara median mengabaikannya sepenuhnya.
    const t = taps(128, 9);
    t[8] = (t[8] ?? 0) + 300;
    expect(tapTempo(t)!.bpm).toBeCloseTo(128, 3);
  });

  it('deretan diputus oleh jeda panjang — hanya deretan terakhir dipakai', () => {
    const lama = taps(90, 6, 0);
    const baru = taps(128, 6, (lama[5] ?? 0) + TAP_RESET_MS + 1);
    expect(tapTempo([...lama, ...baru])!.bpm).toBeCloseTo(128, 3);
  });

  it('deretan yang tersisa setelah pemutusan bisa terlalu pendek — null, bukan angka ngawur', () => {
    const lama = taps(128, 6, 0);
    const baru = [(lama[5] ?? 0) + TAP_RESET_MS + 1];
    expect(tapTempo([...lama, ...baru])).toBeNull();
  });

  it('mengunci oktaf ke BPM acuan: menepuk setengah tempo tetap memberi 174', () => {
    expect(tapTempo(taps(87, 8), 174)!.bpm).toBeCloseTo(174, 3);
    expect(tapTempo(taps(348, 8), 174)!.bpm).toBeCloseTo(174, 3);
  });

  it('tanpa acuan, hasilnya diserahkan apa adanya — menebak di sana hanya salah dengan percaya diri', () => {
    expect(tapTempo(taps(87, 8), null)!.bpm).toBeCloseTo(87, 3);
  });

  it('acuan tidak memaksa: 128 tetap 128 walau acuannya 130', () => {
    expect(tapTempo(taps(128, 8), 130)!.bpm).toBeCloseTo(128, 3);
  });

  it('hasilnya dibatasi ke rentang grid', () => {
    // Tap sangat cepat: 20 ms → 3000 BPM.
    const t = Array.from({ length: 8 }, (_, i) => 1000 + i * 20);
    expect(tapTempo(t)!.bpm).toBeLessThanOrEqual(300);
  });

  it('cap waktu kembar tidak membuat pembagian nol', () => {
    expect(tapTempo([1000, 1000, 1000, 1000])).toBeNull();
  });

  it('melaporkan berapa interval yang dipakai', () => {
    expect(tapTempo(taps(128, 8))!.intervals).toBe(7);
  });
});

describe('trimTapRun', () => {
  it('membuang segalanya sebelum jeda terakhir yang panjang', () => {
    expect(trimTapRun([0, 100, 200, 200 + TAP_RESET_MS + 1, 300 + TAP_RESET_MS])).toEqual([
      200 + TAP_RESET_MS + 1,
      300 + TAP_RESET_MS,
    ]);
  });

  it('deretan rapat dibiarkan utuh', () => {
    const t = taps(128, 5);
    expect(trimTapRun(t)).toEqual(t);
  });

  it('daftar kosong tetap kosong', () => {
    expect(trimTapRun([])).toEqual([]);
  });
});
