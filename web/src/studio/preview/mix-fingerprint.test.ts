/**
 * Sidik jari mix = daftar hal yang, kalau berubah saat lagu berbunyi,
 * MENGHARUSKAN voice dijadwalkan ulang.
 *
 * Yang dijaga di sini bukan isinya, melainkan batasnya: apa yang TIDAK boleh
 * masuk. Setiap perubahan sidik jari memotong seluruh susunan dan
 * menjadwalkannya lagi — murah di layar, tapi terdengar. Lane baru selalu lahir
 * tanpa clip, jadi sebelum saringan ini ada, menekan "TAMBAH LANE" di tengah
 * lagu memotong lagu itu demi susunan yang sama persis.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { mixFingerprint } from './usePreviewPlayback';

describe('sidik jari mix', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('lane kosong tidak mengubahnya — menambah lane tidak memotong lagu', () => {
    const before = mixFingerprint();
    studioActions.addLane();
    expect(studioStore.getState().lanes.length).toBeGreaterThan(0);
    expect(mixFingerprint()).toBe(before);
  });

  it('tapi lane kosong yang di-SOLO mengubahnya: ia membungkam lane lain', () => {
    studioActions.addLane();
    const lanes = studioStore.getState().lanes;
    const empty = lanes.find((l) => l.clips.length === 0);
    expect(empty).toBeDefined();

    const before = mixFingerprint();
    studioActions.toggleSolo(empty!.id);
    expect(mixFingerprint()).not.toBe(before);
  });

  it('memindahkan clip mengubahnya — itu memang harus terdengar', () => {
    const clip = studioStore.getState().lanes.flatMap((l) => l.clips)[0];
    expect(clip).toBeDefined();

    const before = mixFingerprint();
    studioActions.updateClip(clip!.id, { start: clip!.start + 48_000 });
    expect(mixFingerprint()).not.toBe(before);
  });
});
