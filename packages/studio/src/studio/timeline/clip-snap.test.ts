/**
 * Magnet clip. Yang diuji di sini bukan "kira-kira menempel", tapi PERSIS:
 * setiap tes di bawah menuntut kesamaan sample, karena selisih beberapa sample
 * tidak terlihat di layar dan justru itu yang dulu lolos.
 */

import { describe, expect, it } from 'vitest';

import type { StudioClip, StudioLane } from '../model';
import { snapClipMove, snapTrimEdge, SNAP_THRESHOLD_PX } from './clip-snap';

const clip = (id: string, start: number, len: number): StudioClip =>
  ({ id, start, len }) as StudioClip;
const laneOf = (id: string, clips: readonly StudioClip[]): StudioLane =>
  ({ id, clips }) as StudioLane;
const lane = laneOf('lane-1', [clip('moving', 0, 100), clip('fixed', 200, 100)]);

/** Semua tepi clip yang bergerak, setelah `delta` diterapkan. */
function edgesAfter(
  clips: readonly StudioClip[],
  ids: readonly string[],
  delta: number,
): number[] {
  return clips
    .filter((c) => ids.includes(c.id))
    .flatMap((c) => [c.start + delta, c.start + delta + c.len]);
}

describe('magnetic clip snap', () => {
  it('edge kanan clip menempel ke edge kiri clip berikutnya', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 93, 0, 1);
    expect(SNAP_THRESHOLD_PX).toBe(10);
    expect(out.deltaSamples).toBe(100);
    expect(out.guideSample).toBe(200);
  });

  it('menahan clip di batas supaya tidak overlap', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 150, 0, 1);
    expect(out.deltaSamples).toBe(100);
    expect(out.guideSample).toBe(200);
  });

  it('di luar threshold tidak ditarik magnet', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 70, 0, 1);
    expect(out.deltaSamples).toBe(70);
    expect(out.guideSample).toBeNull();
  });

  /*
   * REGRESI UTAMA. Dua kandidat sekaligus masuk ambang: tepi KANAN clip
   * bergerak dekat ke tepi kanan `f0` (selisih 2) DAN dekat ke tepi kiri `f1`
   * (selisih 2 juga setelah koreksi pertama). Versi lama menjumlahkan keduanya
   * dan mendarat di antaranya — bercelah 5 sample dari kedua tepi, sementara
   * garis magnetnya tetap digambar di 242 seolah menempel.
   */
  it('dua kandidat magnet TIDAK dijumlahkan — hanya yang terdekat dipakai', () => {
    const l = laneOf('l', [clip('m', 23, 39), clip('f0', 119, 77), clip('f1', 242, 62)]);
    const out = snapClipMove([l], [{ id: 'm', start: 23, laneIndex: 0 }], 178, 0, 1);
    expect(out.deltaSamples).toBe(180);
    // Tepi kanan clip bergerak = tepi kiri `f1`, tanpa sisa.
    expect(23 + out.deltaSamples + 39).toBe(242);
    expect(out.guideSample).toBe(242);
  });

  it('garis magnet selalu tepi yang benar-benar ditempeli', () => {
    // `c1` cuma 7 sample; kedua tepinya masuk ambang sekaligus.
    const l = laneOf('l', [clip('m', 55, 126), clip('c1', 248, 7), clip('c2', 311, 145)]);
    const out = snapClipMove([l], [{ id: 'm', start: 55, laneIndex: 0 }], 74, 0, 1);
    expect(55 + out.deltaSamples + 126).toBe(248);
    expect(out.guideSample).toBe(248);
  });

  /*
   * `moveClips` menjepit selisih supaya tidak ada clip di waktu negatif. Magnet
   * harus memakai jepitan yang SAMA — kalau tidak, ia memulangkan selisih yang
   * dipotong store, dan clip mendarat menindih tetangganya.
   */
  it('jepitan awal timeline tidak boleh menciptakan overlap', () => {
    const l = laneOf('l', [clip('f', 0, 40), clip('m', 50, 30)]);
    const out = snapClipMove([l], [{ id: 'm', start: 50, laneIndex: 0 }], -200, 0, 1);
    expect(50 + out.deltaSamples).toBe(40);
    expect(out.guideSample).toBe(40);
  });

  it('lane tujuan dijepit seperti store, bukan diabaikan', () => {
    const l0 = laneOf('l0', [clip('m', 0, 100)]);
    const l1 = laneOf('l1', [clip('f', 90, 100)]);
    // `deltaLanes` 5 pada project 2 lane → store menaruhnya di lane terakhir.
    const out = snapClipMove([l0, l1], [{ id: 'm', start: 0, laneIndex: 0 }], 0, 5, 1);
    expect(out.deltaSamples).toBe(190);
    expect(out.guideSample).toBe(190);
  });

  it('rombongan: satu tepi menempel persis dan jarak antar clip tetap', () => {
    const clips = [
      clip('a', 0, 50),
      clip('b', 100, 50),
      clip('f1', 205, 50),
      clip('f2', 320, 50),
    ];
    const l = laneOf('l', clips);
    const origins = [
      { id: 'a', start: 0, laneIndex: 0 },
      { id: 'b', start: 100, laneIndex: 0 },
    ];
    const out = snapClipMove([l], origins, 158, 0, 1);
    const edges = edgesAfter(clips, ['a', 'b'], out.deltaSamples);
    // `a` berakhir tepat di awal `f1`, dan `b` mulai tepat di ujung `f1`.
    expect(edges).toEqual([155, 205, 255, 305]);
    expect(out.guideSample).toBe(205);
  });

  it('menempel PERSIS pada zoom apa pun', () => {
    // Clip jauh lebih panjang dari ambang terbesar yang diuji, supaya tepi yang
    // dituju memang tepi terdekat pada semua zoom (bukan tepi seberangnya).
    const LEN = 4_000_000;
    const FIXED_START = 10_000_000;
    const l = laneOf('l', [clip('m', 0, LEN), clip('f', FIXED_START, LEN)]);
    for (const samplesPerPx of [1, 7, 500, 5760]) {
      const threshold = samplesPerPx * SNAP_THRESHOLD_PX;
      // Berhenti sedikit di dalam ambang, dari kedua arah.
      for (const off of [-threshold + 1, threshold - 1]) {
        const raw = FIXED_START - LEN + off;
        const out = snapClipMove([l], [{ id: 'm', start: 0, laneIndex: 0 }], raw, 0, samplesPerPx);
        expect(out.deltaSamples + LEN).toBe(FIXED_START);
        expect(out.guideSample).toBe(FIXED_START);
      }
    }
  });

  /*
   * Saat pointer dilepas, `ClipArea` tidak memindahkan apa pun lagi — posisi
   * terakhirlah yang berlaku. Yang harus dijamin fungsi ini: memanggilnya lagi
   * dengan selisih hasil magnet mengembalikan selisih yang sama, jadi tidak ada
   * gerakan susulan sekecil apa pun kalau pointer bergerak nol piksel.
   */
  it('hasil magnet adalah titik tetap (tidak bergeser lagi)', () => {
    const l = laneOf('l', [clip('m', 23, 39), clip('f0', 119, 77), clip('f1', 242, 62)]);
    const origins = [{ id: 'm', start: 23, laneIndex: 0 }];
    const once = snapClipMove([l], origins, 178, 0, 1);
    const twice = snapClipMove([l], origins, once.deltaSamples, 0, 1);
    expect(twice.deltaSamples).toBe(once.deltaSamples);
    expect(twice.guideSample).toBe(once.guideSample);
  });

  it('dorongan anti-overlap memilih sisi yang paling dekat', () => {
    const l = laneOf('l', [clip('m', 0, 100), clip('f', 200, 100)]);
    const origins = [{ id: 'm', start: 0, laneIndex: 0 }];
    // Baru menyentuh sedikit dari kiri → ditahan di kiri.
    expect(snapClipMove([l], origins, 130, 0, 1).deltaSamples).toBe(100);
    // Nyaris melewatinya → diteruskan ke kanan `f`.
    expect(snapClipMove([l], origins, 270, 0, 1).deltaSamples).toBe(300);
  });
});

describe('magnet tepi trim', () => {
  const l = laneOf('l', [clip('a', 0, 100), clip('b', 300, 100)]);

  it('menarik tepi ke dekat tetangga menempel persis', () => {
    expect(snapTrimEdge([l], 'a', 294, 1)).toEqual({ at: 300, guideSample: 300 });
    expect(snapTrimEdge([l], 'b', 105, 1)).toEqual({ at: 100, guideSample: 100 });
  });

  it('di luar ambang tepi dibiarkan (dibulatkan saja)', () => {
    expect(snapTrimEdge([l], 'a', 280.4, 1)).toEqual({ at: 280, guideSample: null });
  });

  it('tepi clip itu sendiri bukan sasaran magnet', () => {
    const solo = laneOf('l', [clip('a', 0, 100)]);
    expect(snapTrimEdge([solo], 'a', 98, 1)).toEqual({ at: 98, guideSample: null });
  });
});
