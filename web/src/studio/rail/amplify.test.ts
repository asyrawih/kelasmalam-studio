/**
 * Matematika panel Amplify: dB ↔ travel ↔ linear, detent 0 dB, dan penjepitan
 * di kedua ujung.
 *
 * Semuanya fungsi murni, dan itu disengaja: satu-satunya cara "no change"
 * benar-benar berarti tanpa perubahan adalah kalau 0 dB bertahan lewat setiap
 * konversi bolak-balik yang dilakukan slider.
 */
import { describe, expect, it } from 'vitest';

import {
  MASTER_DETENT_DB,
  UNITY_FRACTION,
  clampMasterDb,
  fractionToMasterDb,
  linToDbfs,
  masterDbToFraction,
} from './AmplifyCard';
import { MAX_MASTER_GAIN_DB, MIN_MASTER_GAIN_DB } from '../model';
import { dbToLin } from '../preview/graph-builder';

describe('Amplify — konversi', () => {
  it('dB → linear memakai 10^(dB/20), sama dengan engine', () => {
    expect(dbToLin(0)).toBe(1);
    expect(dbToLin(-6.0206)).toBeCloseTo(0.5, 4);
    expect(dbToLin(6.0206)).toBeCloseTo(2, 4);
    expect(dbToLin(MAX_MASTER_GAIN_DB)).toBeCloseTo(3.98107, 4);
    expect(dbToLin(MIN_MASTER_GAIN_DB)).toBeCloseTo(0.0631, 4);
    // Ujung bawah panel masih jauh di atas ambang "senyap" engine (−96 dB),
    // jadi −24 dB tidak boleh dipetakan ke 0.
    expect(dbToLin(MIN_MASTER_GAIN_DB)).toBeGreaterThan(0);
  });

  it('linear → dBFS untuk meter; 0 jadi -inf, bukan NaN', () => {
    expect(linToDbfs(1)).toBeCloseTo(0, 6);
    expect(linToDbfs(0.5)).toBeCloseTo(-6.0206, 4);
    expect(linToDbfs(2)).toBeCloseTo(6.0206, 4);
    expect(linToDbfs(0)).toBe(-Infinity);
  });

  it('0 dB duduk di posisi yang benar dan bolak-balik tanpa bergeser', () => {
    // Rentang −24…+12 → unity di 2/3 travel. Kalau angka ini bergeser, tanda
    // detent di trek menunjuk ke tempat yang salah.
    expect(UNITY_FRACTION).toBeCloseTo(24 / 36, 6);
    expect(masterDbToFraction(0)).toBe(UNITY_FRACTION);
    expect(fractionToMasterDb(UNITY_FRACTION)).toBe(0);
  });

  it('travel 0 dan 1 mendarat tepat di kedua ujung', () => {
    expect(fractionToMasterDb(0)).toBe(MIN_MASTER_GAIN_DB);
    expect(fractionToMasterDb(1)).toBe(MAX_MASTER_GAIN_DB);
    expect(masterDbToFraction(MIN_MASTER_GAIN_DB)).toBe(0);
    expect(masterDbToFraction(MAX_MASTER_GAIN_DB)).toBe(1);
  });

  it('menjepit di kedua ujung, bukan keluar dari trek', () => {
    expect(clampMasterDb(-1000)).toBe(MIN_MASTER_GAIN_DB);
    expect(clampMasterDb(1000)).toBe(MAX_MASTER_GAIN_DB);
    expect(clampMasterDb(Number.NaN)).toBe(0); // ketikan tak terbaca → netral
    expect(clampMasterDb(Number.NEGATIVE_INFINITY)).toBe(MIN_MASTER_GAIN_DB);
    expect(clampMasterDb(Number.POSITIVE_INFINITY)).toBe(MAX_MASTER_GAIN_DB);
    // Drag yang meleset ke luar elemen tidak boleh menghasilkan travel < 0/> 1.
    expect(fractionToMasterDb(-3)).toBe(MIN_MASTER_GAIN_DB);
    expect(fractionToMasterDb(9)).toBe(MAX_MASTER_GAIN_DB);
    expect(masterDbToFraction(-1000)).toBe(0);
    expect(masterDbToFraction(1000)).toBe(1);
  });

  it('detent menarik ke 0 hanya di sekitar unity', () => {
    const at = (db: number): number => masterDbToFraction(db);
    // Di dalam detent → tepat 0.
    expect(fractionToMasterDb(at(MASTER_DETENT_DB / 2))).toBe(0);
    expect(fractionToMasterDb(at(-MASTER_DETENT_DB / 2))).toBe(0);
    // Di luar detent → nilai apa adanya (dibulatkan 0,1 dB).
    expect(fractionToMasterDb(at(1))).toBeCloseTo(1, 5);
    expect(fractionToMasterDb(at(-1))).toBeCloseTo(-1, 5);
    expect(fractionToMasterDb(at(-3.5))).toBeCloseTo(-3.5, 5);
  });

  it('nilai selalu dibulatkan ke 0,1 dB — angka yang dibaca = angka yang dipakai', () => {
    for (const f of [0.123, 0.5, 0.777, 0.91]) {
      const db = fractionToMasterDb(f);
      expect(db).toBe(Math.round(db * 10) / 10);
    }
  });
});
