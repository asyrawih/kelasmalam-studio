/**
 * Konversi panjang fade ke ruang SOURCE.
 *
 * Ini bagian yang dulu salah dan menyebabkan kurva fade DISEMBUNYIKAN di jendela
 * geser: posisinya dihitung sebagai fraksi clip, yang hanya benar kalau kotaknya
 * kebetulan menampilkan seluruh clip.
 */
import { describe, expect, it } from 'vitest';

import { fadeSourceLen } from './fade-draw';

const SR = 48_000;

describe('panjang fade di ruang source', () => {
  it('fade 2 detik = 2 detik materi pada kecepatan normal', () => {
    expect(fadeSourceLen(2000, SR, 1)).toBe(2 * SR);
  });

  it('lane 2× lebih cepat memakan dua kali lipat materi', () => {
    // `fadeInMs` diukur di waktu TIMELINE. Fade 2 detik timeline di lane 2×
    // melintasi 4 detik materi — melewatkan konversi ini membuat fade meleset
    // persis sebesar rasionya, dan itu hanya terdengar, tidak terlihat.
    expect(fadeSourceLen(2000, SR, 2)).toBe(4 * SR);
    expect(fadeSourceLen(2000, SR, 0.5)).toBe(1 * SR);
  });

  it('tidak pernah negatif', () => {
    expect(fadeSourceLen(-500, SR, 1)).toBe(0);
    expect(fadeSourceLen(0, SR, 1)).toBe(0);
  });
});
