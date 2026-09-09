/**
 * Aturan judul dan penjaga tutup — dulu diuji di `app-shell/desktop.test.tsx`
 * web; sejak docs/25 P2 aturannya milik paket dan diuji tanpa app mana pun.
 */
import { describe, expect, it } from 'vitest';

import { closeGuardReason, windowTitle } from './title';

describe('windowTitle', () => {
  it('nama project — aplikasi, dengan • di depan saat kotor', () => {
    expect(windowTitle('Malam Minggu', false)).toBe('Malam Minggu — KELAS MALAM STUDIO');
    expect(windowTitle('Malam Minggu', true)).toBe('• Malam Minggu — KELAS MALAM STUDIO');
  });

  it('nama kosong tidak menghasilkan judul yang dimulai dengan tanda pisah', () => {
    expect(windowTitle('   ', false)).toBe('Tanpa nama — KELAS MALAM STUDIO');
  });
});

describe('closeGuardReason', () => {
  it('export menang atas kotor — pesannya harus menyebut berkas yang terpotong', () => {
    expect(closeGuardReason({ exportProgress: 0.4, dirty: true })).toBe('export');
    expect(closeGuardReason({ exportProgress: null, dirty: true })).toBe('dirty');
    expect(closeGuardReason({ exportProgress: null, dirty: false })).toBeNull();
  });
});
