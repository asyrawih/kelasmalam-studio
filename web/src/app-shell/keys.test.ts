import { describe, expect, it } from 'vitest';

import {
  chordLabel,
  codeLabel,
  formatChord,
  isReservedChord,
  isTextEntry,
  parseChord,
} from './keys';

describe('bentuk chord', () => {
  it('urutan modifier TETAP, apa pun urutan penulisannya', () => {
    // Kalau urutannya bebas, `ctrl+shift+K` dan `shift+ctrl+K` jadi dua entri
    // berbeda untuk tombol yang sama — dan salah satunya diam-diam tidak
    // pernah cocok.
    const a = formatChord({ mod: true, alt: true, shift: true, code: 'KeyK' });
    expect(a).toBe('mod+alt+shift+KeyK');
  });

  it('bolak-balik tanpa kehilangan apa pun', () => {
    for (const chord of ['KeyQ', 'shift+Slash', 'mod+KeyK', 'mod+alt+shift+Digit1', 'Space']) {
      expect(formatChord(parseChord(chord))).toBe(chord);
    }
  });

  it('menyimpan POSISI tombol, bukan karakternya', () => {
    // `Digit1` bertahan saat layout diganti; `!` tidak.
    const p = parseChord('shift+Digit1');
    expect(p.code).toBe('Digit1');
    expect(p.shift).toBe(true);
  });
});

describe('chord milik browser', () => {
  it('ditolak supaya user tidak terkurung di dalam aplikasi', () => {
    expect(isReservedChord('mod+KeyR')).toBe(true);
    expect(isReservedChord('mod+KeyW')).toBe(true);
    expect(isReservedChord('F12')).toBe(true);
  });

  it('tombol biasa tidak ikut ditolak', () => {
    expect(isReservedChord('KeyQ')).toBe(false);
    expect(isReservedChord('mod+KeyK')).toBe(false);
  });
});

describe('label', () => {
  it('kode tombol jadi sesuatu yang bisa dibaca', () => {
    expect(codeLabel('KeyQ')).toBe('Q');
    expect(codeLabel('Digit1')).toBe('1');
    expect(codeLabel('Semicolon')).toBe(';');
    expect(codeLabel('ArrowLeft')).toBe('←');
  });

  it('modifier mengikuti platform', () => {
    expect(chordLabel('mod+KeyK', true)).toBe('⌘K');
    expect(chordLabel('mod+KeyK', false)).toBe('Ctrl+K');
    expect(chordLabel('shift+Slash', false)).toBe('Shift+/');
  });
});

describe('tempat mengetik', () => {
  it('input, textarea, select, dan contenteditable dikecualikan', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTextEntry(document.createElement(tag))).toBe(true);
    }
    const div = document.createElement('div');
    expect(isTextEntry(div)).toBe(false);
    // jsdom tidak menghitung contentEditable dari atribut, jadi disetel langsung.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTextEntry(div)).toBe(true);
  });

  it('target yang bukan elemen tidak melempar', () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});
