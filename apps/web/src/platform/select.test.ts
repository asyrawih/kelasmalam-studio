/**
 * Pemilih host milik app (docs/25 §1d): memuat `./index` harus MENDAFTARKAN
 * resolver ke `@kelasmalam/platform`, dan di luar Tauri resolver itu memilih
 * host web. Sebelum P1 ini diuji di `hooks.test.tsx`; tes hook kini ada di
 * paket dan tidak boleh tahu `createWebHost`, jadi pemilihannya diuji di sini.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getPlatformHost, setPlatformHostForTests } from './index';

afterEach(() => setPlatformHostForTests(null));

describe('platform/index (pemilih)', () => {
  it('di luar Tauri memilih host web lewat resolver yang didaftarkan saat modul dimuat', () => {
    expect(getPlatformHost().kind).toBe('web');
    // Dipanggil dua kali → objek yang sama: host dibuat sekali, bukan tiap tanya.
    expect(getPlatformHost()).toBe(getPlatformHost());
  });
});
