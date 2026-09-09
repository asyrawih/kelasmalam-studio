/**
 * Nama berkas export: pembersihan, rantai fallback, dan field-nya di kartu
 * Compile.
 *
 * Aturannya diuji sebagai TABEL karena inilah yang menentukan apakah file
 * benar-benar bisa ditulis ke disk — satu karakter yang lolos berarti unduhan
 * gagal di Windows dengan pesan yang tidak menyebut nama berkas sama sekali.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioRail } from './index';
import {
  DEFAULT_EXPORT_NAME,
  MAX_EXPORT_NAME_LEN,
  resolveExportName,
  sanitizeFileName,
} from './export-bridge';
import { studioActions, studioStore } from './store-adapter';

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
});

describe('sanitizeFileName', () => {
  const table: readonly [label: string, input: string, expected: string][] = [
    ['nama bersih dibiarkan apa adanya', 'KELAS_MALAM', 'KELAS_MALAM'],
    ['pemisah path diganti, bukan dibiarkan', 'a/b\\c', 'a-b-c'],
    ['seluruh karakter ilegal Windows diganti', 'a:b*c?d"e<f>g|h', 'a-b-c-d-e-f-g-h'],
    ['control char dibuang total', 'mi\u0000x\u001fdown\u007f', 'mixdown'],
    ['tab/newline runtuh jadi satu spasi', 'take\t\n  two', 'take two'],
    ['spasi beruntun runtuh', 'take    two', 'take two'],
    ['titik dan spasi di ujung dipangkas', '  ..mix..  ', 'mix'],
    ['titik di tengah dipertahankan', 'mix v1.2', 'mix v1.2'],
    ['ekstensi audio tidak digandakan', 'mix.wav', 'mix'],
    ['ekstensi audio case-insensitive', 'mix.FLAC', 'mix'],
    ['ekstensi non-audio bukan urusan kita', 'mix.take3', 'mix.take3'],
    ['kosong tetap kosong (sinyal fallback)', '', ''],
    ['hanya spasi jadi kosong', '   ', ''],
    ['hanya karakter ilegal jadi kosong (fallback, bukan "---")', '///', ''],
    ['hanya titik jadi kosong', '...', ''],
    ['unicode dipertahankan', 'Café Sessions — 夜', 'Café Sessions — 夜'],
    ['nama device DOS diberi prefiks', 'CON', '_CON'],
    ['nama device DOS case-insensitive', 'com1', '_com1'],
    ['kata biasa yang mirip device tidak diganggu', 'console', 'console'],
  ];

  for (const [label, input, expected] of table) {
    it(label, () => {
      expect(sanitizeFileName(input)).toBe(expected);
    });
  }

  it('dipotong di batas panjang', () => {
    const long = 'x'.repeat(MAX_EXPORT_NAME_LEN + 40);
    expect(sanitizeFileName(long)).toHaveLength(MAX_EXPORT_NAME_LEN);
  });

  it('pemotongan tidak membelah surrogate pair', () => {
    // 🎛 adalah dua code unit; potong per code unit akan menyisakan setengahnya.
    const out = sanitizeFileName('🎛'.repeat(MAX_EXPORT_NAME_LEN + 10));
    expect(Array.from(out)).toHaveLength(MAX_EXPORT_NAME_LEN);
    // Perbandingan utuh: setengah surrogate di ujung akan lolos cek panjang.
    expect(out).toBe('🎛'.repeat(MAX_EXPORT_NAME_LEN));
  });

  it('tidak menyisakan titik/spasi setelah dipotong', () => {
    const out = sanitizeFileName(`${'x'.repeat(MAX_EXPORT_NAME_LEN - 1)}. tail`);
    expect(out.endsWith('.')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
  });
});

describe('resolveExportName', () => {
  it('field menang kalau ada isinya', () => {
    const r = resolveExportName('MIXDOWN A', 'KELAS_MALAM.STUDIO');
    expect(r).toEqual({ base: 'MIXDOWN A', source: 'field', changed: false });
  });

  it('field kosong jatuh ke nama project, tanpa pseudo-ekstensinya', () => {
    const r = resolveExportName('', 'KELAS_MALAM.STUDIO');
    expect(r.base).toBe('KELAS_MALAM');
    expect(r.source).toBe('project');
    expect(r.changed).toBe(false);
  });

  it('field DAN project kosong jatuh ke default', () => {
    const r = resolveExportName('', '');
    expect(r.base).toBe(DEFAULT_EXPORT_NAME);
    expect(r.source).toBe('default');
  });

  it('field yang habis dibersihkan jatuh ke project dan MENANDAI perubahan', () => {
    const r = resolveExportName('...', 'KELAS_MALAM.STUDIO');
    expect(r.base).toBe('KELAS_MALAM');
    expect(r.source).toBe('project');
    // User mengetik sesuatu dan tidak mendapatkannya — itu wajib dikatakan.
    expect(r.changed).toBe(true);
  });

  it('field yang dibersihkan sebagian ditandai berubah', () => {
    const r = resolveExportName('mix/down', 'X');
    expect(r.base).toBe('mix-down');
    expect(r.changed).toBe(true);
  });

  it('spasi di ujung bukan perubahan yang perlu diberitakan', () => {
    expect(resolveExportName('  mix  ', 'X')).toEqual({
      base: 'mix',
      source: 'field',
      changed: false,
    });
  });

  it('field kosong tidak pernah ditandai berubah', () => {
    expect(resolveExportName('   ', 'X').changed).toBe(false);
  });
});

describe('field nama berkas di kartu Compile', () => {
  const field = (): HTMLInputElement =>
    screen.getByLabelText('Nama berkas export (tanpa ekstensi)') as HTMLInputElement;

  const renderCompile = (): { container: HTMLElement } => {
    studioActions.setTab('compile');
    return render(<StudioRail />);
  };

  it('placeholder menampilkan nama fallback (nama project)', () => {
    renderCompile();
    expect(field().placeholder).toBe('PROJECT_BARU');
  });

  it('nama final ditampilkan lengkap dengan ekstensi format aktif', () => {
    const { container } = renderCompile();
    // Format default demo = AUTO → WAV.
    expect(container.textContent).toContain('PROJECT_BARU.wav');
  });

  it('mengganti format mengganti ekstensi yang ditampilkan', () => {
    const { container } = renderCompile();
    fireEvent.click(screen.getByText('MP3'));
    expect(container.textContent).toContain('PROJECT_BARU.mp3');
    fireEvent.click(screen.getByText('FLAC'));
    expect(container.textContent).toContain('PROJECT_BARU.flac');
  });

  it('nilai diterapkan saat blur, bukan tiap ketikan', () => {
    renderCompile();
    fireEvent.change(field(), { target: { value: 'TAKE 7' } });
    expect(studioStore.getState().exportFileName).toBe('');
    fireEvent.blur(field());
    expect(studioStore.getState().exportFileName).toBe('TAKE 7');
  });

  it('Enter juga menerapkan nilai', () => {
    renderCompile();
    fireEvent.change(field(), { target: { value: 'TAKE 8' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.blur(field());
    expect(studioStore.getState().exportFileName).toBe('TAKE 8');
  });

  it('nama yang sudah tersimpan muncul di preview, bukan nama project', () => {
    studioActions.setExportFileName('TAKE 9');
    const { container } = renderCompile();
    expect(field().value).toBe('TAKE 9');
    expect(container.textContent).toContain('TAKE 9.wav');
  });

  it('memberi tahu kalau nama harus dibersihkan', () => {
    studioActions.setExportFileName('mix/down');
    const { container } = renderCompile();
    expect(container.textContent).toContain('mix-down.wav');
    expect(container.textContent).toContain('disesuaikan');
  });

  it('tidak mengeluh untuk nama yang memang sudah aman', () => {
    studioActions.setExportFileName('mixdown');
    const { container } = renderCompile();
    expect(container.textContent).not.toContain('disesuaikan');
  });
});
